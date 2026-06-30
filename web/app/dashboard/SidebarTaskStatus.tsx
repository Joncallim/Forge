'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ActivityIcon, AlertTriangleIcon, CheckCircle2Icon } from 'lucide-react'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type TaskSummary = {
  active: number
  attention: number
  byStatus: Record<string, number>
  attentionTasks: Array<{ id: string; title: string | null; status: string }>
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued',
  running: 'Running',
  approved: 'Handing off',
  awaiting_approval: 'Awaiting approval',
  awaiting_answers: 'Awaiting answers',
  failed: 'Failed',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}

const POLL_INTERVAL_MS = 15_000

export function SidebarTaskStatus() {
  const [summary, setSummary] = useState<TaskSummary | null>(null)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch('/api/tasks/summary', { cache: 'no-store' })
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data = (await res.json()) as TaskSummary
        if (!cancelled) {
          setSummary(data)
          setErrored(false)
        }
      } catch {
        if (!cancelled) setErrored(true)
      }
    }

    void load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const active = summary?.active ?? 0
  const attention = summary?.attention ?? 0
  const idle = !errored && active === 0 && attention === 0

  const tone = errored
    ? 'text-muted-foreground'
    : attention > 0
      ? 'text-amber-600 dark:text-amber-400'
      : active > 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-muted-foreground'

  const Icon = errored
    ? AlertTriangleIcon
    : attention > 0
      ? AlertTriangleIcon
      : idle
        ? CheckCircle2Icon
        : ActivityIcon

  const summaryLine = errored
    ? 'Status unavailable'
    : idle
      ? 'No active tasks'
      : [
          active > 0 ? `${active} active` : null,
          attention > 0 ? `${attention} need${attention === 1 ? 's' : ''} you` : null,
        ]
          .filter(Boolean)
          .join(' · ')
  const visibleStatusEntries = Object.entries(summary?.byStatus ?? {})
    .filter(([status]) => status !== 'completed' && status !== 'cancelled')
    .sort((a, b) => b[1] - a[1])

  const tooltipBody = (
    <div className="space-y-2">
      <p className="font-medium text-popover-foreground">Task activity</p>
      {errored ? (
        <p className="text-muted-foreground">Could not load task status. The worker or API may be offline.</p>
      ) : (
        <>
          <ul className="space-y-0.5">
            {visibleStatusEntries.map(([status, total]) => (
              <li key={status} className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{statusLabel(status)}</span>
                <span className="tabular-nums text-popover-foreground">{total}</span>
              </li>
            ))}
            {visibleStatusEntries.length === 0 && (
              <li className="text-muted-foreground">
                {Object.keys(summary?.byStatus ?? {}).length === 0 ? 'No tasks yet.' : 'No active tasks.'}
              </li>
            )}
          </ul>
          {(summary?.attentionTasks.length ?? 0) > 0 && (
            <div className="border-t border-border pt-1.5">
              <p className="mb-1 font-medium text-popover-foreground">Needs attention</p>
              <ul className="space-y-0.5">
                {summary?.attentionTasks.map((task) => (
                  <li key={task.id} className="truncate text-muted-foreground">
                    <span className="text-popover-foreground">{statusLabel(task.status)}:</span>{' '}
                    {task.title?.trim() || 'Untitled task'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <TooltipRoot>
      <TooltipTrigger
        render={
          <Link
            href="/dashboard/tasks"
            aria-label={`Task status: ${summaryLine}`}
            className="flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-3 py-2 text-xs transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        <Icon
          className={cn('size-3.5 shrink-0', tone, !idle && !errored && active > 0 && 'animate-pulse')}
          aria-hidden="true"
        />
        <span className={cn('min-w-0 flex-1 truncate font-medium', tone)}>{summaryLine}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipBody}</TooltipContent>
    </TooltipRoot>
  )
}
