'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRightIcon, CheckCircle2Icon, ServerIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PRESETS } from '@/lib/recommendations'
import { applyPreset } from '@/lib/applyPreset'

interface SetupWizardProps {
  hasProviders: boolean
}

function providerCount(presetId: string): number {
  const preset = PRESETS.find((p) => p.id === presetId)
  if (!preset) return 0

  return new Set(
    Object.values(preset.agents).map((agent) => `${agent.providerType}:${agent.modelId}`),
  ).size
}

export function SetupWizard({ hasProviders }: SetupWizardProps) {
  const router = useRouter()
  const [applyingPreset, setApplyingPreset] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleApplyPreset(presetId: string) {
    const preset = PRESETS.find((p) => p.id === presetId)
    if (!preset) return

    setApplyingPreset(presetId)
    setError(null)

    try {
      await applyPreset(preset)
      router.push('/dashboard/providers')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply preset')
    } finally {
      setApplyingPreset(null)
    }
  }

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <ServerIcon className="size-5 text-muted-foreground" aria-hidden="true" />
            <h1 className="text-xl font-semibold text-foreground">Setup</h1>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Select a provider preset to create model routes for the Forge agents.
          </p>
        </div>
        {hasProviders && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push('/dashboard/projects')}
            aria-label="Continue to projects"
          >
            Continue
            <ArrowRightIcon className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      {hasProviders && (
        <div className="mb-6 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          Providers are already configured. Applying a preset will update agent routing.
        </div>
      )}

      {error !== null && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {PRESETS.map((preset) => (
          <div
            key={preset.id}
            className="flex min-h-60 flex-col rounded-md border border-border bg-card p-4"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-foreground">{preset.label}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {preset.description}
                </p>
              </div>
              {preset.id === 'zero-config' && (
                <Badge variant="secondary">No API key</Badge>
              )}
              {preset.id === 'best-value' && (
                <Badge variant="secondary">Default</Badge>
              )}
            </div>

            <dl className="mb-4 grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Cost</dt>
                <dd className="mt-1 font-medium text-foreground">{preset.estimatedMonthlyCost}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Routes</dt>
                <dd className="mt-1 font-medium text-foreground">{providerCount(preset.id)} providers</dd>
              </div>
            </dl>

            <ul className="mb-4 flex-1 space-y-1.5 text-xs text-muted-foreground">
              {Object.entries(preset.agents).slice(0, 4).map(([agentType, spec]) => (
                <li key={agentType} className="flex items-center justify-between gap-2">
                  <span className="capitalize text-foreground">{agentType}</span>
                  <span className="truncate font-mono" title={spec.modelId}>{spec.modelId}</span>
                </li>
              ))}
            </ul>

            <Button
              size="sm"
              disabled={applyingPreset !== null}
              aria-busy={applyingPreset === preset.id}
              onClick={() => handleApplyPreset(preset.id)}
              aria-label={`Apply ${preset.label} preset`}
            >
              {applyingPreset === preset.id ? (
                'Applying...'
              ) : (
                <>
                  <CheckCircle2Icon className="size-4" aria-hidden="true" />
                  Apply preset
                </>
              )}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
