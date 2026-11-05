import { Fragment, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { absolutePointer, applyA2UIMessage, CATALOG_ID, isLocalFunction, localFunction, object, resolve, writePointer, type Component, type FunctionResponse, type Json, type ObjectValue, type OutboundEvent, type Surface, type SurfaceState } from './model'
import { Diagram, SeriesChart } from './visuals'

export interface ActionMetadata { dataModels: Record<string, ObjectValue> }
export interface A2UISurfacesProps { state: SurfaceState; onAction: (event: OutboundEvent, metadata?: ActionMetadata) => void | Promise<void>; onStateChange?: Dispatch<SetStateAction<SurfaceState>> }
interface EditableModel { model: ObjectValue; instance: number; updateCount: number; origin: Surface['updates'] }
interface RemoteCall { id: string; call: ObjectValue; sent: boolean }
function display(value: Json | undefined): string { return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value) }
class PendingFunction extends Error {}

export function A2UISurfaces({ state, onAction, onStateChange }: A2UISurfacesProps) {
  const models = useRef<Record<string, EditableModel>>({})
  const delivered = useRef(new WeakSet<OutboundEvent>())
  const [transportError, setTransportError] = useState('')
  // Reconcile only incoming pointer patches, preserving unrelated user edits.
  for (const surface of Object.values(state.surfaces)) {
    let local = models.current[surface.surfaceId]
    if (!local || local.instance !== surface.instance || local.updateCount > surface.updates.length || local.origin.length && surface.updates[0] !== local.origin[0]) {
      local = { model: surface.dataModel, instance: surface.instance, updateCount: surface.updates.length, origin: surface.updates }
    } else if (local.updateCount < surface.updates.length) {
      let model = local.model
      for (const patch of surface.updates.slice(local.updateCount)) model = writePointer(model, patch.path, patch.value)
      local = { model, instance: surface.instance, updateCount: surface.updates.length, origin: surface.updates }
    }
    models.current[surface.surfaceId] = local
  }
  for (const id of Object.keys(models.current)) if (!Object.hasOwn(state.surfaces, id)) delete models.current[id]
  function dispatch(event: OutboundEvent): void {
    const dataModels = Object.fromEntries(Object.values(state.surfaces).filter(surface => surface.sendDataModel).map(surface => [surface.surfaceId, models.current[surface.surfaceId].model]))
    try {
      Promise.resolve(onAction(event, Object.keys(dataModels).length ? { dataModels } : undefined)).catch(error => setTransportError(error instanceof Error ? error.message : 'Action delivery failed'))
    } catch (error) { setTransportError(error instanceof Error ? error.message : 'Action delivery failed') }
  }
  useEffect(() => {
    for (const event of state.outbox) if (!delivered.current.has(event)) { delivered.current.add(event); dispatch(event) }
  })
  return <div className="space-y-5">
    {transportError && <p role="alert" className="text-sm text-destructive">{transportError}</p>}
    {Object.values(state.surfaces).map(surface => <SurfaceView key={`${surface.surfaceId}:${surface.instance}`} surface={surface} editable={models.current[surface.surfaceId]} responses={state.responses} dispatch={dispatch} onStateChange={onStateChange} />)}
  </div>
}

