import { invoke, isTauri } from '@tauri-apps/api/core'

export interface Connection { url: string; token: string }
export interface Status { ready: boolean; authenticated: boolean; authStatus: string; authError?: string; model: string; host: string; a2uiVersion: string }
export interface Tool { name: string; description?: string; inputSchema: Record<string, unknown> }

let connection: Connection | undefined
export async function connect(): Promise<Connection> {
  if (isTauri()) connection = await invoke<Connection>('backend_connection')
  else {
    const url = import.meta.env.VITE_BACKEND_URL
    const token = import.meta.env.VITE_BACKEND_TOKEN
    if (!url || !token) throw new Error('Launch with bun run desktop, or configure VITE_BACKEND_URL and VITE_BACKEND_TOKEN for local browser development.')
    connection = { url, token }
  }
  return connection
}
export function getConnection(): Connection {
  if (!connection) throw new Error('Backend is not connected')
  return connection
}
export async function api<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const { url, token } = getConnection()
  const response = await fetch(`${url}/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'), signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok || data?.success === false) throw new Error(data.error ?? data.detail ?? `Request failed (${response.status})`)
  return data as T
}
export function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return api<T>(`/tools/${encodeURIComponent(name)}`, args)
}
export const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
