/**
 * Suite 2 — Provider registry
 *
 * Tests for lib/providers/registry.ts:
 *  - getProvider instantiates the right factory for each providerType
 *  - getProvider returns null for inactive rows
 *  - getProvider warns when apiKeyEnvVar is set but env var is missing
 *  - getModel returns a LanguageModel (the factory's return value)
 *
 * vi.hoisted() is required because vi.mock() factories are hoisted before
 * variable declarations — without it, factory closures reference uninitialized
 * consts and throw ReferenceError.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

const {
  mockDbSelect,
  mockCreateAnthropic,
  mockCreateOpenAI,
  mockCreateGoogleGenerativeAI,
  mockAnthropicInstance,
  mockOpenAIInstance,
} = vi.hoisted(() => {
  const mockAnthropicInstance = vi.fn().mockReturnValue({ _tag: 'anthropic-model' })
  const mockOpenAIInstance = vi.fn().mockReturnValue({ _tag: 'openai-model' })
  const mockGoogleInstance = vi.fn().mockReturnValue({ _tag: 'google-model' })
  return {
    mockDbSelect: vi.fn(),
    mockCreateAnthropic: vi.fn().mockReturnValue(mockAnthropicInstance),
    mockCreateOpenAI: vi.fn().mockReturnValue(mockOpenAIInstance),
    mockCreateGoogleGenerativeAI: vi.fn().mockReturnValue(mockGoogleInstance),
    mockAnthropicInstance,
    mockOpenAIInstance,
    mockGoogleInstance,
  }
})

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('@/db', () => ({
  db: { select: mockDbSelect },
}))

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mockCreateAnthropic }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mockCreateOpenAI }))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: mockCreateGoogleGenerativeAI }))

// ---------------------------------------------------------------------------
// Drizzle chain factory
// ---------------------------------------------------------------------------

function chain(resolveValue: unknown) {
  const t: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(ok, err),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  ;['from', 'where', 'limit', 'orderBy'].forEach((m) => { t[m] = () => t })
  return t
}

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { getProvider, getModel } from '@/lib/providers/registry'
import type { ProviderConfig } from '@/db/schema'

// ---------------------------------------------------------------------------
// Row factory
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'config-id',
    displayName: 'Test Provider',
    providerType: 'anthropic',
    modelId: 'claude-3-5-sonnet-20241022',
    baseUrl: null,
    apiKeyEnvVar: null,
    isLocal: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests — getProvider
// ---------------------------------------------------------------------------

describe('getProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset factory mocks to their default return values
    mockCreateAnthropic.mockReturnValue(mockAnthropicInstance)
    mockCreateOpenAI.mockReturnValue(mockOpenAIInstance)
    // Clear env vars
    delete process.env.TEST_ANTHROPIC_KEY
    delete process.env.TEST_OPENAI_KEY
    delete process.env.TEST_OPENROUTER_KEY
    delete process.env.TEST_CUSTOM_KEY
    delete process.env.UNSET_KEY_VARIABLE
  })

  it('instantiates createAnthropic with the API key from the env var', async () => {
    process.env.TEST_ANTHROPIC_KEY = 'sk-ant-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'anthropic', apiKeyEnvVar: 'TEST_ANTHROPIC_KEY' }),
    ]))

    await getProvider('config-id')

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-ant-test' }),
    )
  })

  it('instantiates createOpenAI with baseURL=https://openrouter.ai/api/v1 for openrouter', async () => {
    process.env.TEST_OPENROUTER_KEY = 'sk-or-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'openrouter', apiKeyEnvVar: 'TEST_OPENROUTER_KEY' }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://openrouter.ai/api/v1' }),
    )
  })

  it('routes ollama through the OpenAI-compatible /v1 endpoint', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'ollama', baseUrl: 'http://localhost:11434', apiKeyEnvVar: null }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' }),
    )
  })

  it('does not append /v1 twice for ollama base URLs that already include it', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKeyEnvVar: null }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' }),
    )
  })

  it('instantiates createOpenAI with baseURL from the DB row for litellm', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'litellm', baseUrl: 'http://litellm:4000', apiKeyEnvVar: null }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://litellm:4000' }),
    )
  })

  it('instantiates createOpenAI with baseURL from the DB row for custom providers', async () => {
    process.env.TEST_CUSTOM_KEY = 'sk-custom-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'custom',
        baseUrl: 'https://models.example.com/v1',
        apiKeyEnvVar: 'TEST_CUSTOM_KEY',
      }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-custom-test',
        baseURL: 'https://models.example.com/v1',
      }),
    )
  })

  it('throws when a custom provider is missing baseUrl', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'custom', baseUrl: null }),
    ]))

    await expect(getProvider('config-id')).rejects.toThrow(/baseUrl is required/i)
  })

  it('returns null for an isActive=false row', async () => {
    mockDbSelect.mockReturnValue(chain([makeRow({ isActive: false })]))

    const result = await getProvider('config-id')
    expect(result).toBeNull()
  })

  it('returns null when no config row is found', async () => {
    mockDbSelect.mockReturnValue(chain([]))

    const result = await getProvider('missing-id')
    expect(result).toBeNull()
  })

  it('emits console.warn when apiKeyEnvVar is set but the env var is undefined', async () => {
    // UNSET_KEY_VARIABLE is deliberately not set in the environment
    mockDbSelect.mockReturnValue(chain([
      makeRow({ apiKeyEnvVar: 'UNSET_KEY_VARIABLE' }),
    ]))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await getProvider('config-id')

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('UNSET_KEY_VARIABLE'),
    )

    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Tests — getModel
// ---------------------------------------------------------------------------

describe('getModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateAnthropic.mockReturnValue(mockAnthropicInstance)
  })

  it('returns null when the config is not found', async () => {
    mockDbSelect.mockReturnValue(chain([]))
    const result = await getModel('missing-id')
    expect(result).toBeNull()
  })

  it('returns the LanguageModel by calling provider(modelId)', async () => {
    process.env.TEST_ANTHROPIC_KEY = 'sk-ant-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'anthropic',
        apiKeyEnvVar: 'TEST_ANTHROPIC_KEY',
        modelId: 'claude-opus-4-5',
      }),
    ]))

    const model = await getModel('config-id')

    // The anthropic factory instance was called with the modelId
    expect(mockAnthropicInstance).toHaveBeenCalledWith('claude-opus-4-5')
    expect(model).toEqual({ _tag: 'anthropic-model' })
  })
})
