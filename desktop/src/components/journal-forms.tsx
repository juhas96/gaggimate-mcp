import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, errorText } from '@/lib/api'
import { brewLabel, displayNumber, optionalNumber, type Brew, type Brewer, type Library, type Recipe, type Workspace } from '@/lib/workspace'
import { Empty, ErrorNotice, Field, Panel } from './studio'

type NoteDraft = { bean_id: string; grinder_id: string; grind_setting: string; dose_in: string; dose_out: string; rating: string; balance_taste: string; notes: string }
function noteDraft(brew?: Brew): NoteDraft {
  return { bean_id: brew?.bean_id ?? '', grinder_id: brew?.grinder_id ?? '', grind_setting: brew?.grind_setting ?? '', dose_in: brew?.dose_in?.toString() ?? '', dose_out: brew?.dose_out?.toString() ?? '', rating: brew?.rating?.toString() ?? '', balance_taste: brew?.balance_taste ?? '', notes: brew?.notes ?? '' }
}
function notePayload(draft: NoteDraft) {
  return { ...draft, bean_id: draft.bean_id || null, grinder_id: draft.grinder_id || null, dose_in: optionalNumber(draft.dose_in), dose_out: optionalNumber(draft.dose_out), rating: optionalNumber(draft.rating) }
}
function NoteFields({ draft, setDraft, library, brew }: { draft: NoteDraft; setDraft: (draft: NoteDraft) => void; library: Library; brew?: Brew }) {
  return <div className="grid gap-4 sm:grid-cols-2">
    <Field label="Coffee beans"><select value={draft.bean_id} onChange={event => setDraft({ ...draft, bean_id: event.target.value })}><option value="">No bean association</option>{brew?.bean_id && !library.beans.some(bean => bean.id === brew.bean_id) && <option value={brew.bean_id}>{brew.bean_name || brew.bean_id} (archived)</option>}{library.beans.map(bean => <option key={bean.id} value={bean.id}>{bean.name}{bean.roaster ? ` · ${bean.roaster}` : ''}</option>)}</select></Field>
    <Field label="Grinder"><select value={draft.grinder_id} onChange={event => setDraft({ ...draft, grinder_id: event.target.value })}><option value="">No grinder association</option>{brew?.grinder_id && !library.grinders.some(grinder => grinder.id === brew.grinder_id) && <option value={brew.grinder_id}>{brew.grinder_name || brew.grinder_id} (archived)</option>}{library.grinders.map(grinder => <option value={grinder.id} key={grinder.id}>{grinder.name}</option>)}</select></Field>
    <Field label="Grind setting"><Input value={draft.grind_setting} onChange={event => setDraft({ ...draft, grind_setting: event.target.value })}/></Field>
    {(['dose_in', 'dose_out', 'rating'] as const).map(key => <Field key={key} label={key === 'dose_in' ? 'Dose in (g)' : key === 'dose_out' ? 'Beverage yield (g)' : 'Rating (0–5)'}><Input type="number" min="0" max={key === 'rating' ? 5 : undefined} step={key === 'rating' ? 1 : 'any'} value={draft[key]} placeholder="Not recorded" onChange={event => setDraft({ ...draft, [key]: event.target.value })}/></Field>)}
    <Field label="Taste / balance"><select value={draft.balance_taste} onChange={event => setDraft({ ...draft, balance_taste: event.target.value })}><option value="">Not recorded</option><option value="bitter">Bitter</option><option value="balanced">Balanced</option><option value="sour">Sour</option></select></Field>
    <Field label="Tasting notes"><textarea rows={3} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })}/></Field>
  </div>
}

