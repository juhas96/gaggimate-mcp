import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Download, Network, Pencil, Plus, RefreshCw, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { api, errorText } from '@/lib/api'
import { importHistory, type Machine } from '@/lib/workspace'
import { exportProfile, importProfileSchema, type DeviceProfile, type ImportedProfile } from '@/lib/profiles'
import { Panel, Field, Empty, ErrorNotice, Loading, JsonView } from './studio'
import { useConfirmation } from './confirmation'

export function MachineWorkspace({ onChanged }: { onChanged: () => Promise<void> }) {
  const [machines, setMachines] = useState<Machine[]>([])
  const [form, setForm] = useState({ id: '', name: '', host: '' })
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})
  const { confirm, dialog } = useConfirmation()
  async function load() { setMachines((await api<{ machines: Machine[] }>('/workspace')).machines) }
  useEffect(() => { load().catch(e => setError(errorText(e))).finally(() => setLoading(false)) }, [])
  async function save(event: FormEvent) {
    event.preventDefault()
    const existing = machines.find(machine => machine.id === form.id)
    if (existing && existing.host !== form.host && !await confirm(`Change the address of ${existing.name} from ${existing.host} to ${form.host}?\n\nUse this only when the SAME physical machine moved. To connect a different machine, cancel and add a new one so shot IDs cannot collide.`)) return
    setBusy('save'); setError(null)
    try {
      await api('/workspace/machines', { ...(form.id ? { id: form.id } : {}), name: form.name, host: form.host })
      await load(); await onChanged(); setEditing(false)
    } catch (e) { setError(errorText(e)) } finally { setBusy('') }
  }
  async function sync(selected: Machine[]) {
    setBusy('sync'); setError(null)
    for (const machine of selected) {
      setResults(previous => ({ ...previous, [machine.id]: 'Importing available shot history…' }))
      try {
        const result = await importHistory(machine.id, progress => {
          setResults(previous => ({ ...previous, [machine.id]: `${progress.imported} shots imported.${progress.next_offset !== null ? ` Checked ${progress.next_offset} history entries; continuing…` : ''}${progress.errors.length ? ` Errors so far: ${progress.errors.join('; ')}` : ''}` }))
        })
        setResults(previous => ({ ...previous, [machine.id]: `${result.imported} shots imported. ${result.errors.length ? `Some records could not be imported: ${result.errors.join('; ')}` : 'Local history is up to date with available machine records.'}` }))
      } catch (e) { setResults(previous => ({ ...previous, [machine.id]: `Sync failed: ${errorText(e)}. Previously imported history is still available.` })) }
    }
    setBusy('')
  }
  return <div className="space-y-6">
    {dialog}
    <div className="page-heading"><div><p className="eyebrow">LOCAL CONNECTIONS</p><h1>Your machines.</h1><p className="subtitle">Separate machine identities. One local brew history. No cloud account.</p></div><div className="flex gap-2"><Button variant="outline" disabled={!!busy || !machines.length} onClick={() => sync(machines)}><RefreshCw size={15}/>Sync all</Button><Button disabled={!!busy} onClick={() => { setForm({ id: '', name: '', host: '' }); setEditing(true) }}><Plus size={15}/>Add machine</Button></div></div>
    <ErrorNotice error={error}/>
    {editing && <Panel title={form.id ? 'Edit machine address' : 'Connect another machine'}><form onSubmit={save} className="space-y-4"><div className="form-grid"><Field label="Machine name"><Input required maxLength={200} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/></Field><Field label="Machine hostname or IP"><Input required value={form.host} placeholder="gaggimate.local" onChange={e => setForm({ ...form, host: e.target.value })}/></Field></div><p className="text-xs text-muted-foreground">Use a hostname or IP, optionally with a port. Imported shots are scoped to this machine, not just their shot number.</p><div className="flex gap-2"><Button disabled={!!busy} type="submit">Save machine</Button><Button type="button" variant="outline" disabled={!!busy} onClick={() => setEditing(false)}>Cancel</Button></div></form></Panel>}
    {loading ? <Loading/> : <div className="bean-grid">{machines.map(machine => <Panel key={machine.id} title={machine.name} action={<Network size={18}/>}><p className="text-sm text-muted-foreground mb-3">{machine.host}</p>{machine.id === 'default' && <Badge variant="outline">Default · barista and tools</Badge>}<div className="flex flex-wrap gap-2 mt-4"><Button disabled={!!busy} variant="outline" onClick={() => sync([machine])}><RefreshCw size={14}/>Sync history</Button><Button disabled={!!busy} variant="outline" onClick={() => { setForm(machine); setEditing(true) }}><Pencil size={14}/>Edit machine</Button></div>{results[machine.id] && <p role="status" className="text-sm mt-4 whitespace-pre-wrap">{results[machine.id]}</p>}</Panel>)}</div>}
    <Panel title="Sync without surprises"><ul className="text-sm text-muted-foreground space-y-2"><li>Sync reads your machine. It never edits shot notes or starts a brew.</li><li>Import is on demand. Run it again to catch up; existing local quick notes are preserved.</li><li>Previously imported measurements stay available when a machine is offline.</li><li>Quick-note writes require the separate, explicit sync action in the brew journal.</li><li>The barista and Tools & knowledge use the default machine; profile actions below use the machine you select.</li></ul></Panel>
  </div>
}

