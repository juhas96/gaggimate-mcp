import type { ReactNode } from 'react'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'

export function Panel({ title, children, className = '', action }: { title: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return <Card className={className}><CardHeader className="flex flex-row items-center justify-between gap-3"><CardTitle className="text-base">{title}</CardTitle>{action}</CardHeader><CardContent>{children}</CardContent></Card>
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <Label className="grid gap-2 text-sm font-normal"><span className="text-muted-foreground">{label}</span>{children}</Label>
}
export function ErrorNotice({ error }: { error: string | null }) {
  return error ? <div role="alert" className="error-notice"><AlertCircle size={17}/><span>{error}</span></div> : null
}
export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={16}/>{children}</p>
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>
}
export function JsonView({ value }: { value: unknown }) {
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>
}
