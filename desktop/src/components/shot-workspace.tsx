import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { api, errorText } from '@/lib/api'
import { brewLabel, displayNumber, importHistory, type Brew, type Library, type Workspace } from '@/lib/workspace'
import { Panel, Field, ErrorNotice, Loading, Empty } from './studio'
import { JournalCurves, JournalStatistics, PhaseDetails } from './journal-analysis'
import { BrewingSetup, ManualBrewForm, QuickNotes } from './journal-forms'

const emptyWorkspace: Workspace = { machines: [], brews: [], brewers: [], recipes: [] }
const emptyFilters = { search: '', source: '', machine: '', bean: '', profile: '', from: '', to: '' }

export function ShotWorkspace({ onAnalyze }: { onAnalyze: (id: string) => void }) {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace)
  const [library, setLibrary] = useState<Library>({ beans: [], grinders: [] })
  const [libraryReady, setLibraryReady] = useState(false)
  const [selected, setSelected] = useState('')
  const [compared, setCompared] = useState<string[]>([])
  const [filters, setFilters] = useState(emptyFilters)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [machine, setMachine] = useState('default')
  const [errors, setErrors] = useState<string[]>([])
  const [syncErrors, setSyncErrors] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [editor, setEditor] = useState<string | null>(null)
  const [view, setView] = useState<'history' | 'statistics' | 'setup'>('history')
  const [notesVersion, setNotesVersion] = useState(0)

  async function refresh() {
    setLoading(true); setErrors([])
    const results = await Promise.allSettled([api<Workspace>('/workspace'), api<Library>('/library')])
    const nextErrors: string[] = []
    const history = results[0]
    if (history.status === 'fulfilled') {
      setWorkspace(history.value)
      setSelected(current => history.value.brews.some(brew => brew.id === current) ? current : [...history.value.brews].sort((a, b) => b.brewed_at.localeCompare(a.brewed_at))[0]?.id ?? '')
      setCompared(current => current.filter(id => history.value.brews.some(brew => brew.id === id)))
      setMachine(current => history.value.machines.some(item => item.id === current) ? current : history.value.machines[0]?.id ?? '')
      setNotesVersion(current => current + 1)
    } else nextErrors.push(`History could not be loaded: ${errorText(history.reason)}. Previously loaded entries remain visible.`)
    const catalog = results[1]
    if (catalog.status === 'fulfilled') { setLibrary(catalog.value); setLibraryReady(true) }
    else { setLibraryReady(false); nextErrors.push(`Coffee library could not be loaded: ${errorText(catalog.reason)}`) }
    setErrors(nextErrors); setLoading(false)
  }
  useEffect(() => { void refresh() }, [])
  async function syncMachine() {
    if (!machine) return
    setSyncing(true); setSyncErrors([]); setMessage('')
    try {
      const result = await importHistory(machine, async progress => {
        setMessage(`Imported ${progress.imported} device entries.${progress.next_offset !== null ? ` Checked ${progress.next_offset} history entries; continuing…` : ''}`)
        setSyncErrors(progress.errors)
        const next = await api<Workspace>('/workspace')
        setWorkspace(next)
        setSelected(current => current || next.brews[0]?.id || '')
      })
      setMessage(`Imported ${result.imported} device entries. Existing local notes are preserved.`)
    } catch (failure) { setSyncErrors(previous => [...previous, `Device import failed: ${errorText(failure)}. Local history is still available; reconnect and retry.`]) }
    finally { setSyncing(false) }
  }
  function saveBrew(brew: Brew) {
    setWorkspace(current => ({ ...current, brews: [...current.brews.filter(item => item.id !== brew.id), brew] }))
  }
  const sorted = useMemo(() => [...workspace.brews].sort((a, b) => b.brewed_at.localeCompare(a.brewed_at)), [workspace.brews])
  const filtered = useMemo(() => sorted.filter(brew => {
    if (filters.source && brew.source !== filters.source) return false
    if (filters.machine && brew.machine_id !== filters.machine) return false
    if (filters.bean && brew.bean_id !== filters.bean) return false
    if (filters.profile && brew.profile !== filters.profile) return false
    const date = new Date(brew.brewed_at)
    const localDay = Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    if ((filters.from || filters.to) && !localDay) return false
    if (filters.from && localDay < filters.from) return false
    if (filters.to && localDay > filters.to) return false
    const machineName = workspace.machines.find(item => item.id === brew.machine_id)?.name ?? ''
    return !filters.search || [brew.shot_id, brew.profile, brew.bean_name, brew.grinder_name, brew.grind_setting, brew.notes, brew.balance_taste, machineName, brew.source].join(' ').toLocaleLowerCase().includes(filters.search.toLocaleLowerCase())
  }), [sorted, filters, workspace.machines])
  const chosen = workspace.brews.find(brew => brew.id === selected)
  const machineName = chosen?.machine_id ? workspace.machines.find(item => item.id === chosen.machine_id)?.name ?? chosen.machine_id : 'No machine (manual brew)'
  const comparison = [chosen, ...compared.filter(id => id !== selected).map(id => workspace.brews.find(brew => brew.id === id))].filter((brew): brew is Brew => Boolean(brew))
  const profiles = [...new Set(workspace.brews.map(brew => brew.profile).filter(Boolean))].sort()
  const beanOptions = new Map(library.beans.map(bean => [bean.id, bean.name]))
  for (const brew of workspace.brews) if (brew.bean_id && !beanOptions.has(brew.bean_id)) beanOptions.set(brew.bean_id, `${brew.bean_name || brew.bean_id} (historical)`)

  return <div className="space-y-6">
    <div className="page-heading"><div><p className="eyebrow">YOUR LOCAL BREWING JOURNAL</p><h1>Every brew tells a story.</h1><p className="subtitle">Persisted device history and manual brews. Your notes stay local unless you choose to sync.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void refresh()} disabled={loading || syncing}><RefreshCw size={15} className={loading ? 'animate-spin' : ''}/>Refresh local history</Button><Button onClick={() => { setEditor('new'); setView('history') }} disabled={loading}><Plus size={15}/>Manual brew</Button></div></div>
    {errors.map((error, index) => <ErrorNotice key={index} error={error}/>)}
    <Panel title="Device history import"><div className="flex flex-wrap items-end gap-3"><Field label="Selected machine for import"><select value={machine} onChange={event => setMachine(event.target.value)} disabled={syncing}>{!workspace.machines.length && <option value="">No machines loaded</option>}{workspace.machines.map(item => <option key={item.id} value={item.id}>{item.name} · {item.host}</option>)}</select></Field><Button variant="outline" onClick={() => void syncMachine()} disabled={!machine || syncing || loading}>{syncing ? 'Importing device history…' : 'Import / retry device history'}</Button></div><p className="mt-3 text-sm text-muted-foreground">Refresh reads local storage and works while your machine is offline. Import explicitly reads the selected machine and caches telemetry; it never writes notes to the device.</p>{message && <p role="status" className="mt-3 text-sm">{message}</p>}{syncErrors.map((error, index) => <ErrorNotice key={index} error={error}/>)}</Panel>
    <div className="flex flex-wrap gap-2" aria-label="Journal views">{(['history', 'statistics', 'setup'] as const).map(tab => <Button key={tab} variant={view === tab ? 'default' : 'outline'} aria-pressed={view === tab} onClick={() => setView(tab)}>{tab === 'history' ? 'History & analysis' : tab === 'statistics' ? 'Statistics' : 'Brewers & recipes'}</Button>)}</div>
    {view !== 'setup' && <Panel title="Find a brew" action={<span className="text-sm text-muted-foreground">{filtered.length} / {workspace.brews.length} entries</span>}><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Field label="Search notes, bean, grind, profile or shot"><Input type="search" value={filters.search} onChange={event => setFilters(current => ({ ...current, search: event.target.value }))}/></Field><Field label="Source"><select value={filters.source} onChange={event => setFilters(current => ({ ...current, source: event.target.value }))}><option value="">All sources</option><option value="device">Device</option><option value="manual">Manual</option></select></Field><Field label="Machine"><select value={filters.machine} onChange={event => setFilters(current => ({ ...current, machine: event.target.value }))}><option value="">All machines + manual</option>{workspace.machines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Bean"><select value={filters.bean} onChange={event => setFilters(current => ({ ...current, bean: event.target.value }))}><option value="">All beans</option>{[...beanOptions.entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field><Field label="Profile / recipe"><select value={filters.profile} onChange={event => setFilters(current => ({ ...current, profile: event.target.value }))}><option value="">All profiles / recipes</option>{profiles.map(profile => <option key={profile} value={profile}>{profile}</option>)}</select></Field><Field label="From date (local)"><Input type="date" value={filters.from} onChange={event => setFilters(current => ({ ...current, from: event.target.value }))}/></Field><Field label="Through date (local)"><Input type="date" min={filters.from || undefined} value={filters.to} onChange={event => setFilters(current => ({ ...current, to: event.target.value }))}/></Field><div className="flex items-end"><Button variant="outline" onClick={() => setFilters(emptyFilters)}>Clear filters</Button></div></div></Panel>}
    {loading && !workspace.brews.length && <Loading>Loading persisted journal…</Loading>}
    {view === 'statistics' && <JournalStatistics brews={filtered}/>}
    {view === 'setup' && <BrewingSetup workspace={workspace} onBrewer={brewer => setWorkspace(current => ({ ...current, brewers: [...current.brewers.filter(item => item.id !== brewer.id), brewer] }))} onRecipe={recipe => setWorkspace(current => ({ ...current, recipes: [...current.recipes.filter(item => item.id !== recipe.id), recipe] }))}/>}
    {view === 'history' && <>
      {editor !== null && <ManualBrewForm key={editor} brew={editor === 'new' ? undefined : workspace.brews.find(brew => brew.id === editor)} workspace={workspace} library={library} libraryReady={libraryReady} onSaved={brew => { saveBrew(brew); setSelected(brew.id); setEditor(null); setNotesVersion(current => current + 1) }} onCancel={() => setEditor(null)}/>}
      {!workspace.brewers.length && editor !== null && <p className="text-sm">Open <Button variant="outline" onClick={() => setView('setup')}>Brewers & recipes</Button> to create your first brewer, then return here.</p>}
      <div className="shot-layout"><Panel title="Persisted history" className="shot-list"><p className="mb-3 text-xs text-muted-foreground">Open an entry; tick additional entries to compare. Comparison selection survives filtering.</p>{!filtered.length ? <Empty>{workspace.brews.length ? 'No entries match these filters.' : 'No local brews yet. Import a machine or record a manual brew. No sample data is shown.'}</Empty> : <div className="space-y-2">{filtered.map(brew => <div key={brew.id} className={`rounded-md border p-2 ${selected === brew.id ? 'border-primary' : ''}`}><button className={`shot-item w-full ${selected === brew.id ? 'selected' : ''}`} onClick={() => setSelected(brew.id)}><span className="flex justify-between gap-2"><strong>{brew.source === 'manual' ? 'Manual brew' : `Shot ${brew.shot_id}`}</strong><Badge variant="outline">{brew.source}</Badge></span><span className="block text-xs text-muted-foreground">{brew.brewed_at ? new Date(brew.brewed_at).toLocaleString() : 'Date not recorded'}</span><span className="block truncate text-sm">{brew.profile || workspace.brewers.find(item => item.id === brew.brewer_id)?.name || 'Unnamed profile'}</span><span className="block text-xs">{brew.machine_id ? workspace.machines.find(item => item.id === brew.machine_id)?.name ?? brew.machine_id : 'No machine'} · {brew.bean_name || 'No bean recorded'}</span><span className="text-xs text-muted-foreground">{displayNumber(brew.duration_seconds)} s · {displayNumber(brew.dose_out)} g · Rating {displayNumber(brew.rating)}</span></button><label className="flex items-center gap-2 px-2 text-xs"><input type="checkbox" checked={compared.includes(brew.id)} onChange={event => setCompared(current => event.target.checked ? [...current, brew.id] : current.filter(id => id !== brew.id))}/>Include in comparison</label></div>)}</div>}</Panel>
      <div className="min-w-0 space-y-5">{chosen ? <><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">{chosen.source === 'device' ? `SHOT ${chosen.shot_id}` : 'MANUAL BREW'}</p><h2 className="text-xl font-semibold">{chosen.profile || workspace.brewers.find(item => item.id === chosen.brewer_id)?.name || 'Unnamed profile'}</h2><p className="text-sm text-muted-foreground">Source: {chosen.source} · Machine: {machineName}</p><p className="text-xs text-muted-foreground">{brewLabel(chosen)}</p>{!filtered.some(brew => brew.id === chosen.id) && <p className="text-sm">Selected entry is outside the current filters.</p>}</div>{chosen.source === 'manual' ? <Button variant="outline" onClick={() => setEditor(chosen.id)}>Edit manual brew</Button> : chosen.machine_id === 'default' && chosen.shot_id ? <Button variant="outline" onClick={() => onAnalyze(chosen.shot_id!)}>Ask the barista<ArrowUpRight size={15}/></Button> : <p className="max-w-xs text-xs text-muted-foreground">Barista AI currently targets only default-machine device shots. Analysis below remains available locally for this machine.</p>}</div><div className="metrics-grid">{[['Duration', chosen.duration_seconds, 's'], ['Recorded dose', chosen.dose_in, 'g'], ['Noted yield', chosen.dose_out, 'g'], ['Measured scale yield', chosen.source === 'device' ? chosen.analysis?.shot.final_weight_g : null, 'g'], ['Water temperature', chosen.temperature_c, '°C'], ['Rating', chosen.rating, '/ 5']].map(([label, value, unit]) => <div className="metric" key={String(label)}><span>{label}</span><strong>{displayNumber(value)} <small>{unit}</small></strong></div>)}</div>{compared.length > 0 && <div className="flex flex-wrap items-center gap-2"><span className="text-sm">{comparison.length} selected for comparison</span><Button variant="outline" onClick={() => setCompared([])}>Clear comparison</Button></div>}<JournalCurves brews={comparison}/><PhaseDetails brew={chosen}/><QuickNotes key={`${chosen.id}-${notesVersion}`} brew={chosen} history={workspace.brews} library={library} libraryReady={libraryReady} onSaved={saveBrew}/></> : <Empty>Select a brew to inspect its recorded data.</Empty>}</div></div>
    </>}
  </div>
}
