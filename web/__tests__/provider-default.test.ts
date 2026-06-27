/**
 * Tests for lib/providers/default.ts — the workspace default-provider
 * setting and its runtime fallback chain (issue #88).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const { state, mockDb } = vi.hoisted(() => {
  const state: {
    settingRow: { value: string } | undefined
    providerRow: Record<string, unknown> | undefined
    localCandidates: { config: Record<string, unknown>; status: string }[]
    inserted: unknown[]
    deleted: unknown[]
  } = {
    settingRow: undefined,
    providerRow: undefined,
    localCandidates: [],
    inserted: [],
    deleted: [],
  }

  function selectChain(resolveValue: unknown) {
    const t: Record<string, unknown> = {
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        Promise.resolve(resolveValue).then(ok, err),
    }
    ;['from', 'where', 'limit', 'innerJoin', 'orderBy'].forEach((m) => { t[m] = () => t })
    return t
  }

  const mockDb = {
    select: vi.fn((fields?: Record<string, unknown>) => {
      // Distinguish the appSettings lookup (selects `value`) from the
      // providerConfigs-by-id lookup, from the joined local-candidates query.
      if (fields && 'value' in fields && Object.keys(fields).length === 1) {
        return selectChain(state.settingRow ? [state.settingRow] : [])
      }
      if (fields && 'config' in fields && 'status' in fields) {
        return selectChain(state.localCandidates)
      }
      return selectChain(state.providerRow ? [state.providerRow] : [])
    }),
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        state.inserted.push(v)
        return {
          onConflictDoUpdate: () => Promise.resolve(),
        }
      },
    })),
    delete: vi.fn(() => ({
      where: (v: unknown) => {
        state.deleted.push(v)
        return Promise.resolve()
      },
    })),
  }

  return { state, mockDb }
})

vi.mock('@/db', () => ({ db: mockDb }))

import {
  getDefaultProviderConfigId,
  setDefaultProviderConfigId,
  clearDefaultProviderConfigId,
  resolveDefaultProvider,
} from '@/lib/providers/default'

beforeEach(() => {
  state.settingRow = undefined
  state.providerRow = undefined
  state.localCandidates = []
  state.inserted = []
  state.deleted = []
  vi.clearAllMocks()
})

describe('getDefaultProviderConfigId / setDefaultProviderConfigId / clearDefaultProviderConfigId', () => {
  it('returns null when no setting is stored', async () => {
    expect(await getDefaultProviderConfigId()).toBeNull()
  })

  it('returns the stored value', async () => {
    state.settingRow = { value: 'provider-1' }
    expect(await getDefaultProviderConfigId()).toBe('provider-1')
  })

  it('upserts the setting on set', async () => {
    await setDefaultProviderConfigId('provider-2')
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0]).toMatchObject({ key: 'default_provider_config_id', value: 'provider-2' })
  })

  it('deletes the setting on clear', async () => {
    await clearDefaultProviderConfigId()
    expect(state.deleted).toHaveLength(1)
  })
})

describe('resolveDefaultProvider', () => {
  it('returns the configured default when it is still active', async () => {
    state.settingRow = { value: 'provider-1' }
    state.providerRow = { id: 'provider-1', isActive: true }

    const result = await resolveDefaultProvider()
    expect(result).toMatchObject({ id: 'provider-1' })
  })

  it('falls back to a ready local provider when the default is inactive', async () => {
    state.settingRow = { value: 'provider-1' }
    state.providerRow = { id: 'provider-1', isActive: false }
    state.localCandidates = [
      { config: { id: 'local-1', isLocal: true }, status: 'unreachable' },
      { config: { id: 'local-2', isLocal: true }, status: 'ready' },
    ]

    const result = await resolveDefaultProvider()
    expect(result).toMatchObject({ id: 'local-2' })
  })

  it('falls back to a ready local provider when no default is configured', async () => {
    state.localCandidates = [{ config: { id: 'local-1', isLocal: true }, status: 'ready' }]

    const result = await resolveDefaultProvider()
    expect(result).toMatchObject({ id: 'local-1' })
  })

  it('returns null when nothing is configured or ready', async () => {
    state.localCandidates = [{ config: { id: 'local-1', isLocal: true }, status: 'unreachable' }]

    const result = await resolveDefaultProvider()
    expect(result).toBeNull()
  })
})