export function ProfileWorkspace() {
  const [machines, setMachines] = useState<Machine[]>([])
  const [machineId, setMachineId] = useState('')
  const [profiles, setProfiles] = useState<DeviceProfile[]>([])
  const [selected, setSelected] = useState<DeviceProfile | null>(null)
  const [imported, setImported] = useState<ImportedProfile | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const { confirm, dialog } = useConfirmation()
  const machine = machines.find(item => item.id === machineId)
  function call<T>(id: string, args: Record<string, unknown>) { return api<T>(`/workspace/machines/${encodeURIComponent(id)}/tools/manage_profile`, args) }
  useEffect(() => {
    let current = true
    api<{ machines: Machine[] }>('/workspace').then(value => { if (current) { setMachines(value.machines); setMachineId(value.machines[0]?.id ?? '') } }).catch(e => { if (current) setError(errorText(e)) })
    return () => { current = false }
  }, [])
  async function load(id: string) {
    const request = ++generation.current
    setLoading(true); setError(null); setProfiles([]); setSelected(null); setNotice('')
    try { const result = await call<{ profiles: DeviceProfile[] }>(id, { action: 'list' }); if (request === generation.current) setProfiles(result.profiles) }
    catch (e) { if (request === generation.current) setError(errorText(e)) }
    finally { if (request === generation.current) setLoading(false) }
  }
  useEffect(() => { if (machineId) void load(machineId); return () => { generation.current++ } }, [machineId])
  async function open(profile: DeviceProfile) {
    const request = ++generation.current
    setBusy(true); setError(null); setSelected(null)
    try { const result = await call<{ profile: DeviceProfile }>(machineId, { action: 'get', profile_id: profile.id }); if (request === generation.current) setSelected(result.profile) }
    catch (e) { if (request === generation.current) setError(errorText(e)) }
    finally { if (request === generation.current) setBusy(false) }
  }
  async function activate() {
    if (!selected || !await confirm(`Select ${selected.label} on ${machine?.name} (${machine?.host}) for the next brew? This changes the machine's active profile but does not start brewing.`)) return
    setBusy(true); setError(null)
    try { await call(machineId, { action: 'select', profile_id: selected.id }); await load(machineId); setNotice('Active profile changed. No brew was started.') }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  async function readImport(file?: File) {
    setError(null); setImported(null)
    if (!file) return
    try {
      if (file.size > 1_000_000) throw new Error('Profile file must be smaller than 1 MB.')
      const result = importProfileSchema.safeParse(JSON.parse(await file.text()))
      if (!result.success) throw new Error(`Expected a GaggiMate Pro profile JSON: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
      setImported(result.data)
    } catch (e) { setError(errorText(e)) }
  }
  async function install() {
    if (!imported || !machine || !await confirm(`Install a NEW copy of ${imported.label} on ${machine.name} (${machine.host})?\n\nThe MCP tool preserves the profile settings and adds its configured AI suffix. Existing profiles will not be overwritten, and the new copy is not automatically selected. Review the phase settings first.`)) return
    setBusy(true); setError(null)
    try {
      await call(machineId, { action: 'import', profile_data: imported })
      setImported(null); await load(machineId); setNotice('New profile copy installed. Select it explicitly when you are ready to use it.')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const visible = profiles.filter(profile => `${profile.label} ${profile.description ?? ''}`.toLowerCase().includes(query.toLowerCase()) && (kind === 'all' || profile.type === kind))
  return <div className="space-y-6">
    {dialog}
    <div className="page-heading"><div><p className="eyebrow">FROM RECIPE TO CUP</p><h1>Machine profiles.</h1><p className="subtitle">Browse, inspect and export profiles. Install a reviewed Pro JSON as a new copy.</p></div><Button variant="outline" disabled={!machineId || loading || busy} onClick={() => load(machineId)}><RefreshCw size={15}/>Refresh profiles</Button></div>
    <ErrorNotice error={error}/>{notice && <p role="status" className="text-sm">{notice}</p>}
    <Panel title="Profile browser"><div className="grid grid-cols-1 lg:grid-cols-3 gap-4"><Field label="Profile machine"><select value={machineId} disabled={busy || loading} onChange={e => setMachineId(e.target.value)}>{machines.map(item => <option key={item.id} value={item.id}>{item.name} · {item.host}</option>)}</select></Field><Field label="Search profiles"><Input value={query} placeholder="Name or description" onChange={e => setQuery(e.target.value)}/></Field><Field label="Profile type"><select value={kind} onChange={e => setKind(e.target.value)}><option value="all">All profiles</option>{[...new Set(profiles.map(profile => profile.type).filter(Boolean))].sort().map(type => <option key={type} value={type}>{type}</option>)}</select></Field></div></Panel>
    {loading ? <Loading>Reading profiles from {machine?.name}…</Loading> : !visible.length ? <Empty>No matching profiles. Connect a machine and refresh, or adjust the filters.</Empty> : <div className="bean-grid">{visible.map(profile => <Panel key={profile.id} title={profile.label} action={profile.selected ? <Badge>Active</Badge> : <Badge variant="outline">{profile.type ?? 'Profile'}</Badge>}><p className="text-sm text-muted-foreground mb-4">{profile.description}</p><Button variant="outline" disabled={busy} onClick={() => open(profile)}>Inspect profile</Button></Panel>)}</div>}
    {selected && <Panel title={selected.label}><div className="flex flex-wrap gap-3 items-center mb-4"><Badge variant="outline">{selected.type}</Badge>{typeof selected.temperature === 'number' && <span className="text-sm">{selected.temperature} °C</span>}<Button disabled={busy} onClick={activate}>Use on {machine?.name}</Button><Button variant="outline" onClick={() => exportProfile(selected)}><Download size={14}/>Export JSON</Button></div><p className="text-sm text-muted-foreground">{selected.description}</p><ProfilePhases phases={selected.phases}/><details className="mt-4"><summary className="text-sm">Complete machine profile JSON</summary><JsonView value={selected}/></details></Panel>}
    <Panel title="Import a Pro profile"><p className="text-sm text-muted-foreground mb-4">Choose a GaggiMate Pro JSON file. Review its phases, then explicitly install a new copy on the selected machine. This does not download community content or start the machine.</p><Field label="Profile JSON file"><Input type="file" accept="application/json,.json" disabled={busy} onChange={e => { void readImport(e.target.files?.[0]); e.target.value = '' }}/></Field>{imported && <div className="mt-5 space-y-4"><h2 className="font-semibold">{imported.label} · {imported.temperature} °C</h2><ProfilePhases phases={imported.phases}/><details><summary className="text-sm">Review import JSON</summary><JsonView value={imported}/></details><Button disabled={!machine || busy || loading} onClick={install}><Upload size={14}/>Install new copy on {machine?.name}</Button></div>}</Panel>
  </div>
}

function ProfilePhases({ phases }: { phases?: Record<string, unknown>[] }) {
  if (!phases?.length) return <p className="text-sm text-muted-foreground mt-4">No phase details supplied by this profile.</p>
  return <div className="overflow-x-auto mt-4"><table className="w-full text-sm text-left"><thead><tr className="border-b"><th className="p-2">Phase</th><th className="p-2">Maximum time</th><th className="p-2">Pump settings</th><th className="p-2">Stop conditions</th></tr></thead><tbody>{phases.map((phase, index) => <tr key={index} className="border-b"><td className="p-2">{String(phase.name ?? index + 1)}</td><td className="p-2">{typeof phase.duration === 'number' ? `${phase.duration} s` : '—'}</td><td className="p-2"><pre className="text-xs whitespace-pre-wrap">{phase.pump != null ? JSON.stringify(phase.pump, null, 2) : '—'}</pre></td><td className="p-2"><pre className="text-xs whitespace-pre-wrap">{Array.isArray(phase.targets) && phase.targets.length ? JSON.stringify(phase.targets, null, 2) : 'Duration limit'}</pre></td></tr>)}</tbody></table></div>
}