export function QuickNotes({ brew, history, library, libraryReady, onSaved }: { brew: Brew; history: Brew[]; library: Library; libraryReady: boolean; onSaved: (brew: Brew) => void }) {
  const [draft, setDraft] = useState(() => noteDraft(brew))
  const [sync, setSync] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const matches = history.filter(item => item.id !== brew.id && draft.bean_id && item.bean_id === draft.bean_id && item.profile === brew.profile && item.source === brew.source && (brew.source === 'device' ? item.machine_id === brew.machine_id : item.brewer_id === brew.brewer_id)).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.brewed_at.localeCompare(a.brewed_at)).slice(0, 3)
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null); setMessage('')
    try {
      const previous = noteDraft(brew)
      const payload = notePayload(draft)
      const changed = Object.fromEntries((Object.keys(draft) as (keyof NoteDraft)[]).filter(key => draft[key] !== previous[key]).map(key => [key, payload[key]]))
      const result = await api<{ brew: Brew; sync_error?: string }>(`/workspace/brews/${encodeURIComponent(brew.id)}/notes`, { ...changed, sync_to_device: brew.source === 'device' && sync })
      onSaved(result.brew)
      setMessage(result.sync_error ? 'Saved locally. Device sync failed; retry with device sync enabled.' : sync ? 'Saved locally. Device sync requested; see sync status.' : 'Saved locally. Device unchanged.')
      setError(result.sync_error ?? null)
    } catch (failure) { setError(errorText(failure)) } finally { setSaving(false) }
  }
  return <Panel title="Quick notes & next-brew suggestions">
    <form onSubmit={save} className="space-y-4">
      <ErrorNotice error={error}/><NoteFields draft={draft} setDraft={setDraft} library={library} brew={brew}/>
      {!libraryReady && <p className="text-sm text-destructive">Library unavailable. Refresh the journal before changing bean or grinder associations.</p>}
      <p className="text-sm text-muted-foreground">Yield notes do not replace the recorded scale curve. Saving is local unless you explicitly choose device sync.</p>
      {brew.source === 'device' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sync} onChange={event => setSync(event.target.checked)}/>Also sync these notes to {brew.machine_id === 'default' ? 'the default machine' : 'this shot’s machine'}</label>}
      {brew.sync_status && <p className="text-sm">Device sync: {brew.sync_status}</p>}
      {brew.sync_error && <ErrorNotice error={`Last device sync: ${brew.sync_error}`}/>}
      <Button disabled={saving || !libraryReady} type="submit">{saving ? 'Saving…' : sync ? 'Save notes & sync device' : 'Save notes locally'}</Button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </form>
    <div className="mt-6 border-t pt-4"><h3 className="mb-2 font-medium">Matching brew history</h3>
      <p className="mb-3 text-sm text-muted-foreground">Same bean, profile, source and machine/brewer. Highest recorded rating first, then newest; these are historical starting points, not predicted results. Apply only fills the form; save remains explicit.</p>
      {!matches.length ? <Empty>No matching bean/profile history yet.</Empty> : <div className="space-y-3">{matches.map(match => <div key={match.id} className="rounded-md border p-3 text-sm">
        <p>{brewLabel(match)} · Rating {displayNumber(match.rating)} · {displayNumber(match.dose_in)} g in / {displayNumber(match.dose_out)} g out · Grind {match.grind_setting || 'not recorded'}</p>
        <Button type="button" variant="outline" className="mt-2" disabled={Boolean(match.grinder_id && !library.grinders.some(grinder => grinder.id === match.grinder_id))} onClick={() => { setDraft(current => ({ ...current, dose_in: match.dose_in?.toString() ?? current.dose_in, dose_out: match.dose_out?.toString() ?? current.dose_out, grinder_id: match.grinder_id ?? current.grinder_id, grind_setting: match.grind_setting || current.grind_setting })); setMessage('Suggestion applied to the form. Review, then save.'); }}>Use these brew settings</Button>
        {match.grinder_id && !library.grinders.some(grinder => grinder.id === match.grinder_id) && <p className="mt-2 text-muted-foreground">This suggestion uses an archived grinder; select a current grinder manually.</p>}
      </div>)}</div>}
    </div>
  </Panel>
}

