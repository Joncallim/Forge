import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// ACP JSON-RPC transport
//
// Shared line-delimited JSON-RPC framing over a spawned adapter's stdio.
// Used by both the readiness handshake (handshake.ts) and the session client
// (client.ts) so the wire protocol is implemented exactly once.
// ---------------------------------------------------------------------------

export type AcpSpawn = (command: string, args: string[]) => ReturnType<typeof spawn>

export const defaultAcpSpawn: AcpSpawn = (command, args) =>
  spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

export class AcpTransport {
  private readonly child: ReturnType<typeof spawn>
  private nextId = 1
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>()
  private closed = false

  constructor(command: string[], spawnFn: AcpSpawn = defaultAcpSpawn) {
    this.child = spawnFn(command[0], command.slice(1))

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf8').slice(0, 2000)
    })

    this.child.on('error', (err) => {
      this.rejectAllPending(new Error(`ACP adapter process error: ${err.message}`))
    })

    this.child.on('exit', (code) => {
      this.rejectAllPending(
        new Error(
          `ACP adapter exited unexpectedly (code ${code}).${
            this.stderrBuffer.trim() ? ` ${this.stderrBuffer.trim().slice(0, 300)}` : ''
          }`,
        ),
      )
    })

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8')
      const lines = this.stdoutBuffer.split('\n')
      this.stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) this.handleLine(line)
    })
  }

  /** Last 300 chars of stderr captured so far, for error messages. */
  get recentStderr(): string {
    return this.stderrBuffer.trim().slice(0, 300)
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return

    const message = parsed as {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { message?: string }
    }

    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'ACP adapter returned an error'))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string') {
      const handler = this.notificationHandlers.get(message.method)
      handler?.(message.params)
    }
  }

  private rejectAllPending(err: Error): void {
    if (this.closed) return
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
  }

  /** Sends a JSON-RPC request and resolves/rejects when the matching response arrives. */
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      const request = { jsonrpc: '2.0', id, method, params }
      this.child.stdin?.write(`${JSON.stringify(request)}\n`)
    })
  }

  /** Registers a handler for a one-way JSON-RPC notification (e.g. `session/update`). */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.child.kill()
    } catch {
      // Already exited.
    }
  }
}
