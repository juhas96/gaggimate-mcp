import { describe, expect, test } from 'bun:test'
import { applyA2UIMessage, CATALOG_ID, emptySurfaceState, readPointer, resolve, validateSurfaceState, writePointer, type Json, type SurfaceState } from './model'

const create = (surfaceId = 'main', dataModel = {}, components: unknown[] = []): unknown => ({ version: 'v1.0', createSurface: { surfaceId, catalogId: CATALOG_ID, dataModel, components } })
const update = (state: SurfaceState, path: string, value: Json, surfaceId = 'main') => applyA2UIMessage(state, { version: 'v1.0', updateDataModel: { surfaceId, path, value } })

describe('A2UI v1.0 pointer data lifecycle', () => {
  test('replaces subtrees, decodes RFC6901 escapes, leaves prior state untouched', () => {
    const original = applyA2UIMessage(emptySurfaceState, create('main', { user: { name: 'Ada', old: true }, other: 7 }))
    const changed = update(original, '/user', { name: 'Grace' })
    expect(changed.surfaces.main.dataModel).toEqual({ user: { name: 'Grace' }, other: 7 })
    expect(original.surfaces.main.dataModel).toEqual({ user: { name: 'Ada', old: true }, other: 7 })
    const escaped = update(changed, '/a~1b/~0name', 3)
    expect(readPointer(escaped.surfaces.main.dataModel, '/a~1b/~0name')).toBe(3)
  })
  test('null deletes keys and array entries without holes', () => {
    let state = applyA2UIMessage(emptySurfaceState, create('main', { rows: [1, 2, 3], obsolete: true }))
    state = update(state, '/rows/1', null)
    state = update(state, '/obsolete', null)
    expect(state.surfaces.main.dataModel).toEqual({ rows: [1, 3] })
    expect(() => update(state, '/rows/50', 4)).toThrow('bounds')
    expect(() => update(state, '/rows/01', 4)).toThrow('canonical')
    expect(() => update(state, '/rows/-', 4)).toThrow('canonical')
  })
  test('root replacement supports omitted path and clears on null', () => {
    let state = applyA2UIMessage(emptySurfaceState, create('main', { old: 1 }))
    state = applyA2UIMessage(state, { version: 'v1.0', updateDataModel: { surfaceId: 'main', value: { new: 2 } } })
    expect(state.surfaces.main.dataModel).toEqual({ new: 2 })
    expect(update(state, '/', null).surfaces.main.dataModel).toEqual({})
    expect(() => update(state, '/', [1])).toThrow('root')
    expect(() => update(state, '/new/child', 2)).toThrow('scalar')
  })
  test('relative list binding uses collection scope and absolute paths escape it', () => {
    const model = { label: 'Global', rows: [{ label: 'One' }, { label: 'Two' }] }
    expect(resolve({ '@path': 'label' }, model, '/rows/1')).toBe('Two')
    expect(resolve({ '@path': '/label' }, model, '/rows/1')).toBe('Global')
    expect(resolve({ '@call': '@index' }, model, '/rows/1', 1)).toBe(1)
    expect(() => resolve({ '@call': '@index' }, model)).toThrow('list template')
    expect(readPointer(model, '/missing')).toBeUndefined()
    expect(readPointer(model, '/rows/00')).toBeUndefined()
  })
  test('rejects malformed escapes and prototype pollution at every level', () => {
    expect(() => writePointer({}, '/bad~2escape', 1)).toThrow('escape')
    expect(() => writePointer({}, '/__proto__/polluted', true)).toThrow('unsafe')
    expect(() => writePointer({}, '/constructor/prototype/x', true)).toThrow('unsafe')
    expect(() => applyA2UIMessage(emptySurfaceState, JSON.parse('{"version":"v1.0","createSurface":{"surfaceId":"main","dataModel":{"__proto__":{"polluted":true}}}}'))).toThrow('unsafe')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('surface isolation and component integrity', () => {
  test('identical component IDs and paths remain isolated between surfaces', () => {
    let state = applyA2UIMessage(emptySurfaceState, create('a', { value: 1 }, [{ id: 'root', component: 'Text', text: { '@path': '/value' } }]))
    state = applyA2UIMessage(state, create('b', { value: 2 }, [{ id: 'root', component: 'Text', text: { '@path': '/value' } }]))
    const unchanged = state.surfaces.b
    state = update(state, '/value', 3, 'a')
    expect(state.surfaces.b).toBe(unchanged)
    expect(state.surfaces.a.dataModel.value).toBe(3)
    expect(state.surfaces.b.dataModel.value).toBe(2)
    state = applyA2UIMessage(state, { version: 'v1.0', deleteSurface: { surfaceId: 'a' } })
    expect(state.surfaces.a).toBeUndefined()
    expect(state.surfaces.b).toBe(unchanged)
    expect(() => update(state, '/value', 4, 'a')).toThrow('unknown surface')
  })
  test('duplicate creates fail; delete/recreate gets a new editable incarnation', () => {
    let state = applyA2UIMessage(emptySurfaceState, create())
    const instance = state.surfaces.main.instance
    expect(() => applyA2UIMessage(state, create())).toThrow('already exists')
    state = applyA2UIMessage(state, { version: 'v1.0', deleteSurface: { surfaceId: 'main' } })
    state = applyA2UIMessage(state, create())
    expect(state.surfaces.main.instance).not.toBe(instance)
  })
  test('supports incremental missing children but rejects cycles across updates atomically', () => {
    const state = applyA2UIMessage(emptySurfaceState, create('main', {}, [{ id: 'root', component: 'Column', children: ['later'] }]))
    expect(state.surfaces.main.components.later).toBeUndefined()
    expect(() => applyA2UIMessage(state, { version: 'v1.0', updateComponents: { surfaceId: 'main', components: [{ id: 'later', component: 'Card', child: 'root' }] } })).toThrow('cycle')
    expect(state.surfaces.main.components.later).toBeUndefined()
    expect(() => applyA2UIMessage(emptySurfaceState, create('main', {}, [{ id: 'root', component: 'Column', children: { componentId: 'root', path: '/items' } }]))).toThrow('cycle')
  })
  test('validates unreachable cycles too and limits deep trees', () => {
    expect(() => applyA2UIMessage(emptySurfaceState, create('main', {}, [{ id: 'unused', component: 'Card', child: 'unused' }]))).toThrow('cycle')
    const deep = Array.from({ length: 66 }, (_, n) => ({ id: String(n), component: 'Card', child: String(n + 1) }))
    expect(() => applyA2UIMessage(emptySurfaceState, create('main', {}, deep))).toThrow('64 levels')
  })
  test('does not infer catalogs and rejects unknown components or executable properties', () => {
    expect(() => applyA2UIMessage(emptySurfaceState, { version: 'v1.0', createSurface: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'Hello' }] } })).toThrow('catalogId')
    expect(() => applyA2UIMessage(emptySurfaceState, create('main', {}, [{ id: 'root', component: 'toString' }]))).toThrow('unsupported component')
    expect(() => applyA2UIMessage(emptySurfaceState, create('main', {}, [{ id: 'root', component: 'Text', text: 'Hello', html: '<script />' }]))).toThrow('unsupported property')
    expect(() => applyA2UIMessage(emptySurfaceState, create('main', {}, [{ id: 'root', component: 'TextField', label: 'Name', value: 'not a binding' }]))).toThrow('@path')
  })
  test('rejects wrong protocol, multiple operations, malformed and cyclic JSON', () => {
    expect(() => applyA2UIMessage(emptySurfaceState, { version: 'v0.9', createSurface: { surfaceId: 'main' } })).toThrow('v1.0')
    expect(() => applyA2UIMessage(emptySurfaceState, { version: 'v1.0', createSurface: {}, deleteSurface: {} })).toThrow('exactly one')
    expect(() => applyA2UIMessage(emptySurfaceState, create('main', { value: Number.NaN }))).toThrow('finite JSON')
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => applyA2UIMessage(emptySurfaceState, cyclic)).toThrow('cyclic')
    expect(() => applyA2UIMessage(emptySurfaceState, create('main', {}, [{ id: 'root', component: 'Text', text: 42 }]))).toThrow('DynamicString')
  })
})

