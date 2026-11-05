import { useEffect, useId, useState } from 'react'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import { CartesianGrid, Legend, Line, LineChart as Chart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { type Json } from './model'
import { assertSafeDiagram, validSeriesPoints } from './visual-data'

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'neutral', htmlLabels: false, maxTextSize: 20000, maxEdges: 300 })
// Mermaid's parser and global configuration are shared; serialize renders, including StrictMode remounts.
let renderQueue: Promise<unknown> = Promise.resolve()
export function Diagram({ source, title }: { source: string; title?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [result, setResult] = useState<{ source: string; url?: string; error?: string }>()
  useEffect(() => {
    let cancelled = false
    let url: string | undefined
    const render = async () => {
      let container: HTMLDivElement | undefined
      try {
        assertSafeDiagram(source)
        if (!source.trim()) return
        if (cancelled) return
        container = document.createElement('div')
        container.style.position = 'absolute'
        container.style.left = '-100000px'
        document.body.appendChild(container)
        const { svg } = await mermaid.render(`a2ui-${id}-${crypto.randomUUID()}`, source, container)
        const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'script', 'a', 'image', 'use'], FORBID_ATTR: ['href', 'xlink:href', 'onload', 'onclick'] })
        const parsedSvg = new DOMParser().parseFromString(clean, 'image/svg+xml')
        const svgElement = parsedSvg.documentElement
        const viewBox = svgElement.getAttribute('viewBox')?.split(/\s+/).map(Number)
        if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
          svgElement.setAttribute('width', String(viewBox[2]))
          svgElement.setAttribute('height', String(viewBox[3]))
        }
        url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svgElement)], { type: 'image/svg+xml' }))
        if (cancelled) URL.revokeObjectURL(url)
        else setResult({ source, url })
      } catch (error) {
        if (!cancelled) setResult({ source, error: error instanceof Error ? error.message : 'Diagram rendering failed' })
      } finally { container?.remove() }
    }
    renderQueue = renderQueue.then(render, render)
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [source, id])
  if (!source.trim()) return <p className="text-sm text-muted-foreground">Waiting for diagram data…</p>
  if (result?.source !== source) return <p role="status">Rendering diagram…</p>
  if (result.error) return <p role="alert" className="text-sm text-destructive">{result.error}</p>
  return <figure className="overflow-auto">{title && <figcaption className="mb-3 font-medium">{title}</figcaption>}<img src={result.url} alt={title || 'Agent-generated diagram'} className="max-h-[600px] max-w-none" /></figure>
}
const colors = ['#b56a3d', '#337c91', '#6a8542', '#9564a5', '#c05b70', '#86702e']
export function SeriesChart({ points, series, title, xLabel, yLabel }: { points: Json | undefined; series: { key: string; label: string }[]; title?: string; xLabel?: string; yLabel?: string }) {
  if (points === undefined || points === null) return <p className="text-sm text-muted-foreground">Waiting for chart data…</p>
  if (!validSeriesPoints(points, series)) return <p role="alert" className="text-sm text-destructive">Chart requires at most 10,000 real observations with numeric x and numeric or missing series values.</p>
  if (!points.length) return <p className="text-sm text-muted-foreground">No observations available.</p>
  return <figure aria-label={title || 'Measurement chart'} className="min-w-0 w-full">
    {title && <figcaption className="mb-3 font-medium">{title}</figcaption>}
    <ResponsiveContainer width="100%" height={280} minWidth={0}>
      <Chart data={points} margin={{ top: 12, right: 18, bottom: xLabel ? 24 : 6, left: yLabel ? 18 : 0 }} accessibilityLayer>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} height={xLabel ? 50 : 30} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: 0 } : undefined} />
        <YAxis label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft' } : undefined} />
        <Tooltip /><Legend verticalAlign="top" height={32} />
        {series.map((line, i) => <Line key={line.key} dataKey={(point: Record<string, Json>) => point[line.key]} name={line.label} stroke={colors[i % colors.length]} type="linear" dot={false} connectNulls={false} isAnimationActive={false} />)}
      </Chart>
    </ResponsiveContainer>
  </figure>
}