function SurfaceView({ surface, editable, responses, dispatch, onStateChange }: { surface: Surface; editable: EditableModel; responses: Record<string, FunctionResponse>; dispatch: (event: OutboundEvent) => void; onStateChange?: Dispatch<SetStateAction<SurfaceState>> }) {
  const [, rerender] = useState(0)
  const [actionResult, setActionResult] = useState('')
  const calls = useRef(new Map<string, RemoteCall>())
  const actionCalls = useRef(new Set<string>())
  const reported = useRef(new Set<string>())
  const errors = new Set<string>()
  let renderedNodes = 0
  function remote(call: ObjectValue): Json | undefined {
    const key = JSON.stringify(call)
    let pending = calls.current.get(key)
    if (!pending) { pending = { id: crypto.randomUUID(), call, sent: false }; calls.current.set(key, pending) }
    const response = responses[pending.id]
    if (response?.error) throw new Error(`${response.error.code}: ${response.error.message}`)
    if (!response) throw new PendingFunction('Waiting for agent function…')
    return response.value
  }
  useEffect(() => {
    for (const pending of calls.current.values()) if (!pending.sent) {
      pending.sent = true
      dispatch({ version: 'v1.0', callAgentFunction: { surfaceId: surface.surfaceId, functionCallId: pending.id, callFunction: pending.call } })
    }
    for (const error of errors) if (!reported.current.has(error)) {
      reported.current.add(error)
      dispatch({ version: 'v1.0', error: { surfaceId: surface.surfaceId, code: 'EXPRESSION_ERROR', message: error } })
    }
  })
  const read = (value: Json | undefined, scope: string, index?: number) => resolve(value, editable.model, scope, index, remote)
  function action(component: Component, scope: string, index?: number): void {
    try {
      const definition = component.action as ObjectValue
      if (object(definition.event)) {
        const event = definition.event
        const context = read(event.context ?? {}, scope, index)
        const userMessage = read(event.userMessage, scope, index)
        dispatch({ version: 'v1.0', action: { name: event.name, surfaceId: surface.surfaceId, sourceComponentId: component.id, timestamp: new Date().toISOString(), context: context ?? {}, ...(userMessage !== undefined ? { userMessage: display(userMessage) } : {}) } })
      } else if (object(definition.functionCall)) {
        const call = definition.functionCall
        const name = call['@call'] as string
        const args = read(call.args ?? {}, scope, index) as ObjectValue
        if (isLocalFunction(name)) setActionResult(display(localFunction(name, args, index)))
        else {
          const id = crypto.randomUUID()
          actionCalls.current.add(id)
          dispatch({ version: 'v1.0', callAgentFunction: { surfaceId: surface.surfaceId, functionCallId: id, callFunction: { '@call': name, catalogId: CATALOG_ID, args } } })
          setActionResult('Waiting for agent function…')
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Action failed'
      setActionResult(message)
      if (!(error instanceof PendingFunction)) dispatch({ version: 'v1.0', error: { surfaceId: surface.surfaceId, code: 'EXPRESSION_ERROR', message } })
    }
  }
  function node(id: string, scope = '', index?: number, ancestors: string[] = []): ReactNode {
    if (++renderedNodes > 5000) return <p role="alert">Surface exceeds 5,000 rendered nodes.</p>
    if (ancestors.includes(id) || ancestors.length >= 64) return <p role="alert">Invalid component cycle or depth.</p>
    const component = Object.hasOwn(surface.components, id) ? surface.components[id] : undefined
    if (!component) return <span role="status" className="text-sm text-muted-foreground">Waiting for component {id}…</span>
    const next = [...ancestors, id]
    try {
      const value = (key: string) => read(component[key], scope, index)
      const text = (key: string) => display(value(key))
      const bool = (key: string) => { const resolved = value(key); return object(resolved) && typeof resolved.valid === 'boolean' ? resolved.valid : resolved === true }
      const accessibility = object(component.accessibility) ? component.accessibility : {}
      const label = read(accessibility.label, scope, index)
      const description = read(accessibility.description, scope, index)
      const hidden = read(accessibility.hidden, scope, index)
      const inputId = `a2ui-${encodeURIComponent(surface.surfaceId)}-${encodeURIComponent(id)}-${encodeURIComponent(scope)}`
      const aria = { 'aria-label': label !== undefined ? display(label) : undefined, 'aria-describedby': description ? `${inputId}-description` : undefined, 'aria-live': accessibility.live as 'off' | 'polite' | 'assertive' | undefined, 'aria-hidden': object(hidden) ? hidden.valid === true : hidden === true }
      let content: ReactNode
      if (component.component === 'Column' || component.component === 'Row') {
        const children = component.children
        let rendered: ReactNode
        if (Array.isArray(children)) rendered = children.map(child => <Fragment key={child as string}>{node(child as string, scope, index, next)}</Fragment>)
        else {
          const template = children as ObjectValue
          const path = absolutePointer(template.path as string, scope)
          const items = read({ '@path': path }, scope, index)
          if (items !== undefined && !Array.isArray(items)) throw new Error('Template data must be an array')
          if (Array.isArray(items) && items.length > 1000) throw new Error('Template exceeds 1,000 items')
          rendered = Array.isArray(items) ? items.map((_, n) => <Fragment key={n}>{node(template.componentId as string, `${path === '/' ? '' : path}/${n}`, n, next)}</Fragment>) : <span role="status">Waiting for collection…</span>
        }
        content = <div {...aria} className={component.component === 'Row' ? 'flex flex-wrap items-start gap-4' : 'flex min-w-0 flex-col gap-4'}>{rendered}</div>
      } else if (component.component === 'Card') content = <Card {...aria} className="min-w-0">{component.title !== undefined && <CardHeader><CardTitle>{text('title')}</CardTitle></CardHeader>}<CardContent className="pt-5">{node(component.child as string, scope, index, next)}</CardContent></Card>
      else if (component.component === 'Text') {
        const classes = component.variant === 'heading' ? 'text-xl font-semibold tracking-tight' : component.variant === 'muted' ? 'text-sm text-muted-foreground' : component.variant === 'code' ? 'font-mono text-sm' : 'text-sm leading-relaxed'
        content = component.variant === 'heading' ? <h3 {...aria} className={classes}>{text('text')}</h3> : <p {...aria} className={`${classes} whitespace-pre-wrap break-words`}>{text('text')}</p>
      } else if (component.component === 'Button') content = <Button {...aria} disabled={bool('disabled')} onClick={() => action(component, scope, index)}>{text('label')}</Button>
      else if (['TextField', 'NumberField', 'Select'].includes(component.component)) {
        const path = absolutePointer((component.value as ObjectValue)['@path'] as string, scope)
        function change(nextValue: Json): void {
          if (onStateChange) onStateChange(previous => applyA2UIMessage(previous, { version: 'v1.0', updateDataModel: { surfaceId: surface.surfaceId, path, value: nextValue } }))
          else editable.model = writePointer(editable.model, path, nextValue)
          rerender(n => n + 1)
        }
        const current = text('value')
        content = <div className="min-w-40 space-y-2"><label htmlFor={inputId} className="text-sm font-medium">{text('label')}</label>{component.component === 'Select' ? <select {...aria} id={inputId} value={current} disabled={bool('disabled')} onChange={event => change(event.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">Select…</option>{(component.options as ObjectValue[]).map(option => <option key={option.value as string} value={option.value as string}>{option.label as string}</option>)}</select> : <Input {...aria} id={inputId} type={component.component === 'NumberField' ? 'number' : 'text'} value={current} placeholder={text('placeholder')} disabled={bool('disabled')} min={component.min as number | undefined} max={component.max as number | undefined} step={component.step as number | undefined} onChange={event => { if (component.component === 'NumberField') { if (!event.target.value) change(null); else if (Number.isFinite(event.target.valueAsNumber)) change(event.target.valueAsNumber) } else change(event.target.value) }} />}</div>
      } else if (component.component === 'Metric') content = <div {...aria} className="rounded-xl border bg-muted/30 p-4"><p className="text-xs uppercase tracking-wider text-muted-foreground">{text('label')}</p><p className="mt-2 text-3xl font-semibold tabular-nums">{text('value')}<span className="ml-1 text-sm font-normal text-muted-foreground">{text('unit')}</span></p></div>
      else if (component.component === 'Table') {
        const rows = value('rows'); const columns = component.columns as ObjectValue[]
        if (rows !== undefined && rows !== null && (!Array.isArray(rows) || rows.length > 1000 || rows.some(row => !object(row)))) throw new Error('Table requires at most 1,000 object rows')
        content = <div {...aria} className="overflow-auto rounded-lg border"><table className="w-full text-left text-sm">{component.caption !== undefined && <caption className="p-3 text-left font-medium">{text('caption')}</caption>}<thead className="bg-muted/50"><tr>{columns.map(column => <th key={column.key as string} scope="col" className="px-3 py-2 font-medium">{column.label as string}</th>)}</tr></thead><tbody>{Array.isArray(rows) && rows.length ? rows.map((row, n) => <tr key={n} className="border-t">{columns.map(column => <td key={column.key as string} className="px-3 py-2">{display((row as ObjectValue)[column.key as string])}</td>)}</tr>) : <tr><td colSpan={columns.length} className="p-3 text-muted-foreground">{rows === undefined || rows === null ? 'Waiting for table data…' : 'No rows available.'}</td></tr>}</tbody></table></div>
      } else if (component.component === 'LineChart') content = <div {...aria} className="min-w-0 w-full"><SeriesChart points={value('points')} series={component.series as { key: string; label: string }[]} title={text('title')} xLabel={text('xLabel')} yLabel={text('yLabel')} /></div>
      else if (component.component === 'Diagram') content = <div {...aria}><Diagram source={text('source')} title={text('title')} /></div>
      else throw new Error(`Unsupported component ${component.component}`)
      return <Fragment>{content}{description !== undefined && description !== null && <span id={`${inputId}-description`} className="sr-only">{display(description)}</span>}</Fragment>
    } catch (error) {
      if (error instanceof PendingFunction) return <p role="status" className="text-sm text-muted-foreground">{error.message}</p>
      const message = error instanceof Error ? error.message : 'Component evaluation failed'
      errors.add(message)
      return <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{component.component}: {message}</p>
    }
  }
  const pending = [...calls.current.values()].filter(call => !responses[call.id]).length
  return <section aria-label={`Generated interface ${surface.surfaceId}`} className="min-w-0 space-y-3">
    {node('root')}
    {pending > 0 && <p role="status" className="text-sm text-muted-foreground">Waiting for {pending} agent function{pending === 1 ? '' : 's'}…</p>}
    {actionResult && <p role="status" className="text-sm">{actionResult}</p>}
    {[...actionCalls.current].map(id => { const result = responses[id]; return result ? <p key={id} role={result.error ? 'alert' : 'status'} className={result.error ? 'text-sm text-destructive' : 'text-sm'}>{result.error ? `${result.error.code}: ${result.error.message}` : display(result.value)}</p> : null })}
  </section>
}
