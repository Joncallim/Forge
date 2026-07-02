'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ListTodoIcon, LoaderCircleIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Task {
  id: string
  projectId: string
  projectName?: string
  title: string
  prompt: string
  status: string
  githubPrUrl: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

type StatusVariant = 'default' | 'secondary' | 'destructive' | 'outline'

function statusBadgeVariant(status: string): StatusVariant {
  switch (status) {
    case 'running': return 'default'
    case 'awaiting_approval': return 'outline'
    case 'approved':
    case 'completed': return 'secondary'
    case 'failed':
    case 'rejected':
    case 'cancelled': return 'destructive'
    default: return 'outline'
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    awaiting_answers: 'Needs answers',
    awaiting_approval: 'Needs approval',
    dead_lettered: 'Stopped after retries',
  }
  if (labels[status]) return labels[status]
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function RunningStatusBadge({ status }: { status: string }) {
  const isRunning = status === 'running' || status === 'approved'

  return (
    <Badge variant={statusBadgeVariant(status)} className="inline-flex items-center gap-1.5">
      {isRunning && (
        <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />
      )}
      {statusLabel(status)}
    </Badge>
  )
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'awaiting_approval', label: 'Needs approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
]

export default function TasksPage() {
  const router = useRouter()
  const [tasks, setTasks] = useState<Task[]>([])
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const loadTasks = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const url = statusFilter
        ? `/api/tasks?status=${encodeURIComponent(statusFilter)}`
        : '/api/tasks'
      const res = await fetch(url)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load tasks')
      }
      const data = await res.json()
      setTasks(data.tasks ?? [])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    loadTasks()
  }, [loadTasks])

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      {/* Page header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-foreground">Tasks</h1>
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value ?? '')}
        >
          <SelectTrigger
            aria-label="Filter tasks by status"
            className="w-44"
          >
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
          <span className="text-sm text-muted-foreground">Loading tasks…</span>
        </div>
      )}

      {/* Error state */}
      {!loading && fetchError !== null && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {fetchError}
          <button
            onClick={loadTasks}
            className="ml-2 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && fetchError === null && tasks.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <ListTodoIcon className="size-10 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            {statusFilter
              ? `No tasks with status "${statusLabel(statusFilter)}".`
              : 'No tasks yet. Create a task from a project page.'}
          </p>
        </div>
      )}

      {/* Tasks table */}
      {!loading && tasks.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm" aria-label="Tasks">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-xs text-muted-foreground uppercase tracking-wide">
                <th scope="col" className="px-4 py-3 text-left font-medium">Title</th>
                <th scope="col" className="hidden px-4 py-3 text-left font-medium sm:table-cell">Project</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Status</th>
                <th scope="col" className="hidden px-4 py-3 text-left font-medium md:table-cell">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  onClick={() => router.push(`/dashboard/tasks/${task.id}`)}
                  className="cursor-pointer transition-colors hover:bg-muted/50 focus-within:bg-muted/50"
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => router.push(`/dashboard/tasks/${task.id}`)}
                      className="truncate text-left font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Open task: ${task.title}`}
                    >
                      {task.title}
                    </button>
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                    <span className="block max-w-48 truncate text-xs">
                      {task.projectName ?? task.projectId.slice(0, 8)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <RunningStatusBadge status={task.status} />
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">
                    {formatDate(task.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
