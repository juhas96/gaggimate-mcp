import { useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Panel, Empty, JsonView } from './studio'
import { brewLabel, displayNumber, finite, type Brew, type Phase, type TelemetryPoint } from '@/lib/workspace'

const metrics = [
  { key: 'pressure_bar', name: 'Pressure', unit: 'bar', target: 'target_pressure_bar' },
  { key: 'flow_ml_s', name: 'Puck flow', unit: 'ml/s', target: 'target_flow_ml_s' },
  { key: 'temperature_c', name: 'Temperature', unit: '°C', target: 'target_temperature_c' },
  { key: 'weight_g', name: 'Scale weight', unit: 'g', target: '' },
  { key: 'machine_pump_flow_ml_s', name: 'Pump flow', unit: 'ml/s', target: '' },
  { key: 'machine_puck_resistance', name: 'Machine puck resistance', unit: 'firmware index', target: '' },
] as const
const colors = ['#b45309', '#2563eb', '#059669', '#9333ea', '#dc2626', '#0891b2']
const pointsFor = (brew: Brew) => brew.source === 'device' ? brew.analysis?.shot.time_series?.points ?? [] : []
function hasWeight(brew: Brew) {
  const shot = brew.analysis?.shot
  return (shot?.diagnostics?.weight?.scale_connected ?? shot?.diagnostics?.scale_connected) ?? finite(shot?.final_weight_g)
}

export function JournalCurves({ brews }: { brews: Brew[] }) {
  const [enabled, setEnabled] = useState<string[]>(['pressure_bar', 'flow_ml_s'])
  const [targets, setTargets] = useState(true)
  const [phases, setPhases] = useState(false)
  const plotted = useMemo(() => brews.filter(brew => pointsFor(brew).length), [brews])
  const end = Math.max(1, ...plotted.flatMap(brew => pointsFor(brew).map(point => point.time_seconds)))
  return <Panel title="Extraction comparison" action={<Badge variant="outline">Elapsed time · separate units</Badge>}>
    <p className="mb-3 text-sm text-muted-foreground">Select history entries to overlay. Each metric has its own correctly labelled axis. No resampling, extrapolation or manual-brew curves. Dashed lines are recorded targets, not today's profile.</p>
    <div className="mb-4 flex flex-wrap gap-4">{metrics.map(metric => <label key={metric.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled.includes(metric.key)} onChange={event => setEnabled(current => event.target.checked ? [...current, metric.key] : current.filter(key => key !== metric.key))}/>{metric.name} ({metric.unit})</label>)}</div>
    <div className="mb-4 flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={targets} onChange={event => setTargets(event.target.checked)}/>Recorded targets</label><label className="flex items-center gap-2"><input type="checkbox" checked={phases} onChange={event => setPhases(event.target.checked)}/>Phase starts</label></div>
    {brews.filter(brew => !pointsFor(brew).length).map(brew => <p className="mb-2 text-sm text-muted-foreground" key={brew.id}>{brewLabel(brew)}: {brew.source === 'manual' ? 'manual entry, no telemetry' : 'cached telemetry unavailable; sync its machine to retry'}.</p>)}
    {!plotted.length ? <Empty>No recorded curves available for this selection.</Empty> : !enabled.length ? <Empty>Enable a metric to view its curves.</Empty> : enabled.map(key => {
      const metric = metrics.find(item => item.key === key)!
      const available = plotted.filter(brew => (key !== 'weight_g' || hasWeight(brew)) && pointsFor(brew).some(point => finite(point[key as keyof TelemetryPoint])))
      return <div key={key} className="mb-6"><h3 className="mb-2 text-sm font-medium">{metric.name} ({metric.unit})</h3>{!available.length ? <Empty>This measurement was not recorded.</Empty> : <div className="h-64 w-full" role="img" aria-label={`${metric.name} comparison against elapsed seconds`}><ResponsiveContainer width="100%" height="100%"><LineChart margin={{ top: 8, right: 16, bottom: 10, left: 8 }}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="time_seconds" type="number" domain={[0, end]} allowDuplicatedCategory={false} unit=" s" tick={{ fontSize: 11 }}/><YAxis unit={metric.unit === 'firmware index' ? '' : ` ${metric.unit}`} width={78} tick={{ fontSize: 11 }} domain={['auto', 'auto']}/><Tooltip labelFormatter={value => `${value} s elapsed`}/><Legend/>{available.flatMap(brew => {
        const color = colors[plotted.indexOf(brew) % colors.length]
        const data = pointsFor(brew)
        return [<Line key={brew.id} data={data} dataKey={key} type="linear" stroke={color} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} name={`${brewLabel(brew)} (${metric.unit})`}/>, ...(targets && metric.target && data.some(point => finite(point[metric.target as keyof TelemetryPoint])) ? [<Line key={`${brew.id}-target`} data={data} dataKey={metric.target} type="linear" stroke={color} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} name={`${brewLabel(brew)} target (${metric.unit})`}/>] : [])]
      })}{phases && available.flatMap(brew => (brew.analysis?.shot.phases ?? []).map((phase, index) => <ReferenceLine key={`${brew.id}-${index}`} x={phase.start_time_seconds} stroke={colors[plotted.indexOf(brew) % colors.length]} strokeDasharray="2 5" label={{ value: phase.name, position: 'insideTop', fontSize: 10 }}/>))}</LineChart></ResponsiveContainer></div>}</div>
    })}
    <p className="text-xs text-muted-foreground">Firmware resistance is its own index, not computed pressure/flow². Pump flow and puck flow are different measurements. Weight is hidden when a scale measurement is unavailable.</p>
  </Panel>
}

