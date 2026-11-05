import { describe, expect, test } from 'bun:test'
import { importProfileSchema } from './profiles'

const profile = {
  label: 'Bloom', type: 'pro', temperature: 93,
  phases: [{ name: 'Bloom', phase: 'preinfusion', duration: 8, valve: 1, temperature: 0,
    pump: { target: 'power', pressure: 0, flow: 0 },
    transition: { type: 'instant', duration: 0, adaptive: true },
    targets: [{ type: 'pumped', operator: 'gte', value: 10 }],
  }],
}

describe('Pro profile import boundary', () => {
  test('preserves pump-off bloom, inherited temperature and stop conditions', () => {
    const imported = importProfileSchema.parse(profile)
    expect(imported.phases[0].pump).toEqual({ target: 'power', pressure: 0, flow: 0 })
    expect(imported.phases[0].temperature).toBe(0)
    expect(imported.phases[0].targets).toEqual([{ type: 'pumped', operator: 'gte', value: 10 }])
  })
  test('accepts recorded Automatic Pro sentinels without losing firmware extensions', () => {
    const firmware = { ...profile, dose: 18, description: 'Original guide',
      phases: [
        { ...profile.phases[0], pump: 0 },
        { ...profile.phases[0], pump: { target: 'pressure', pressure: -1, flow: -1 },
          transition: { type: 'ease-in-out', duration: 2, adaptive: true, target: 'time' },
          targets: [{ type: 'volumetric', operator: 'gte', value: 36, extension: true }] },
        { ...profile.phases[0], pump: { target: 'power', pressure: 100, flow: 0 } },
      ],
    }
    expect(importProfileSchema.parse(firmware)).toEqual(firmware)
  })
  test('rejects malformed and unsupported machine instructions before installation', () => {
    for (const change of [
      { type: 'simple' }, { temperature: Number.NaN }, { temperature: 120 }, { phases: [] },
      { phases: [{ ...profile.phases[0], duration: -1 }] },
      { phases: [{ ...profile.phases[0], valve: 2 }] },
      { phases: [{ ...profile.phases[0], pump: { target: 'pressure', pressure: 20, flow: 0 } }] },
    ]) expect(importProfileSchema.safeParse({ ...profile, ...change }).success).toBe(false)
  })
})
