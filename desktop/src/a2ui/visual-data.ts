import { object, type Json } from './model'

/** Deliberately narrower than Mermaid: agent input cannot override renderer security or load resources. */
export function assertSafeDiagram(source: string): void {
  if (source.length > 20000) throw new Error('Diagram exceeds 20,000 characters')
  if (/^\s*---|%%\{|<\/?[a-z!]|\b(?:click|href|javascript|https?|data|file|style|classDef|linkStyle)\s*[:\s]|@\{|\burl\s*\(|\\/iu.test(source)) {
    throw new Error('Diagram configuration, styles, HTML, links and external resources are not allowed')
  }
}

export function validSeriesPoints(points: Json, series: { key: string; label: string }[]): points is Record<string, Json>[] {
  return Array.isArray(points) && points.length <= 10000 && points.every(point => object(point) && typeof point.x === 'number' && Number.isFinite(point.x) && series.every(line => point[line.key] === undefined || point[line.key] === null || typeof point[line.key] === 'number' && Number.isFinite(point[line.key])))
}