export function PhaseDetails({ brew }: { brew: Brew }) {
  const shot = brew.analysis?.shot
  if (!shot || brew.source !== 'device') return null
  return <Panel title="Phase detail & recorded stops">
    <p className="mb-3 text-sm">Shot stopped: <strong>{shot.final_exit_reason ?? 'Not recorded by this firmware'}</strong>{finite(shot.brew_delay_ms) ? ` · Predictive stop lead: ${shot.brew_delay_ms} ms` : ''}</p>
    <p className="mb-3 text-sm text-muted-foreground">Binned mean recorded temperature target: {displayNumber(mean(shot.time_series?.points.map(point => point.target_temperature_c) ?? []))} °C. Missing phase targets or stop reasons are not inferred from the current profile.</p>
    {shot.warnings?.map((warning, index) => <p role="alert" key={index} className="mb-2 text-sm text-destructive">{warning}</p>)}
    {!(shot.phases?.length) ? <Empty>No phase detail was recorded.</Empty> : <div className="space-y-3">{shot.phases.map((phase, index) => <details key={`${phase.phase_number}-${index}`} className="details-panel" open>
      <summary>{phase.name} · {displayNumber(phase.start_time_seconds)}–{displayNumber(phase.start_time_seconds + phase.duration_seconds)} s · Stop: {phase.exit_reason ?? 'not recorded'}</summary>
      <div className="grid gap-3 p-3 text-sm sm:grid-cols-3">
        <span>Duration: {displayNumber(phase.duration_seconds)} s</span>
        <span>Mean pressure: {displayNumber(phase.avg_pressure_bar)} bar</span>
        <span>Mean temperature: {displayNumber(phase.avg_temperature_c)} °C</span>
        <span>Total puck flow: {displayNumber(phase.total_flow_ml)} ml</span>
        <span>Mean puck flow: {displayNumber(finite(phase.total_flow_ml) ? phase.diagnostics?.avg_flow_ml_s : null)} ml/s</span>
        <span>Samples: {phase.sample_count}</span>
        <span>Pressure target error (RMSE): {displayNumber(finite(phase.avg_pressure_bar) && phase.recorded_targets?.pressure_bar ? phase.diagnostics?.pressure_rmse_bar : null)} bar</span>
        <span>Flow target error (RMSE): {displayNumber(finite(phase.total_flow_ml) && phase.recorded_targets?.flow_ml_s ? phase.diagnostics?.flow_rmse_ml_s : null)} ml/s</span>
      </div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Recorded target', 'Start', 'End', 'Mean', 'Actual − target mean'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{([
        ['temperature_c', 'Temperature', '°C', phase.avg_temperature_c],
        ['pressure_bar', 'Pressure', 'bar', phase.avg_pressure_bar],
        ['flow_ml_s', 'Puck flow', 'ml/s', finite(phase.total_flow_ml) ? phase.diagnostics?.avg_flow_ml_s : null],
      ] as const).map(([key, label, unit, actual]) => {
        const target = phase.recorded_targets?.[key]
        return <tr key={key} className="border-t"><td className="p-2">{label} ({unit})</td><td className="p-2">{displayNumber(target?.start)}</td><td className="p-2">{displayNumber(target?.end)}</td><td className="p-2">{displayNumber(target?.avg)}</td><td className="p-2">{displayNumber(target && finite(actual) && finite(target.avg) ? actual - target.avg : null)}</td></tr>
      })}</tbody></table></div>
      <details className="m-3"><summary>All recorded phase diagnostics</summary><JsonView value={phase}/></details>
    </details>)}</div>}
    <details className="details-panel mt-4"><summary>Full recorded diagnostics, targets & firmware values</summary><JsonView value={{ summary: shot.summary, diagnostics: shot.diagnostics, machine_reported: shot.machine_reported, incomplete: brew.analysis?.incomplete }}/></details>
  </Panel>
}

