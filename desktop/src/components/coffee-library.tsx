import { useEffect, useState } from 'react'
import { Archive, Coffee, Download, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { api, errorText } from '@/lib/api'
import { Panel, Field, ErrorNotice, Loading, Empty } from './studio'
import { useConfirmation } from './confirmation'

type Kind = 'beans' | 'grinders'
interface Grinder { id: string; name: string; notes?: string; archived?: boolean }
interface CoffeeBean extends Grinder {
  roaster?: string; origin?: string; roast_date?: string; process?: string; variety?: string
  roast_level?: string; altitude?: string; rating?: number | null
}
interface Catalog { beans: CoffeeBean[]; grinders: Grinder[] }
interface HistoryBrew {
  id: string; brewed_at: string; profile: string; bean_id: string | null; bean_name: string
  grinder_id: string | null; grinder_name: string; grind_setting: string
}
interface ImportReport {
  preview: boolean; preview_token: string; policy: string
  beans: { added: number; skipped: number; matching_names: number }
  grinders: { added: number; skipped: number; matching_names: number }
}
const blankCoffee = { id: '', name: '', roaster: '', origin: '', roast_date: '', process: '', variety: '', roast_level: '', altitude: '', rating: '', notes: '' }
const coffeeLabels = { name: 'Coffee name', roaster: 'Roaster', origin: 'Origin', roast_date: 'Roast date', process: 'Process', variety: 'Variety', roast_level: 'Roast level', altitude: 'Altitude / elevation' }

export function CoffeeLibrary() {
  const { confirm, dialog } = useConfirmation()
  const [catalog, setCatalog] = useState<Catalog>({ beans: [], grinders: [] })
  const [history, setHistory] = useState<HistoryBrew[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyFilter, setHistoryFilter] = useState<{ kind: Kind; id: string; name: string } | null>(null)
  const [historyProfile, setHistoryProfile] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [coffeeForm, setCoffeeForm] = useState(blankCoffee)
  const [grinderForm, setGrinderForm] = useState({ id: '', name: '', notes: '' })
  const [editing, setEditing] = useState<Kind | null>(null)
  const [merge, setMerge] = useState({ kind: 'beans' as Kind, source_id: '', target_id: '' })
  const [importText, setImportText] = useState('')
  const [preview, setPreview] = useState<ImportReport | null>(null)

  async function loadHistory() {
    try { const data = await api<{ brews: HistoryBrew[] }>('/workspace'); setHistory(data.brews); setHistoryError(null) }
    catch (e) { setHistoryError(errorText(e)) }
  }
  async function load() {
    setCatalog(await api<Catalog>('/library'))
    await loadHistory()
  }
  useEffect(() => { load().catch(e => setError(errorText(e))).finally(() => setLoading(false)) }, [])
  async function act(operation: () => Promise<void>) {
    setBusy(true); setError(null); setNotice('')
    try { await operation() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  async function saveCoffee(e: React.FormEvent) {
    e.preventDefault()
    await act(async () => {
      await api('/library/beans', { ...coffeeForm, id: coffeeForm.id || undefined, rating: coffeeForm.rating === '' ? null : Number(coffeeForm.rating) })
      setEditing(null); setCoffeeForm(blankCoffee); setPreview(null); await load(); setNotice('Coffee saved locally.')
    })
  }
  async function saveGrinder(e: React.FormEvent) {
    e.preventDefault()
    await act(async () => {
      await api('/library/grinders', { ...grinderForm, id: grinderForm.id || undefined })
      setEditing(null); setGrinderForm({ id: '', name: '', notes: '' }); setPreview(null); await load(); setNotice('Grinder saved locally.')
    })
  }
  async function archive(kind: Kind, item: Grinder) {
    if (!await confirm(`${item.archived ? 'Restore' : 'Archive'} ${item.name}? Historical brew details are unchanged.`)) return
    await act(async () => {
      await api(`/library/${kind}`, { id: item.id, archived: !item.archived }); setPreview(null); await load()
      setNotice(item.archived ? 'Entry restored.' : 'Entry archived. Enable “Show archived” to restore it.')
    })
  }
  async function remove(kind: Kind, item: Grinder) {
    if (!await confirm(`Permanently delete ${item.name} from the catalog? Historical brew associations, names and snapshots remain. Archive instead if you might use this entry again.`)) return
    await act(async () => { await api('/library/delete', { kind, id: item.id }); setPreview(null); await load(); setNotice('Catalog entry deleted; history retained.') })
  }
  async function mergeEntries(e: React.FormEvent) {
    e.preventDefault()
    const entries = catalog[merge.kind]
    const source = entries.find(item => item.id === merge.source_id)
    const target = entries.find(item => item.id === merge.target_id)
    if (!source || !target || source.id === target.id) { setError('Choose two different entries to merge.'); return }
    if (!await confirm(`Merge “${source.name}” into “${target.name}”? The source catalog entry is removed and all its brew references point to the target. Target metadata is kept; historical names and snapshots are never changed. This cannot be undone.`)) return
    await act(async () => {
      await api('/library/merge', merge); setMerge({ ...merge, source_id: '', target_id: '' }); setPreview(null)
      if (historyFilter?.kind === merge.kind && historyFilter.id === source.id) setHistoryFilter({ kind: merge.kind, id: target.id, name: target.name })
      await load(); setNotice('Entries merged; historical snapshots retained.')
    })
  }
  async function exportLibrary() {
    await act(async () => {
      const data = await api<unknown>('/library/export')
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a'); link.href = url; link.download = 'gaggimate-library.json'; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('Native library export downloaded. It contains the catalog, not brew history.')
    })
  }
  async function previewImport() {
    setPreview(null)
    await act(async () => { setPreview(await api<ImportReport>('/library/import', { data: JSON.parse(importText), preview: true })) })
  }
  async function applyImport() {
    if (!preview || !await confirm(`Import ${preview.beans.added} coffees and ${preview.grinders.added} grinders? Existing IDs stay unchanged. Same-name entries with different IDs remain separate.`)) return
    await act(async () => {
      await api('/library/import', { data: JSON.parse(importText), preview: false, preview_token: preview.preview_token })
      setPreview(null); setImportText(''); await load(); setNotice('Native library import completed.')
    })
  }
  function visible(item: Grinder) {
    return (showArchived || !item.archived) && JSON.stringify(item).toLocaleLowerCase().includes(search.toLocaleLowerCase())
  }
  const historyRows = historyFilter ? history.filter(brew => (historyFilter.kind === 'beans' ? brew.bean_id : brew.grinder_id) === historyFilter.id).sort((a, b) => b.brewed_at.localeCompare(a.brewed_at)) : []
  const historyProfiles = [...new Set(historyRows.map(brew => brew.profile))].sort()
  const filteredHistory = historyRows.filter(brew => !historyProfile || (brew.profile || 'Manual') === historyProfile)
  function entryActions(kind: Kind, item: Grinder) {
    return <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => {
        if (kind === 'beans') {
          const bean = item as CoffeeBean
          setCoffeeForm({
            id: bean.id, name: bean.name, roaster: bean.roaster ?? '', origin: bean.origin ?? '',
            roast_date: bean.roast_date ?? '', process: bean.process ?? '', variety: bean.variety ?? '',
            roast_level: bean.roast_level ?? '', altitude: bean.altitude ?? '', notes: bean.notes ?? '',
            rating: bean.rating == null ? '' : String(bean.rating),
          })
        }
        else setGrinderForm({ id: item.id, name: item.name, notes: item.notes ?? '' })
        setEditing(kind)
      }}><Pencil size={14}/>Edit</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { setHistoryFilter({ kind, id: item.id, name: item.name }); setHistoryProfile('') }}>Grind history</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => archive(kind, item)}><Archive size={14}/>{item.archived ? 'Restore' : 'Archive'}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(kind, item)}><Trash2 size={14}/>Delete</Button>
    </div>
  }
  return <div className="space-y-6">
    {dialog}
    <div className="page-heading"><div><p className="eyebrow">KNOW YOUR COFFEE</p><h1>Coffees & grinders.</h1><p className="subtitle">A local catalog with immutable brew snapshots and native JSON portability.</p></div><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => { setCoffeeForm(blankCoffee); setEditing('beans') }}><Plus size={16}/>Add coffee</Button><Button variant="outline" disabled={busy} onClick={() => { setGrinderForm({ id: '', name: '', notes: '' }); setEditing('grinders') }}>Add grinder</Button></div></div>
    <ErrorNotice error={error}/><p role="status" className="text-sm">{notice}</p>
    {editing === 'beans' && <Panel title={coffeeForm.id ? 'Edit coffee' : 'Add coffee'}><form onSubmit={saveCoffee} className="space-y-4"><div className="form-grid">{(Object.keys(coffeeLabels) as (keyof typeof coffeeLabels)[]).map(key => <Field key={key} label={coffeeLabels[key]}><Input aria-label={coffeeLabels[key]} type={key === 'roast_date' ? 'date' : 'text'} required={key === 'name'} maxLength={key === 'roast_date' ? 10 : 200} value={coffeeForm[key]} onChange={e => setCoffeeForm({ ...coffeeForm, [key]: e.target.value })}/></Field>)}<Field label="Coffee rating (0–5, optional)"><Input aria-label="Coffee rating" type="number" min="0" max="5" step="0.1" value={coffeeForm.rating} onChange={e => setCoffeeForm({ ...coffeeForm, rating: e.target.value })}/></Field></div><Field label="Tasting notes"><Textarea aria-label="Coffee notes" maxLength={2000} value={coffeeForm.notes} onChange={e => setCoffeeForm({ ...coffeeForm, notes: e.target.value })}/></Field><div className="flex gap-2"><Button disabled={busy} type="submit">Save coffee</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button></div></form></Panel>}
    {editing === 'grinders' && <Panel title={grinderForm.id ? 'Edit grinder' : 'Add grinder'}><form onSubmit={saveGrinder} className="space-y-4"><Field label="Grinder name"><Input aria-label="Grinder name" required maxLength={200} value={grinderForm.name} onChange={e => setGrinderForm({ ...grinderForm, name: e.target.value })}/></Field><Field label="Grinder notes"><Textarea aria-label="Grinder notes" maxLength={2000} value={grinderForm.notes} onChange={e => setGrinderForm({ ...grinderForm, notes: e.target.value })}/></Field><div className="flex gap-2"><Button disabled={busy} type="submit">Save grinder</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button></div></form></Panel>}
    <div className="flex flex-wrap items-center gap-4"><Input aria-label="Search coffees and grinders" placeholder="Search coffees and grinders…" value={search} onChange={e => setSearch(e.target.value)}/><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)}/>Show archived</label></div>
    {loading ? <Loading/> : <>
      <section className="space-y-4"><h2 className="text-xl font-semibold">Coffees</h2>{!catalog.beans.filter(visible).length ? <Empty>No matching coffees. Add a coffee or change the filters.</Empty> : <div className="bean-grid">{catalog.beans.filter(visible).map(bean => <Panel key={bean.id} title={bean.name} action={<Coffee size={18}/>}><div className="my-3 flex flex-wrap gap-2">{bean.archived && <Badge variant="outline">Archived</Badge>}{bean.origin && <Badge variant="secondary">{bean.origin}</Badge>}{bean.rating != null && <Badge variant="outline">{bean.rating} / 5</Badge>}</div><dl className="mb-4 text-sm space-y-1">{(['roaster', 'roast_date', 'process', 'variety', 'roast_level', 'altitude'] as const).map(key => bean[key] ? <div key={key}><dt className="inline text-muted-foreground">{coffeeLabels[key]}: </dt><dd className="inline">{bean[key]}</dd></div> : null)}</dl><p className="mb-4 whitespace-pre-wrap text-sm">{bean.notes}</p>{entryActions('beans', bean)}</Panel>)}</div>}</section>
      <section className="space-y-4"><h2 className="text-xl font-semibold">Grinders</h2>{!catalog.grinders.filter(visible).length ? <Empty>No matching grinders. Record your grinder to compare settings across coffees and profiles.</Empty> : <div className="bean-grid">{catalog.grinders.filter(visible).map(grinder => <Panel key={grinder.id} title={grinder.name}>{grinder.archived && <Badge variant="outline">Archived</Badge>}<p className="my-4 text-sm whitespace-pre-wrap">{grinder.notes}</p>{entryActions('grinders', grinder)}</Panel>)}</div>}</section>
    </>}
    {historyFilter && <Panel title={`Grind history · ${historyFilter.name}`} action={<Button variant="ghost" size="sm" onClick={() => setHistoryFilter(null)}>Close</Button>}>
      <ErrorNotice error={historyError}/>
      {historyError && <Button variant="outline" disabled={busy} onClick={() => act(loadHistory)}>Retry history</Button>}
      <p className="mb-4 text-sm text-muted-foreground">Historical coffee and grinder names are preserved, including after a merge. History includes locally saved and imported brews.</p>
      <Field label="History profile"><select aria-label="Grind history profile" value={historyProfile} onChange={e => setHistoryProfile(e.target.value)}><option value="">All profiles</option>{historyProfiles.map(profile => <option key={profile} value={profile || 'Manual'}>{profile || 'Manual'}</option>)}</select></Field>
      {!filteredHistory.length ? <Empty>No linked brews for this profile.</Empty> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['Date', 'Coffee snapshot', 'Grinder snapshot', 'Profile', 'Setting'].map(label => <th className="p-2 text-left" key={label}>{label}</th>)}</tr></thead><tbody>{filteredHistory.map(brew => <tr className="border-t" key={brew.id}><td className="p-2">{new Date(brew.brewed_at).toLocaleString()}</td><td className="p-2">{brew.bean_name || '—'}</td><td className="p-2">{brew.grinder_name || '—'}</td><td className="p-2">{brew.profile || 'Manual'}</td><td className="p-2">{brew.grind_setting || 'Not recorded'}</td></tr>)}</tbody></table></div>}
    </Panel>}
    <Panel title="Merge duplicate entries"><form onSubmit={mergeEntries} className="space-y-4"><p className="text-sm text-muted-foreground">Choose a source to remove and a destination to keep. Historical names and snapshots remain unchanged. Only live associations move; destination metadata wins.</p><div className="form-grid"><Field label="Entry type"><select aria-label="Merge entry type" value={merge.kind} onChange={e => setMerge({ kind: e.target.value as Kind, source_id: '', target_id: '' })}><option value="beans">Coffees</option><option value="grinders">Grinders</option></select></Field><Field label="Source (remove)"><select aria-label="Merge source" required value={merge.source_id} onChange={e => setMerge({ ...merge, source_id: e.target.value })}><option value="">Choose source</option>{catalog[merge.kind].map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (archived)' : ''} · {item.id.slice(0, 8)}</option>)}</select></Field><Field label="Destination (keep)"><select aria-label="Merge destination" required value={merge.target_id} onChange={e => setMerge({ ...merge, target_id: e.target.value })}><option value="">Choose destination</option>{catalog[merge.kind].filter(item => item.id !== merge.source_id).map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (archived)' : ''} · {item.id.slice(0, 8)}</option>)}</select></Field></div><Button type="submit" variant="outline" disabled={busy || !merge.source_id || !merge.target_id || merge.source_id === merge.target_id}>Review merge</Button></form></Panel>
    <Panel title="Native library import & export" action={<Button variant="outline" disabled={busy} onClick={exportLibrary}><Download size={16}/>Export JSON</Button>}><div className="space-y-4"><p className="text-sm text-muted-foreground">Version 1 Gaggimate library JSON only — not Beanconqueror, ZIP, or Excel. Includes coffee and grinder metadata and IDs, not brew history. Existing IDs are kept unchanged; different IDs remain separate even with matching names. Preview is required before importing.</p><Field label="Choose native JSON export"><Input aria-label="Native library JSON file" type="file" accept="application/json,.json" disabled={busy} onChange={e => {
      const file = e.target.files?.[0]; setPreview(null)
      if (!file) return
      setImportText('')
      if (file.size > 2_000_000) { setError('Choose a JSON file no larger than 2 MB (2,000,000 bytes).'); return }
      void act(async () => { setImportText(await file.text()) })
    }}/></Field><Field label="Or paste native JSON"><Textarea aria-label="Native library JSON" className="font-mono min-h-36" disabled={busy} value={importText} onChange={e => { setImportText(e.target.value); setPreview(null) }}/></Field><Button variant="outline" disabled={busy || !importText.trim()} onClick={previewImport}>Preview import</Button>{preview && <div className="space-y-3" role="status"><p className="text-sm">{preview.policy}</p>{(['beans', 'grinders'] as const).map(kind => <p className="text-sm" key={kind}>{kind === 'beans' ? 'Coffees' : 'Grinders'}: {preview[kind].added} to add, {preview[kind].skipped} existing IDs skipped, {preview[kind].matching_names} matching names retained as separate entries.</p>)}<Button disabled={busy} onClick={applyImport}>Confirm import</Button></div>}</div></Panel>
  </div>
}
