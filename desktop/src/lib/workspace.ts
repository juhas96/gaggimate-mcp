import { api } from './api'

interface ImportProgress { imported: number; errors: string[]; next_offset: number | null }

export async function importHistory(machineId: string, onProgress: (progress: ImportProgress) => void | Promise<void>) {
  let offset = 0
  let imported = 0
  const errors: string[] = []
  while (true) {
    const batch = await api<ImportProgress>(`/workspace/machines/${encodeURIComponent(machineId)}/sync`, { offset })
    imported += batch.imported
    errors.push(...batch.errors)
    await onProgress({ imported, errors: [...errors], next_offset: batch.next_offset })
    if (batch.next_offset === null) return { imported, errors }
    if (!Number.isInteger(batch.next_offset) || batch.next_offset <= offset) throw new Error('History import did not advance. Saved records are retained; retry the import.')
    offset = batch.next_offset
  }
}

export interface Machine { id: string; name: string; host: string }
export interface Brewer { id: string; name: string; method: string }
export interface Recipe {
  id: string; name: string; brewer_id: string
  dose_in?: number | null; dose_out?: number | null; duration_seconds?: number | null
  temperature_c?: number | null; notes?: string
}
export interface LibraryBean { id: string; name: string; roaster?: string }
export interface Grinder { id: string; name: string; notes?: string }
export interface Library { beans: LibraryBean[]; grinders: Grinder[] }
export interface TelemetryPoint {
  target_temperature_c?: number | null; target_pressure_bar?: number | null; target_flow_ml_s?: number | null
  time_seconds: number; temperature_c?: number | null; pressure_bar?: number | null
  flow_ml_s?: number | null; weight_g?: number | null; phase_number: number
  machine_puck_resistance?: number | null; machine_pump_flow_ml_s?: number | null
}
export interface Phase {
  name: string; phase_number: number; start_time_seconds: number; duration_seconds: number
  sample_count: number; avg_temperature_c?: number | null; avg_pressure_bar?: number | null
  recorded_targets?: Partial<Record<'temperature_c' | 'pressure_bar' | 'flow_ml_s', { start: number; end: number; avg: number }>>
  total_flow_ml?: number | null; exit_reason?: string
  diagnostics?: { phase_type?: string; avg_flow_ml_s?: number | null; pressure_rmse_bar?: number | null; flow_rmse_ml_s?: number | null; [key: string]: unknown }
}
export interface ShotAnalysis {
  shot: {
    shot_id: string; profile_name: string; duration_seconds: number; final_weight_g: number | null
    phases?: Phase[]; time_series?: { points: TelemetryPoint[]; resolution_hz: number; point_count: number }
    summary?: {
      temperature?: { avg_c?: number | null; target_avg_c?: number | null }
      pressure?: { max_bar?: number | null; avg_bar?: number | null }
      flow?: { water_pumped_ml?: number | null; [key: string]: unknown }
      [key: string]: unknown
    }
    diagnostics?: { weight?: { scale_connected?: boolean }; scale_connected?: boolean; [key: string]: unknown } | null
    machine_reported?: { note?: string; [key: string]: unknown } | null
    final_exit_reason?: string; brew_delay_ms?: number; warnings?: string[]
  }
  rating?: unknown; incomplete?: unknown; [key: string]: unknown
}
export interface Brew {
  id: string; source: 'device' | 'manual'; machine_id: string | null; shot_id: string | null
  brewed_at: string; profile: string; brewer_id: string | null; recipe_id: string | null
  duration_seconds: number | null; temperature_c: number | null; dose_in: number | null; dose_out: number | null
  bean_id: string | null; bean_name: string; bean_snapshot?: Record<string, unknown>
  grinder_id: string | null; grinder_name: string; grinder_snapshot?: Record<string, unknown>
  grind_setting: string; rating: number | null; balance_taste: string; notes: string
  analysis: ShotAnalysis | null; sync_status?: string; sync_error?: string
}
export interface Workspace { machines: Machine[]; brews: Brew[]; brewers: Brewer[]; recipes: Recipe[] }
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
export const displayNumber = (value: unknown, digits = 1) => finite(value) ? value.toFixed(digits) : '—'
export const optionalNumber = (value: string): number | null => value.trim() === '' ? null : Number(value)
export function brewLabel(brew: Brew) {
  const date = new Date(brew.brewed_at)
  return `${brew.source === 'manual' ? 'Manual brew' : `Shot ${brew.shot_id}`} · ${Number.isNaN(date.getTime()) ? 'Date not recorded' : date.toLocaleString()}`
}