function localDateTime(value: string) {
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}
export function ManualBrewForm({ brew, workspace, library, libraryReady, onSaved, onCancel }: { brew?: Brew; workspace: Workspace; library: Library; libraryReady: boolean; onSaved: (brew: Brew) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(() => noteDraft(brew))
  const [brewer, setBrewer] = useState(brew?.brewer_id ?? workspace.brewers[0]?.id ?? '')
  const [recipe, setRecipe] = useState(brew?.recipe_id ?? '')
  const [brewedAt, setBrewedAt] = useState(() => localDateTime(brew?.brewed_at ?? new Date().toISOString()))
  const [duration, setDuration] = useState(brew?.duration_seconds?.toString() ?? '')
  const [temperature, setTemperature] = useState(brew?.temperature_c?.toString() ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null)
    try {
      const result = await api<{ brew: Brew }>('/workspace/brews', { ...(brew ? { id: brew.id } : {}), source: 'manual', brewer_id: brewer, recipe_id: recipe || null, brewed_at: new Date(brewedAt).toISOString(), duration_seconds: optionalNumber(duration), temperature_c: optionalNumber(temperature), ...notePayload(draft) })
      onSaved(result.brew)
    } catch (failure) { setError(errorText(failure)) } finally { setSaving(false) }
  }
  const chosenRecipe = workspace.recipes.find(item => item.id === recipe)
  return <Panel title={brew ? 'Edit manual brew' : 'Record a manual brew'}><form onSubmit={save} className="space-y-4"><ErrorNotice error={error}/><p className="text-sm text-muted-foreground">Manual source · no machine or telemetry. Empty measurements remain unknown. Date/time uses your local timezone and is saved with a timezone.</p>{!workspace.brewers.length && <Empty>Create a brewer below before recording a brew.</Empty>}<div className="grid gap-4 sm:grid-cols-2"><Field label="Brewer"><select required value={brewer} onChange={event => { setBrewer(event.target.value); setRecipe('') }}><option value="">Choose brewer</option>{workspace.brewers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.method}</option>)}</select></Field><Field label="Recipe"><select value={recipe} onChange={event => setRecipe(event.target.value)}><option value="">No recipe</option>{workspace.recipes.filter(item => item.brewer_id === brewer).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Brewed at (local time)"><Input required type="datetime-local" value={brewedAt} onChange={event => setBrewedAt(event.target.value)}/></Field><Field label="Duration (seconds)"><Input type="number" min="0" step="any" value={duration} placeholder="Not recorded" onChange={event => setDuration(event.target.value)}/></Field><Field label="Water temperature (°C)"><Input type="number" min="0" step="any" value={temperature} placeholder="Not recorded" onChange={event => setTemperature(event.target.value)}/></Field></div>{chosenRecipe && <div className="rounded-md border p-3 text-sm"><p>{chosenRecipe.name}: {displayNumber(chosenRecipe.dose_in)} g in / {displayNumber(chosenRecipe.dose_out)} g out · {displayNumber(chosenRecipe.duration_seconds)} s · {displayNumber(chosenRecipe.temperature_c)} °C</p>{chosenRecipe.notes && <p className="whitespace-pre-wrap">{chosenRecipe.notes}</p>}<Button type="button" variant="outline" className="mt-2" onClick={() => { setDraft(current => ({ ...current, dose_in: chosenRecipe.dose_in?.toString() ?? '', dose_out: chosenRecipe.dose_out?.toString() ?? '' })); setDuration(chosenRecipe.duration_seconds?.toString() ?? ''); setTemperature(chosenRecipe.temperature_c?.toString() ?? '') }}>Apply recipe measurements</Button></div>}<NoteFields draft={draft} setDraft={setDraft} library={library} brew={brew}/>{!libraryReady && <p className="text-sm text-destructive">Library unavailable. Refresh before saving.</p>}<div className="flex gap-2"><Button type="submit" disabled={saving || !brewer || !libraryReady}>{saving ? 'Saving…' : 'Save manual brew'}</Button><Button type="button" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button></div></form></Panel>
}

