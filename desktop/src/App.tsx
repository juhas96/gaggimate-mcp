import { useCallback, useEffect, useState } from 'react'
import { Coffee, LayoutDashboard, Sprout, Sparkles, BookOpen, Settings2, ArrowRight, LoaderCircle, Network, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { connect, api, errorText, type Status } from '@/lib/api'
import { ErrorNotice } from '@/components/studio'
import { ShotWorkspace } from '@/components/shot-workspace'
import { Settings, ToolExplorer } from '@/components/library-settings'
import { CoffeeLibrary } from '@/components/coffee-library'
import { MachineWorkspace, ProfileWorkspace } from '@/components/machine-profiles'
import { AgentStudio } from '@/components/agent-studio'

const pages = [
  { id: 'shots', label: 'Brew journal', icon: LayoutDashboard },
  { id: 'beans', label: 'Coffee & grinders', icon: Sprout },
  { id: 'profiles', label: 'Profiles', icon: SlidersHorizontal },
  { id: 'machines', label: 'Machines', icon: Network },
  { id: 'agent', label: 'Barista studio', icon: Sparkles },
  { id: 'tools', label: 'Tools & knowledge', icon: BookOpen },
  { id: 'settings', label: 'Settings', icon: Settings2 },
] as const
type Page = typeof pages[number]['id']

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [page, setPage] = useState<Page>('shots')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [initialPrompt, setInitialPrompt] = useState('')
  const refreshStatus = useCallback(async () => { setStatus(await api<Status>('/status')) }, [])
  const consumePrompt = useCallback(() => setInitialPrompt(''), [])
  useEffect(() => {
    let disposed = false
    const abort = new AbortController()
    let timer: number | undefined
    async function start() {
      setStarting(true); setError(null)
      try {
        await connect()
        // First native launch may install the locked Python runtime into app data.
        const deadline = Date.now() + 180_000
        while (!disposed) {
          try {
            const next = await api<Status>('/status', undefined, undefined, abort.signal)
            if (!disposed) { setStatus(next); setStarting(false) }
            return
          } catch (e) {
            if (disposed) return
            if (Date.now() >= deadline) throw e
            const delay = Promise.withResolvers<void>()
            timer = window.setTimeout(delay.resolve, 700)
            await delay.promise
          }
        }
      } catch (e) { if (!disposed) { setError(`${errorText(e)} Check desktop-backend.log in the data directory for startup details.`); setStarting(false) } }
    }
    void start()
    return () => { disposed = true; abort.abort(); clearTimeout(timer) }
  }, [attempt])
  useEffect(() => {
    if (!status) return
    const interval = setInterval(() => { refreshStatus().catch(e => setError(`Backend connection lost: ${errorText(e)}`)) }, status.authStatus === 'pending' ? 1500 : 15000)
    return () => clearInterval(interval)
  }, [status?.authStatus, !!status, refreshStatus])
  if (!status) return <main className="startup"><div className="coffee-mark"><Coffee size={30}/></div><h1>Gaggimate Studio</h1><p className="subtitle">Your espresso, understood.</p>{starting ? <p className="flex gap-2 items-center mt-8 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={18}/>Starting your local workspace…</p> : <><ErrorNotice error={error}/><Button onClick={() => setAttempt(value => value + 1)}>Retry connection</Button></>}<small className="mt-4 text-muted-foreground">First launch may download the locked Python dependencies.</small></main>
  return <div className="studio-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Coffee size={23}/></div><div><strong>gaggimate<span>studio</span></strong><small>THE ART OF THE NEXT CUP</small></div></div>
      <div className="sidebar-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{pages.map(item => <button key={item.id} onClick={() => setPage(item.id)} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined}><item.icon size={18}/>{item.label}{item.id === 'agent' && <span className="nav-dot"/>}</button>)}</nav>
      <div className="sidebar-note"><Sprout size={21}/><p>A little more intention.<br/>A better cup of coffee.</p></div>
      <div className="sidebar-footer"><span className="status-dot"/><div><strong>Local workspace</strong><small>{status.host}</small></div></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{pages.find(p => p.id === page)?.label}</strong></div><button className="account-button" onClick={() => setPage('settings')}><span className={`status-dot ${status.authenticated ? '' : 'offline'}`}/>{status.authenticated ? 'ChatGPT connected' : 'Connect ChatGPT'}<ArrowRight size={14}/></button></header>
      <main className="main-content">
        <ErrorNotice error={error}/>
        {page === 'shots' && <ShotWorkspace onAnalyze={id => { setInitialPrompt(`Analyze shot ${id}. Read its actual telemetry, bean and grind record, and the relevant diagnostic knowledge. Show the extraction curves and explain the next adjustment using A2UI visuals.`); setPage('agent') }}/>}
        {page === 'beans' && <CoffeeLibrary/>}
        {page === 'profiles' && <ProfileWorkspace/>}
        {page === 'machines' && <MachineWorkspace onChanged={refreshStatus}/>}
        <div hidden={page !== 'agent'}><AgentStudio authenticated={status.authenticated} initialPrompt={initialPrompt} onPromptConsumed={consumePrompt} onSettings={() => setPage('settings')}/></div>
        {page === 'tools' && <ToolExplorer/>}
        {page === 'settings' && <Settings status={status} refreshStatus={refreshStatus}/>}
      </main>
    </div>
  </div>
}