describe('v1.0 function envelopes and expressions', () => {
  test('evaluates catalog functions and recursively resolves action context', () => {
    const model = { weight: 36.125, names: ['A', 'B'] }
    expect(resolve({ '@call': 'formatNumber', args: { value: { '@path': '/weight' }, digits: 1 } }, model)).toBe('36.1')
    expect(resolve({ weight: { '@path': '/weight' }, count: { '@call': 'length', args: { value: { '@path': '/names' } } } }, model)).toEqual({ weight: 36.125, count: 2 })
    expect(resolve({ '@call': 'required', args: { value: { '@path': '/missing' } } }, model)).toEqual({ valid: false })
  })
  test('renderer RPC resolves against its surface after prior data updates', () => {
    let state = applyA2UIMessage(emptySurfaceState, create('main', { value: 1 }))
    state = update(state, '/value', 2.5)
    state = applyA2UIMessage(state, { version: 'v1.0', callRendererFunction: { surfaceId: 'main', functionCallId: 'f1', callFunction: { '@call': 'formatNumber', catalogId: CATALOG_ID, args: { value: { '@path': '/value' }, digits: 1 } } } })
    expect(state.outbox.at(-1)).toEqual({ version: 'v1.0', rendererFunctionResponse: { functionCallId: 'f1', value: '2.5' } })
  })
  test('surface-independent RPC never reads another surface model', () => {
    let state = applyA2UIMessage(emptySurfaceState, create('main', { secret: 'private' }))
    state = applyA2UIMessage(state, { version: 'v1.0', callRendererFunction: { functionCallId: 'empty', callFunction: { '@call': 'required', catalogId: CATALOG_ID, args: { value: { '@path': '/secret' } } } } })
    expect(state.outbox.at(-1)).toEqual({ version: 'v1.0', rendererFunctionResponse: { functionCallId: 'empty', value: { valid: false } } })
  })
  test('invalid renderer calls get correlated error responses, never silent drops', () => {
    for (const callFunction of [{ '@call': 'formatNumber', args: { value: 1 } }, { '@call': 'openUrl', catalogId: CATALOG_ID, args: { url: 'https://example.test' } }, { '@call': 'formatNumber', catalogId: CATALOG_ID, args: { value: 1, digits: 99 } }]) {
      const state = applyA2UIMessage(emptySurfaceState, { version: 'v1.0', callRendererFunction: { functionCallId: 'bad', callFunction } })
      expect(state.outbox[0]).toMatchObject({ rendererFunctionResponse: { functionCallId: 'bad', error: { code: 'INVALID_FUNCTION_CALL' } } })
    }
  })
  test('unknown functions resolve through agent RPC callback; response errors are retained', () => {
    const calls: Json[] = []
    expect(resolve({ '@call': 'lookupBean', args: { bean: { '@path': '/bean' } } }, { bean: 'real-id' }, '', undefined, call => { calls.push(call); return { name: 'Existing bean' } })).toEqual({ name: 'Existing bean' })
    expect(calls).toEqual([{ '@call': 'lookupBean', catalogId: CATALOG_ID, args: { bean: 'real-id' } }])
    const state = applyA2UIMessage(emptySurfaceState, { version: 'v1.0', agentFunctionResponse: { functionCallId: 'remote', error: { code: 'UNKNOWN_FUNCTION', message: 'Not registered' } } })
    expect(state.responses.remote.error?.code).toBe('UNKNOWN_FUNCTION')
    expect(() => applyA2UIMessage(state, { version: 'v1.0', agentFunctionResponse: { functionCallId: 'remote', value: 1, error: { code: 'X', message: 'both' } } })).toThrow('exactly')
  })
})

describe('durable surface restoration', () => {
  test('revalidates every component and model and does not replay RPCs', () => {
    let state = applyA2UIMessage(emptySurfaceState, create('main', { saved: 'value' }, [{ id: 'root', component: 'Text', text: { '@path': '/saved' } }]))
    state = applyA2UIMessage(state, { version: 'v1.0', callRendererFunction: { functionCallId: 'old', callFunction: { '@call': 'required', catalogId: CATALOG_ID, args: { value: true } } } })
    const restored = validateSurfaceState(JSON.parse(JSON.stringify(state)))
    expect(restored.surfaces.main.dataModel).toEqual({ saved: 'value' })
    expect(restored.outbox).toEqual([])
    expect(restored.responses).toEqual({})
    const corrupt = JSON.parse(JSON.stringify(state))
    corrupt.surfaces.main.components.root.component = 'HTML'
    expect(() => validateSurfaceState(corrupt)).toThrow('unsupported component')
    corrupt.surfaces.main.components.root.component = 'Text'
    corrupt.surfaces.main.components.root.id = 'wrong'
    expect(() => validateSurfaceState(corrupt)).toThrow('map key')
  })
})