function BrewerForm({ brewer, onSaved }: { brewer?: Brewer; onSaved: (brewer: Brewer) => void }) {
  const [name, setName] = useState(brewer?.name ?? '')
  const [method, setMethod] = useState(brewer?.method ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null)
    try { const result = await api<{ brewer: Brewer }>('/workspace/brewers', { ...(brewer ? { id: brewer.id } : {}), name, method }); onSaved(result.brewer); if (!brewer) { setName(''); setMethod('') } } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  return <form onSubmit={save} className="space-y-3"><ErrorNotice error={error}/><Field label="Brewer name"><Input required value={name} onChange={event => setName(event.target.value)}/></Field><Field label="Brew method"><Input required placeholder="Pour-over, immersion, espresso…" value={method} onChange={event => setMethod(event.target.value)}/></Field><Button type="submit" disabled={busy}>{busy ? 'Saving…' : brewer ? 'Update brewer' : 'Create brewer'}</Button></form>
}
function RecipeForm({ recipe, brewers, onSaved }: { recipe?: Recipe; brewers: Brewer[]; onSaved: (recipe: Recipe) => void }) {
  const [name, setName] = useState(recipe?.name ?? '')
  const [brewer, setBrewer] = useState(recipe?.brewer_id ?? brewers[0]?.id ?? '')
  const [measurements, setMeasurements] = useState({ dose_in: recipe?.dose_in?.toString() ?? '', dose_out: recipe?.dose_out?.toString() ?? '', duration_seconds: recipe?.duration_seconds?.toString() ?? '', temperature_c: recipe?.temperature_c?.toString() ?? '' })
  const [notes, setNotes] = useState(recipe?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null)
    try { const result = await api<{ recipe: Recipe }>('/workspace/recipes', { ...(recipe ? { id: recipe.id } : {}), name, brewer_id: brewer, notes, ...Object.fromEntries(Object.entries(measurements).map(([key, value]) => [key, optionalNumber(value)])) }); onSaved(result.recipe); if (!recipe) { setName(''); setNotes(''); setMeasurements({ dose_in: '', dose_out: '', duration_seconds: '', temperature_c: '' }) } } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  return <form onSubmit={save} className="space-y-3"><ErrorNotice error={error}/><Field label="Recipe name"><Input required value={name} onChange={event => setName(event.target.value)}/></Field><Field label="Recipe brewer"><select required value={brewer} onChange={event => setBrewer(event.target.value)}><option value="">Choose brewer</option>{brewers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><div className="grid gap-3 sm:grid-cols-2">{([['dose_in', 'Dose (g)'], ['dose_out', 'Yield (g)'], ['duration_seconds', 'Duration (s)'], ['temperature_c', 'Water temperature (°C)']] as const).map(([key, label]) => <Field key={key} label={label}><Input type="number" min="0" step="any" placeholder="Not specified" value={measurements[key]} onChange={event => setMeasurements(current => ({ ...current, [key]: event.target.value }))}/></Field>)}</div><Field label="Recipe instructions"><textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)}/></Field><Button type="submit" disabled={busy || !brewer}>{busy ? 'Saving…' : recipe ? 'Update recipe' : 'Create recipe'}</Button></form>
}
export function BrewingSetup({ workspace, onBrewer, onRecipe }: { workspace: Workspace; onBrewer: (brewer: Brewer) => void; onRecipe: (recipe: Recipe) => void }) {
  const [brewerId, setBrewerId] = useState('')
  const [recipeId, setRecipeId] = useState('')
  const [message, setMessage] = useState('')
  return <Panel title="Reusable brewers & recipes"><p className="mb-4 text-sm text-muted-foreground">Create or edit your equipment and repeatable starting recipes. Applying a recipe to a manual brew is always explicit.</p>{message && <p role="status" className="mb-4 text-sm">{message}</p>}<div className="grid gap-6 lg:grid-cols-2"><div className="space-y-4"><Field label="Create / edit brewer"><select value={brewerId} onChange={event => setBrewerId(event.target.value)}><option value="">New brewer</option>{workspace.brewers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><BrewerForm key={brewerId} brewer={workspace.brewers.find(item => item.id === brewerId)} onSaved={item => { onBrewer(item); setMessage(`Saved brewer: ${item.name}`) }}/></div><div className="space-y-4"><Field label="Create / edit recipe"><select value={recipeId} onChange={event => setRecipeId(event.target.value)}><option value="">New recipe</option>{workspace.recipes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><RecipeForm key={recipeId} recipe={workspace.recipes.find(item => item.id === recipeId)} brewers={workspace.brewers} onSaved={item => { onRecipe(item); setMessage(`Saved recipe: ${item.name}`) }}/></div></div></Panel>
}
