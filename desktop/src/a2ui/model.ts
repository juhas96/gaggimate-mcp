import catalog from './catalog.json'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type ObjectValue = { [key: string]: Json }
export type Component = ObjectValue & { id: string; component: string }
export type FunctionResponse = { functionCallId: string; value?: Json; error?: { code: string; message: string } }
export type OutboundEvent = { version: 'v1.0'; [key: string]: Json }
export interface Surface { surfaceId: string; instance: number; catalogId?: string; sendDataModel: boolean; components: Record<string, Component>; dataModel: ObjectValue; updates: { path: string; value: Json }[] }
export interface SurfaceState { surfaces: Record<string, Surface>; outbox: OutboundEvent[]; responses: Record<string, FunctionResponse>; nextInstance: number }
export const emptySurfaceState: SurfaceState = { surfaces: {}, outbox: [], responses: {}, nextInstance: 0 }
export const CATALOG_ID = catalog.catalogId
export const rendererCapabilities = { supportedCatalogIds: [CATALOG_ID] }
const forbidden = { ['__proto__']: true, prototype: true, constructor: true }
const own = (value: object, key: string) => Object.hasOwn(value, key)
export function object(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fail(message: string): never { throw new Error(`A2UI: ${message}`) }
function string(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !value.length || value.length > 1024 || Object.hasOwn(forbidden, value)) fail(`${label} must be a nonempty safe string`) }
export function assertJson(value: unknown, depth = 0, seen = new Set<object>()): asserts value is Json {
  if (depth > 64) fail('JSON nesting exceeds 64 levels')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || !value) fail('payload must contain finite JSON values only')
  if (seen.has(value)) fail('cyclic JSON payload')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('payload must contain plain JSON objects')
  seen.add(value)
  for (const [key, child] of Object.entries(value)) { if (Object.hasOwn(forbidden, key)) fail(`unsafe key ${key}`); assertJson(child, depth + 1, seen) }
  seen.delete(value)
}
export function pointerTokens(path: string, scope = ''): string[] {
  if (typeof path !== 'string' || /~(?![01])/u.test(path)) fail('invalid JSON pointer escape')
  const absolute = path.startsWith('/') ? path : `${scope}/${path}`
  if (absolute === '/' || absolute === '') return []
  const tokens = absolute.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (tokens.some(token => Object.hasOwn(forbidden, token))) fail('unsafe JSON pointer segment')
  if (tokens.length > 64) fail('JSON pointer exceeds depth limit')
  return tokens
}
export function absolutePointer(path: string, scope = ''): string { return '/' + pointerTokens(path, scope).map(token => token.replace(/~/g, '~0').replace(/\//g, '~1')).join('/') }
export function readPointer(model: Json, path: string, scope = ''): Json | undefined {
  let value: Json | undefined = model
  for (const token of pointerTokens(path, scope)) {
    if (!object(value) && !Array.isArray(value)) return undefined
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(token)) return undefined
    value = own(value, token) ? (value as ObjectValue)[token] : undefined
  }
  return value
}
export function writePointer(model: ObjectValue, path: string, value: Json): ObjectValue {
  const tokens = pointerTokens(path)
  if (!tokens.length) { if (value === null) return {}; if (!object(value)) fail('root data model must be an object'); return value }
  if (value === null && readPointer(model, path) === undefined) return model
  function update(current: Json | undefined, index: number): Json {
    const token = tokens[index]
    const last = index === tokens.length - 1
    if (current !== undefined && !object(current) && !Array.isArray(current)) fail('pointer traverses a scalar value')
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) fail('array pointer requires a canonical numeric index')
      const n = Number(token)
      if (n > current.length || n >= 100000) fail('array pointer index out of bounds')
      if (value === null && last && n === current.length) return current
      const copy = current.slice()
      if (last && value === null) copy.splice(n, 1)
      else copy[n] = last ? value : update(copy[n], index + 1)
      return copy
    }
    const copy: ObjectValue = { ...(current as ObjectValue | undefined) }
    if (last && value === null) delete copy[token]
    else copy[token] = last ? value : update(copy[token], index + 1)
    return copy
  }
  return update(model, 0) as ObjectValue
}
type Schema = { $ref?: string; type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; const?: Json; enum?: Json[]; items?: Schema; minimum?: number; maximum?: number; exclusiveMinimum?: number; minItems?: number }
function validateDynamic(value: Json, expected: string): void {
  if (object(value) && own(value, '@path')) { exact(value, ['@path']); if (typeof value['@path'] !== 'string') fail('@path must be a string'); pointerTokens(value['@path']); return }
  if (object(value) && own(value, '@call')) { validateFunction(value); return }
  if (expected === 'DynamicValue') return
  if (expected === 'DynamicStringList') { if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) fail('expected string list'); return }
  const type = expected === 'DynamicString' ? 'string' : expected === 'DynamicNumber' ? 'number' : 'boolean'
  if (typeof value !== type) fail(`expected ${expected}`)
}
function exact(value: ObjectValue, keys: string[]): void { for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`unsupported property ${key}`) }
function validateFunction(value: ObjectValue): void {
  exact(value, ['@call', 'catalogId', 'args'])
  string(value['@call'], '@call')
  if (!/^[\p{XID_Start}_][\p{XID_Continue}]*$/u.test(value['@call']) && value['@call'] !== '@index') fail('invalid function name')
  if (value.catalogId !== undefined && value.catalogId !== CATALOG_ID) fail('unsupported function catalog')
  if (value.args !== undefined && !object(value.args)) fail('function args must be an object')
  const schema = (catalog.functions as Record<string, Schema>)[value['@call']]
  if (Object.hasOwn(catalog.functions, value['@call'])) validateSchema(value, schema)
}
function validateSchema(value: Json, schema: Schema): void {
  if (schema.$ref) {
    const type = schema.$ref.split('/').at(-1)!
    if (type.startsWith('Dynamic')) return validateDynamic(value, type)
    if (type === 'DataBinding') { if (!object(value) || !own(value, '@path')) fail('editable field value requires @path'); return validateDynamic(value, 'DynamicValue') }
    if (type === 'ComponentId') return string(value, 'component reference')
    if (type === 'ChildList') {
      if (Array.isArray(value)) { value.forEach(v => string(v, 'child')); return }
      if (!object(value)) fail('children must be IDs or a template')
      exact(value, ['componentId', 'path']); string(value.componentId, 'template componentId')
      if (typeof value.path !== 'string') fail('template path must be a string')
      pointerTokens(value.path); return
    }
    if (type === 'Action') {
      if (!object(value) || Object.keys(value).length !== 1) fail('action requires exactly event or functionCall')
      if (object(value.event)) {
        exact(value.event, ['name', 'context', 'userMessage']); string(value.event.name, 'event name')
        if (value.event.context !== undefined && !object(value.event.context)) fail('event context must be an object')
        if (value.event.userMessage !== undefined) validateDynamic(value.event.userMessage, 'DynamicString')
        return
      }
      if (object(value.functionCall)) return validateFunction(value.functionCall)
      fail('invalid action')
    }
    fail(`unsupported schema reference ${type}`)
  }
  if (schema.const !== undefined && value !== schema.const) fail('invalid discriminator')
  if (schema.enum && !schema.enum.includes(value)) fail('unsupported enum value')
  if (schema.type === 'object') {
    if (!object(value)) fail('expected object')
    for (const key of schema.required ?? []) if (!own(value, key)) fail(`missing ${key}`)
    for (const [key, entry] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchema(entry, schema.properties[key])
      else if (schema.additionalProperties === false) fail(`unsupported property ${key}`)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('expected array')
    if (value.length < (schema.minItems ?? 0)) fail('array is too short')
    if (schema.items) value.forEach(v => validateSchema(v, schema.items!))
  } else if (schema.type) {
    if (schema.type === 'integer' ? typeof value !== 'number' || !Number.isInteger(value) : typeof value !== schema.type) fail(`expected ${schema.type}`)
  }
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum))) fail('number outside allowed range')
}
function components(previous: Record<string, Component>, incoming: Json, catalogId?: string): Record<string, Component> {
  if (!Array.isArray(incoming)) fail('components must be an array')
  if (incoming.length > 512) fail('component update exceeds 512 components')
  const result = { ...previous }; const ids = new Set<string>()
  for (const item of incoming) {
    if (!object(item)) fail('component must be an object')
    string(item.id, 'component id'); string(item.component, 'component')
    if (ids.has(item.id)) fail('duplicate component ID in update'); ids.add(item.id)
    if ((item.catalogId ?? catalogId) !== CATALOG_ID) fail('component needs supported catalogId')
    const schema = (catalog.components as Record<string, Schema>)[item.component]
    if (!Object.hasOwn(catalog.components, item.component)) fail(`unsupported component ${item.component}`)
    exact(item, ['id', 'catalogId', 'accessibility', ...Object.keys(schema.properties ?? {})])
    validateSchema(item, schema)
    if (item.accessibility !== undefined) {
      if (!object(item.accessibility)) fail('accessibility must be an object')
      exact(item.accessibility, ['label', 'description', 'live', 'hidden'])
      for (const name of ['label', 'description']) if (item.accessibility[name] !== undefined) validateDynamic(item.accessibility[name], 'DynamicString')
      if (item.accessibility.hidden !== undefined) validateDynamic(item.accessibility.hidden, 'DynamicBoolean')
      if (item.accessibility.live !== undefined && !['off', 'polite', 'assertive'].includes(String(item.accessibility.live))) fail('invalid accessibility live value')
    }
    result[item.id] = item as Component
  }
  if (Object.keys(result).length > 512) fail('surface exceeds 512 components')
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  function visit(id: string): number {
    if (visiting.has(id)) fail(`component cycle at ${id}`)
    const depth = depths.get(id)
    if (depth !== undefined) return depth
    if (visiting.size >= 64) fail('component tree exceeds 64 levels')
    const component = own(result, id) ? result[id] : undefined
    if (!component) return 0
    visiting.add(id)
    const children = component.children
    const refs = Array.isArray(children) ? children : object(children) ? [children.componentId] : typeof component.child === 'string' ? [component.child] : []
    let maximum = 0
    for (const child of refs) maximum = Math.max(maximum, visit(child as string))
    visiting.delete(id)
    if (maximum >= 64) fail('component tree exceeds 64 levels')
    depths.set(id, maximum + 1)
    return maximum + 1
  }
  for (const id of Object.keys(result)) visit(id)
  return result
}
export function localFunction(name: string, args: ObjectValue, index?: number): Json {
  if (name === '@index') { if (index === undefined) fail('@index is only valid in a list template'); if (Object.keys(args).length) fail('@index accepts no arguments'); return index }
  if (!Object.hasOwn(catalog.functions, name)) fail(`unknown renderer function ${name}`)
  validateSchema({ '@call': name, args }, (catalog.functions as Record<string, Schema>)[name])
  if (name === 'required') return { valid: args.value !== null && args.value !== '' && (!Array.isArray(args.value) || args.value.length > 0) }
  if (name === 'length') { if (typeof args.value !== 'string' && !Array.isArray(args.value)) fail('length requires string or array'); return args.value.length }
  if (typeof args.value !== 'number') fail('formatNumber requires a numeric value')
  return args.value.toFixed(typeof args.digits === 'number' ? args.digits : 2)
}
export const isLocalFunction = (name: string): boolean => name === '@index' || Object.hasOwn(catalog.functions, name)
export type RemoteResolver = (call: ObjectValue) => Json | undefined
export function resolve(value: Json | undefined, model: ObjectValue, scope = '', index?: number, remote?: RemoteResolver, depth = 0): Json | undefined {
  if (depth > 64) fail('expression nesting exceeds 64 levels')
  if (Array.isArray(value)) return value.map(v => resolve(v, model, scope, index, remote, depth + 1) ?? null)
  if (!object(value)) return value
  if (own(value, '@path')) { validateDynamic(value, 'DynamicValue'); return readPointer(model, value['@path'] as string, scope) }
  if (own(value, '@call')) {
    validateFunction(value)
    const args = resolve(value.args ?? {}, model, scope, index, remote, depth + 1) as ObjectValue
    const name = value['@call'] as string
    if (isLocalFunction(name)) return localFunction(name, args, index)
    if (!remote) fail(`remote function ${name} cannot run in this context`)
    return remote({ '@call': name, catalogId: CATALOG_ID, args })
  }
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, resolve(v, model, scope, index, remote, depth + 1) ?? null]))
}
export function applyA2UIMessage(state: SurfaceState, message: unknown): SurfaceState {
  assertJson(message)
  if (!object(message) || message.version !== 'v1.0') fail('expected a v1.0 envelope')
  const keys = Object.keys(message).filter(key => key !== 'version')
  if (keys.length !== 1) fail('envelope requires exactly one operation')
  const op = keys[0]; const body = message[op]
  if (!object(body)) fail('operation must be an object')
  if (op === 'agentFunctionResponse') {
    exact(body, ['functionCallId', 'value', 'error']); string(body.functionCallId, 'functionCallId')
    if (own(body, 'value') === own(body, 'error')) fail('function response requires exactly value or error')
    if (body.error !== undefined && (!object(body.error) || typeof body.error.code !== 'string' || typeof body.error.message !== 'string')) fail('invalid function response error')
    return { ...state, responses: { ...state.responses, [body.functionCallId]: body as FunctionResponse } }
  }
  if (op === 'callRendererFunction') {
    string(body.functionCallId, 'functionCallId')
    let response: ObjectValue
    let executing = false
    try {
      exact(body, ['surfaceId', 'functionCallId', 'callFunction'])
      if (!object(body.callFunction) || body.callFunction.catalogId !== CATALOG_ID) fail('callRendererFunction requires a supported explicit catalogId')
      const surface = typeof body.surfaceId === 'string' && own(state.surfaces, body.surfaceId) ? state.surfaces[body.surfaceId] : undefined
      if (body.surfaceId !== undefined && !surface) fail('unknown function surface')
      const call = body.callFunction
      validateFunction(call)
      if (!isLocalFunction(call['@call'] as string)) fail('unknown renderer function')
      executing = true
      response = { functionCallId: body.functionCallId, value: resolve(call, surface?.dataModel ?? {}) ?? null }
    } catch (error) { response = { functionCallId: body.functionCallId, error: { code: executing ? 'EXECUTION_ERROR' : 'INVALID_FUNCTION_CALL', message: error instanceof Error ? error.message : 'Function failed' } } }
    return { ...state, outbox: [...state.outbox, { version: 'v1.0', rendererFunctionResponse: response }] }
  }
  if (!['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].includes(op)) fail(`unsupported operation ${op}`)
  string(body.surfaceId, 'surfaceId')
  const id = body.surfaceId
  const surface = own(state.surfaces, id) ? state.surfaces[id] : undefined
  if (op === 'createSurface') {
    exact(body, ['surfaceId', 'catalogId', 'sendDataModel', 'components', 'dataModel', 'metadata'])
    if (surface) fail('INTEGRITY_ERROR: surface already exists')
    if (Object.keys(state.surfaces).length >= 32) fail('surface count exceeds 32')
    if (body.catalogId !== undefined && body.catalogId !== CATALOG_ID) fail('unsupported surface catalog')
    if (body.sendDataModel !== undefined && typeof body.sendDataModel !== 'boolean') fail('sendDataModel must be boolean')
    if (body.dataModel !== undefined && !object(body.dataModel)) fail('initial dataModel must be object')
    if (body.metadata !== undefined) {
      if (!object(body.metadata)) fail('surface metadata must be an object')
      exact(body.metadata, ['extensions'])
      if (body.metadata.extensions !== undefined && !object(body.metadata.extensions)) fail('metadata extensions must be an object')
    }
    const next: Surface = { surfaceId: id, instance: state.nextInstance, ...(typeof body.catalogId === 'string' ? { catalogId: body.catalogId } : {}), sendDataModel: body.sendDataModel === true, components: components({}, body.components ?? [], body.catalogId as string | undefined), dataModel: (body.dataModel ?? {}) as ObjectValue, updates: [] }
    return { ...state, nextInstance: state.nextInstance + 1, surfaces: { ...state.surfaces, [id]: next } }
  }
  if (!surface) fail(`unknown surface ${id}`)
  if (op === 'deleteSurface') { exact(body, ['surfaceId']); const next = { ...state.surfaces }; delete next[id]; return { ...state, surfaces: next } }
  let next: Surface
  if (op === 'updateComponents') { exact(body, ['surfaceId', 'components']); next = { ...surface, components: components(surface.components, body.components, surface.catalogId) } }
  else {
    exact(body, ['surfaceId', 'path', 'value'])
    if (!own(body, 'value')) fail('updateDataModel requires value (null deletes)')
    if (body.path !== undefined && (typeof body.path !== 'string' || (body.path !== '' && !body.path.startsWith('/')))) fail('update path must be an absolute JSON pointer')
    const path = (body.path ?? '/') as string
    next = { ...surface, dataModel: writePointer(surface.dataModel, path, body.value), updates: [...surface.updates, { path, value: body.value }] }
  }
  return { ...state, surfaces: { ...state.surfaces, [id]: next } }
}

/** Restores durable UI only. RPC queues/results are session-scoped and must not replay after restart. */
export function validateSurfaceState(value: unknown): SurfaceState {
  assertJson(value)
  if (!object(value) || !object(value.surfaces)) fail('saved state requires a surfaces map')
  exact(value, ['surfaces', 'outbox', 'responses', 'nextInstance'])
  let restored = emptySurfaceState
  for (const [id, candidate] of Object.entries(value.surfaces)) {
    if (!object(candidate) || candidate.surfaceId !== id || !object(candidate.components) || !object(candidate.dataModel)) fail(`invalid saved surface ${id}`)
    exact(candidate, ['surfaceId', 'instance', 'catalogId', 'sendDataModel', 'components', 'dataModel', 'updates'])
    for (const [componentId, component] of Object.entries(candidate.components)) {
      if (!object(component) || component.id !== componentId) fail('saved component ID does not match map key')
    }
    restored = applyA2UIMessage(restored, {
      version: 'v1.0',
      createSurface: {
        surfaceId: id,
        ...(candidate.catalogId !== undefined ? { catalogId: candidate.catalogId } : {}),
        sendDataModel: candidate.sendDataModel,
        components: Object.values(candidate.components),
        dataModel: candidate.dataModel,
      },
    })
  }
  return restored
}