function mean(values: (number | null | undefined)[]) {
  const measured = values.filter(finite)
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null
}
function sum(values: (number | null | undefined)[]) {
  const measured = values.filter(finite)
  return measured.length ? measured.reduce((total, value) => total + value, 0) : null
}
function grouped<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) { const name = key(item); const group = groups.get(name); if (group) group.push(item); else groups.set(name, [item]) }
  return [...groups.entries()]
}
function SummaryTable({ rows, label }: { rows: [string, Brew[]][]; label: string }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{[label, 'Brews', 'Dose (g)', 'Yield (g)', 'Time (s)', 'Rating'].map(title => <th className="p-2" key={title}>{title}</th>)}</tr></thead><tbody>{rows.map(([name, items]) => <tr key={name} className="border-t"><td className="p-2">{name}</td><td className="p-2">{items.length}</td>{(['dose_in', 'dose_out', 'duration_seconds', 'rating'] as const).map(key => <td key={key} className="p-2">{displayNumber(mean(items.map(item => item[key])))} <small className="text-muted-foreground">(n={items.filter(item => finite(item[key])).length})</small></td>)}</tr>)}</tbody></table></div>
}
export function JournalStatistics({ brews }: { brews: Brew[] }) {
  const phases = brews.flatMap(brew => brew.source === 'device' ? (brew.analysis?.shot.phases ?? []).filter(phase => phase.sample_count > 0).map(phase => ({ profile: brew.profile || 'Unnamed profile', phase })) : [])
  const phaseGroups = grouped(phases, item => `${item.profile} / ${item.phase.name}`)
  const days = grouped([...brews].sort((a, b) => a.brewed_at.localeCompare(b.brewed_at)), brew => {
    const date = new Date(brew.brewed_at)
    return Number.isNaN(date.getTime()) ? 'Date not recorded' : date.toLocaleDateString()
  })
  return <Panel title="Statistics · filtered history">
    <p className="mb-4 text-sm text-muted-foreground">Missing measurements are excluded, never counted as zero. n is the number of recorded values. Manual measurements are included; device telemetry is not overwritten by notes.</p>
    {!brews.length ? <Empty>No entries match these filters.</Empty> : <>
      <div className="metrics-grid">{[
        ['Brews', brews.length, ''],
        ['Recorded coffee used', sum(brews.map(brew => brew.dose_in)), 'g'],
        ['Recorded beverage yield', sum(brews.map(brew => brew.dose_out)), 'g'],
        ['Recorded water pumped (device only)', sum(brews.map(brew => brew.source === 'device' ? brew.analysis?.shot.summary?.flow?.water_pumped_ml : null)), 'ml'],
        ['Recorded brew time', sum(brews.map(brew => brew.duration_seconds)), 's'],
      ].map(([label, value, unit]) => <div className="metric" key={String(label)}><span>{label}</span><strong>{displayNumber(value)} <small>{unit}</small></strong></div>)}</div>
      <SummaryTable label="Average" rows={[[`All (${brews.filter(brew => brew.source === 'manual').length} manual)`, brews]]}/>
      <h3 className="mb-2 mt-6 font-medium">Per profile / manual recipe</h3>
      <SummaryTable label="Profile / recipe" rows={grouped(brews, brew => brew.profile || (brew.source === 'manual' ? 'Manual / no recipe' : 'Unnamed profile'))}/>
      <h3 className="mb-2 mt-6 font-medium">Daily trends (local date)</h3><SummaryTable label="Date" rows={days}/>
      <h3 className="mb-2 mt-6 font-medium">Per-phase averages (recorded device samples)</h3>
      {!phaseGroups.length ? <Empty>No recorded phase measurements.</Empty> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Profile / phase', 'Phases', 'Duration (s)', 'Pressure (bar)', 'Temperature (°C)', 'Puck volume (ml)'].map(label => <th className="p-2" key={label}>{label}</th>)}</tr></thead><tbody>{phaseGroups.map(([name, items]) => <tr className="border-t" key={name}><td className="p-2">{name}</td><td className="p-2">{items.length}</td>{(['duration_seconds', 'avg_pressure_bar', 'avg_temperature_c', 'total_flow_ml'] as const).map((key: keyof Phase) => <td className="p-2" key={key}>{displayNumber(mean(items.map(item => item.phase[key]).filter(finite)))} <small>(n={items.filter(item => finite(item.phase[key])).length})</small></td>)}</tr>)}</tbody></table></div>}
    </>}
  </Panel>
}
