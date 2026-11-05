import { describe, expect, test } from 'bun:test'
import { assertSafeDiagram, validSeriesPoints } from './visual-data'

describe('safe Mermaid input', () => {
  test('accepts structural diagrams', () => {
    expect(() => assertSafeDiagram('flowchart LR\n  Beans --> Grinder --> Machine --> Espresso')).not.toThrow()
    expect(() => assertSafeDiagram('sequenceDiagram\n  User->>Agent: Analyze shot\n  Agent-->>User: Findings')).not.toThrow()
  })
  test('blocks configuration overrides, markup, links, CSS and external resources', () => {
    for (const source of [
      '%%{init: {"securityLevel":"loose"}}%%\ngraph TD; A-->B',
      '---\nconfig:\n  securityLevel: loose\n---\ngraph TD; A-->B',
      'graph TD; A[<img src=x onerror=alert(1)>]',
      'graph TD; A-->B\nclick A "https://example.test"',
      'graph TD; A-->B\nclassDef x fill:url(https://example.test)',
      'graph TD; A@{ img: "https://example.test" }',
      'graph TD; A-->B\nstyle A fill:red',
      'graph TD; A[\\75rl]',
    ]) expect(() => assertSafeDiagram(source)).toThrow('not allowed')
    expect(() => assertSafeDiagram('a'.repeat(20001))).toThrow('20,000')
  })
})

describe('real measurement series', () => {
  const series = [{ key: 'pressure', label: 'Pressure' }]
  test('preserves gaps, zeros, empty observations and original data', () => {
    const points = [{ x: 0, pressure: 0 }, { x: 1, pressure: null }, { x: 2 }]
    const snapshot = JSON.stringify(points)
    expect(validSeriesPoints(points, series)).toBe(true)
    expect(JSON.stringify(points)).toBe(snapshot)
    expect(validSeriesPoints([], series)).toBe(true)
  })
  test('rejects nonnumeric series and fabricated implicit timestamps', () => {
    expect(validSeriesPoints([{ pressure: 9 }], series)).toBe(false)
    expect(validSeriesPoints([{ x: 1, pressure: '9' }], series)).toBe(false)
    expect(validSeriesPoints([{ x: 1, pressure: Number.POSITIVE_INFINITY }], series)).toBe(false)
    expect(validSeriesPoints({ points: [] }, series)).toBe(false)
  })
})
