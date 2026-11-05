import { useEffect, useState } from 'react'
import { LogIn, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Panel, Field, ErrorNotice, Empty, JsonView } from './studio'
import { api, tool, errorText, type Status, type Tool } from '@/lib/api'
import { useConfirmation } from './confirmation'

export function Settings({ status, refreshStatus }: { status: Status; refreshStatus: () => Promise<void> }) {
  const [host, setHost] = useState(status.host)
  const [model, setModel] = useState(status.model)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  async function action(path: string, body: unknown = {}, method?: string) {
    setBusy(true); setError(null); setNotice('')
    try { await api(path, body, method); await refreshStatus(); setNotice(path === '/settings' ? 'Settings saved.' : '') } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <div className="space-y-6 max-w-4xl">
    <div className="page-heading"><div><p className="eyebrow">LOCAL FIRST</p><h1>Your workspace.</h1><p className="subtitle">Your machine, your subscription, your data.</p></div></div>
    <ErrorNotice error={error || status.authError || null}/>
    <Panel title="ChatGPT subscription" action={<ShieldCheck size={20}/>}>
      <p className="mb-5 text-sm text-muted-foreground">Sign in with ChatGPT to authorize Gaggimate Studio to use your plan. PydanticAI runs locally; model requests go to OpenAI. No API key and no automatic paid-API fallback. Plan and model limits still apply.</p>
      <div className="flex items-center gap-3 flex-wrap"><Badge variant={status.authenticated ? 'default' : 'outline'}>{status.authenticated ? 'Connected to ChatGPT' : status.authStatus === 'pending' ? 'Waiting for browser sign-in' : 'Not signed in'}</Badge>{status.authenticated ? <Button variant="outline" disabled={busy} onClick={() => action('/auth/logout')}>Sign out of this app</Button> : <Button disabled={busy || status.authStatus === 'pending'} onClick={() => action('/auth/login')}><LogIn size={16}/>Sign in with ChatGPT</Button>}</div>
      <p className="mt-4 text-xs text-muted-foreground">App-owned credentials stay on this computer. Signing out does not affect OMP or Codex.</p>
    </Panel>
    <Panel title="Connection settings">
      <form className="space-y-5" onSubmit={e => { e.preventDefault(); void action('/settings', { host, model }, 'PUT') }}>
        <Field label="Gaggimate hostname or IP"><Input value={host} required onChange={e => setHost(e.target.value)} placeholder="gaggimate.local"/></Field>
        <Field label="ChatGPT model"><Input value={model} required onChange={e => setModel(e.target.value)} placeholder="gpt-6.1-sol"/></Field>
        <p className="text-xs text-muted-foreground">Model availability is determined by your subscription. A model name is not a guarantee of access.</p>
        <Button type="submit" disabled={busy}>Save settings</Button>
        <p role="status" className="text-sm">{notice}</p>
      </form>
    </Panel>
    <Panel title="What stays local"><ul className="space-y-2 text-sm text-muted-foreground"><li>Bean library, shot associations, and conversation history.</li><li>The Python MCP server and PydanticAI agent orchestration.</li><li>Device writes require a direct UI action or explicit approval of an agent request.</li><li>A2UI v1.0 candidate surfaces use a restricted app-owned component catalog; no agent-supplied executable code.</li></ul></Panel>
  </div>
}

export function ToolExplorer() {
  const { confirm, dialog } = useConfirmation()
  const [tools, setTools] = useState<Tool[]>([])
  const [selected, setSelected] = useState('read_knowledge')
  const [args, setArgs] = useState('{"action":"list"}')
  const [result, setResult] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api<{ tools: Tool[] }>('/tools').then(data => setTools(data.tools)).catch(e => setError(errorText(e))) }, [])
  const current = tools.find(t => t.name === selected)
  async function run() {
    setBusy(true); setError(null); setResult(null)
    try {
      const parsed = JSON.parse(args)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Arguments must be a JSON object.')
      const readActions = ['list', 'get', 'read', 'records']
      const readOnly = ['read_knowledge', 'analyze_shot', 'list_recent_shots', 'diagnose_connection'].includes(selected) || readActions.includes(parsed.action)
      if (!readOnly && !await confirm(`Run ${selected} with these arguments? This may change device or local data.\n\n${JSON.stringify(parsed, null, 2)}`)) return
      setResult(await tool(selected, parsed))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <div className="space-y-6">
    {dialog}
    <div className="page-heading"><div><p className="eyebrow">THE COMPLETE TOOLBOX</p><h1>Tools & knowledge.</h1><p className="subtitle">Every MCP capability, available directly. No hidden second implementation.</p></div><Badge variant="outline">{tools.length} live MCP tools</Badge></div>
    <ErrorNotice error={error}/>
    <div className="tool-layout">
      <Panel title="Run a tool"><div className="space-y-4">
        <Field label="MCP tool"><select value={selected} onChange={e => { setSelected(e.target.value); setResult(null); setArgs('{}') }}>{tools.map(t => <option value={t.name} key={t.name}>{t.name}</option>)}</select></Field>
        <p className="text-sm text-muted-foreground whitespace-pre-wrap max-h-44 overflow-auto">{current?.description}</p>
        <Field label="JSON arguments"><Textarea aria-label="JSON arguments" className="font-mono min-h-40" value={args} onChange={e => setArgs(e.target.value)}/></Field>
        <Button disabled={busy || !current} onClick={run}>{busy ? 'Running…' : 'Run tool'}</Button>
        <details><summary className="text-sm cursor-pointer">Input schema</summary><JsonView value={current?.inputSchema}/></details>
      </div></Panel>
      <Panel title="Result">{result === null ? <Empty>Select a tool and supply its arguments. Read knowledge with action “list”, then “read” and a filename.</Empty> : <JsonView value={result}/>}</Panel>
    </div>
  </div>
}
