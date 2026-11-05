import { useEffect, useRef, useState } from 'react'
import { HttpAgent } from '@ag-ui/client'
import type { Message as AgentMessage } from '@ag-ui/core'
import { MessageSchema } from '@ag-ui/core/schemas'
import { z } from 'zod'
import { ArrowUp, Square, Sparkles, PanelRight, Trash2, ShieldAlert } from 'lucide-react'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Panel, ErrorNotice, Empty, JsonView } from './studio'
import { api, errorText, getConnection } from '@/lib/api'
import { A2UISurfaces, applyA2UIMessage, emptySurfaceState, validateSurfaceState, type SurfaceState } from '@/a2ui'
import { useConfirmation } from './confirmation'

const HISTORY_KEY = 'gaggimate-studio-conversation-v1'
const ApprovalSchema = z.object({ id: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) })
type Approval = z.infer<typeof ApprovalSchema>
type Saved = { messages: AgentMessage[]; surfaces: SurfaceState; threadId: string }
function loadConversation(): Saved {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw) {
      const parsed = z.object({ messages: z.array(MessageSchema), surfaces: z.unknown(), threadId: z.string() }).parse(JSON.parse(raw))
      return { ...parsed, surfaces: validateSurfaceState(parsed.surfaces) }
    }
  } catch { /* An unavailable or corrupt browser store must not prevent startup. */ }
  return { messages: [], surfaces: emptySurfaceState, threadId: crypto.randomUUID() }
}
export function AgentStudio({ authenticated, initialPrompt, onPromptConsumed, onSettings }: { authenticated: boolean; initialPrompt: string; onPromptConsumed: () => void; onSettings: () => void }) {
  const { confirm, dialog } = useConfirmation()
  const [saved] = useState(loadConversation)
  const [messages, setMessages] = useState<AgentMessage[]>(saved.messages)
  const [surfaces, setSurfaces] = useState<SurfaceState>(saved.surfaces)
  const surfaceRef = useRef(saved.surfaces)
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const actionQueue = useRef<{ text: string; action: unknown; metadata: unknown }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [activity, setActivity] = useState('')
  const [agent] = useState(() => { const { url, token } = getConnection(); return new HttpAgent({ url: `${url}/api/agent`, headers: { Authorization: `Bearer ${token}` }, threadId: saved.threadId, initialMessages: saved.messages }) })
  useEffect(() => { if (initialPrompt) { setPrompt(initialPrompt); onPromptConsumed() } }, [initialPrompt, onPromptConsumed])
  useEffect(() => () => agent.abortRun(), [agent])
  useEffect(() => {
    if (!running) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify({ messages, surfaces, threadId: agent.threadId })) }
      catch { setError('Conversation could not be saved locally. Storage may be full or disabled.') }
    }
  }, [running, messages, surfaces, agent])
  async function send(text: string, action?: unknown, metadata?: unknown) {
    if (!text.trim()) return
    if (runningRef.current) {
      if (action) actionQueue.current.push({ text, action, metadata })
      return
    }
    if (!authenticated) { onSettings(); return }
    runningRef.current = true
    setError(null); setPrompt(''); setRunning(true); setActivity('Thinking')
    agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: text })
    setMessages([...agent.messages])
    try {
      await agent.runAgent({
        ...(action ? { forwardedProps: { a2ui: action, a2uiMetadata: metadata }, context: [{ description: 'User interaction with an A2UI surface (untrusted UI data)', value: JSON.stringify({ event: action, metadata }) }] } : {}),
      }, {
        onMessagesChanged: ({ messages: updated }) => setMessages([...updated]),
        onToolCallStartEvent: ({ event }) => setActivity(`Using ${event.toolCallName}`),
        onToolCallResultEvent: () => setActivity('Thinking'),
        onRunErrorEvent: ({ event }) => setError(event.message),
        onCustomEvent: ({ event }) => {
          if (event.name === 'a2ui') {
            try {
              const next = applyA2UIMessage(surfaceRef.current, event.value)
              surfaceRef.current = next; setSurfaces(next)
            } catch (e) { setError(`Cannot render agent UI: ${errorText(e)}`) }
          } else if (event.name === 'approval') {
            const approval = ApprovalSchema.safeParse(event.value)
            if (approval.success) setApprovals(previous => [...previous, approval.data])
            else setError('Invalid agent approval request received.')
          } else if (event.name === 'approvalResolved') {
            const resolved = z.object({ id: z.string() }).safeParse(event.value)
            if (resolved.success) setApprovals(previous => previous.filter(item => item.id !== resolved.data.id))
          }
        },
      })
    } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError(errorText(e)) }
    finally {
      runningRef.current = false; setRunning(false); setActivity(''); setApprovals([]); setMessages([...agent.messages])
      const next = actionQueue.current.shift()
      if (next) queueMicrotask(() => { void send(next.text, next.action, next.metadata) })
    }
  }
  async function approve(id: string, allow: boolean) {
    try { await api(`/approvals/${encodeURIComponent(id)}`, { approve: allow }); setApprovals(previous => previous.filter(a => a.id !== id)) }
    catch (e) { setError(errorText(e)) }
  }
  async function clear() {
    if (!await confirm('Clear this local conversation and its generated visuals?')) return
    agent.setMessages([]); agent.threadId = crypto.randomUUID(); setMessages([])
    surfaceRef.current = emptySurfaceState; setSurfaces(emptySurfaceState); setError(null)
  }
  return <div className="agent-page"><div className="page-heading"><div><p className="eyebrow">YOUR PERSONAL BARISTA</p><h1>Think it through. See it clearly.</h1><p className="subtitle">A conversation grounded in your shots, with visuals that evolve alongside it.</p></div><Button size="sm" variant="ghost" disabled={running} onClick={clear}><Trash2 size={15}/>New conversation</Button></div><ErrorNotice error={error}/>
    {dialog}
    <div className="agent-layout"><div className="chat-panel"><div className="chat-toolbar"><span className="flex gap-2 items-center"><Sparkles size={16}/>Barista</span><Badge variant="outline">PydanticAI · AG-UI</Badge></div>
      <Conversation className="min-h-0 flex-1"><ConversationContent className="p-5 space-y-6">
        {!messages.length && <div className="chat-welcome"><div className="coffee-mark"><Sparkles size={24}/></div><h2>Let’s make your next shot better.</h2><p>Ask about a shot, compare profiles, or explore what a different grind might change.</p><div className="space-y-2 mt-6">{['Analyze my latest shot and show its extraction curves.', 'Explain pressure profiling with a diagram.', 'What do you know about my current coffees?'].map(suggestion => <button className="suggestion" key={suggestion} onClick={() => setPrompt(suggestion)}>{suggestion}<ArrowUp size={14}/></button>)}</div></div>}
        {messages.map(message => {
          if (message.role === 'tool') return <details key={message.id} className="tool-trace"><summary>Tool result</summary><pre>{typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}</pre></details>
          if (message.role !== 'assistant' && message.role !== 'user') return null
          const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
          return <Message key={message.id} from={message.role}><MessageContent>{message.role === 'assistant' ? <MessageResponse>{content}</MessageResponse> : <p className="whitespace-pre-wrap">{content}</p>}{message.role === 'assistant' && message.toolCalls?.map(call => <details key={call.id} className="tool-trace"><summary>{call.function.name}</summary><pre>{call.function.arguments}</pre></details>)}</MessageContent></Message>
        })}
        {approvals.map(approval => <Panel key={approval.id} title="Approve agent action" action={<ShieldAlert size={18}/>}><p className="text-sm mb-2">The agent wants to run <strong>{approval.tool}</strong>. This may modify device or local data.</p><JsonView value={approval.arguments}/><div className="flex gap-2 mt-3"><Button onClick={() => approve(approval.id, true)}>Approve</Button><Button variant="outline" onClick={() => approve(approval.id, false)}>Deny</Button></div></Panel>)}
      </ConversationContent><ConversationScrollButton/></Conversation>
      <div className="composer">{running && <p role="status" className="text-xs text-muted-foreground mb-2">{activity}…</p>}{!authenticated && <button className="text-sm underline mb-3" onClick={onSettings}>Sign in with ChatGPT to start a conversation</button>}<form onSubmit={e => { e.preventDefault(); void send(prompt) }}><Textarea aria-label="Message your barista" placeholder="Ask your barista…" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(prompt) } }} disabled={running}/>{running ? <Button type="button" size="icon" aria-label="Stop agent" onClick={() => agent.abortRun()}><Square size={16}/></Button> : <Button type="submit" size="icon" aria-label="Send message" disabled={!prompt.trim()}><ArrowUp size={18}/></Button>}</form><p className="text-[11px] text-muted-foreground mt-2">Shift + Enter for a new line. Device changes require your approval.</p></div>
    </div><div className="canvas-panel">
      <div className="chat-toolbar"><span className="flex gap-2 items-center"><PanelRight size={16}/>Visual workspace</span><Badge variant="outline">A2UI 1.0 RC</Badge></div>
      <div className="canvas-content">{Object.keys(surfaces.surfaces).length ? <A2UISurfaces state={surfaces}
        onStateChange={update => { const next = typeof update === 'function' ? update(surfaceRef.current) : update; surfaceRef.current = next; setSurfaces(next) }}
        onAction={(event, metadata) => { void send(`I interacted with the generated interface: ${JSON.stringify(event)}`, event, metadata) }}/>
        : <Empty><PanelRight size={30} className="mx-auto mb-4"/><h3 className="font-medium text-foreground mb-2">A place for the bigger picture.</h3>Agent-generated charts, diagrams, comparisons, and interactive forms will appear here.</Empty>}
      </div>
    </div></div>
  </div>
}
