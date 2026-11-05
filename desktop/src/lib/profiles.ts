import { z } from 'zod'

const finite = z.number().finite()
const pumpSchema = z.union([
  finite.min(0).max(100),
  z.object({
    target: z.enum(['pressure', 'flow', 'power', 'off']),
    pressure: finite.min(-1).max(100),
    flow: finite.min(-1),
  }).passthrough().refine(pump => pump.target === 'power' ? pump.pressure >= 0 : pump.pressure <= 12, 'Pressure must be −1–12 bar, or 0–100% in power mode'),
])
const phaseSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phase: z.enum(['preinfusion', 'brew', 'decline']),
  duration: finite.positive().max(120),
  valve: z.union([z.literal(0), z.literal(1)]),
  temperature: z.union([z.literal(0), finite.min(60).max(100)]).optional(),
  pump: pumpSchema,
  transition: z.object({ type: z.enum(['instant', 'linear', 'ease-in', 'ease-out', 'ease-in-out']), duration: finite.min(0), adaptive: z.boolean().optional() }).passthrough(),
  targets: z.array(z.object({ type: z.enum(['pressure', 'flow', 'volumetric', 'pumped']), operator: z.enum(['gte', 'lte']), value: finite }).passthrough()).optional(),
}).passthrough()

// Raw import preserves firmware fields and installs a new, unselected Pro copy.
export const importProfileSchema = z.object({
  label: z.string().trim().min(1).max(100),
  type: z.literal('pro'),
  temperature: finite.min(60).max(100),
  phases: z.array(phaseSchema).min(1).max(50),
  description: z.string().optional(),
}).passthrough()

export type ImportedProfile = z.infer<typeof importProfileSchema>
export interface DeviceProfile { id: string; label: string; type?: string; temperature?: number; description?: string; selected?: boolean; phases?: Record<string, unknown>[]; [key: string]: unknown }

export function exportProfile(profile: DeviceProfile) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${profile.label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'profile'}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
