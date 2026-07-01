import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import path from 'node:path'
import { redactAdapterMessage } from './redaction'

// ---------------------------------------------------------------------------
// ACP JSON-RPC transport
//
// Shared line-delimited JSON-RPC framing over a spawned adapter's stdio.
// Used by both the readiness handshake (handshake.ts) and the session client
// (client.ts) so the wire protocol is implemented exactly once.
// ---------------------------------------------------------------------------

export type AcpSpawn = (
  command: string,
  args: string[],
  options?: SpawnOptionsWithoutStdio,
) => ReturnType<typeof spawn>

const ACP_ADAPTER_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'CI',
  'CODEX_HOME',
  'ComSpec',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'ProgramFiles',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
])
const MAX_RECENT_STDERR_CHARS = 4000

export function buildAcpAdapterEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const adapterEnv: Record<string, string> = {}
  for (const key of ACP_ADAPTER_ENV_ALLOWLIST) {
    const value = env[key]
    if (value !== undefined) adapterEnv[key] = value
  }
  return adapterEnv
}

export function buildAcpSpawnOptions(input: { cwd?: string | null } = {}): SpawnOptionsWithoutStdio {
  const packageRoot = process.cwd()
  const spawnCwd = input.cwd?.trim() || packageRoot
  const localBin = path.join(/*turbopackIgnore: true*/ packageRoot, 'node_modules', '.bin')
  const env = buildAcpAdapterEnv()
  env.PATH = env.PATH ? `${localBin}${path.delimiter}${env.PATH}` : localBin
  return {
    cwd: spawnCwd,
    env: env as NodeJS.ProcessEnv,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }
}

export const defaultAcpSpawn: AcpSpawn = (command, args, options = buildAcpSpawnOptions()) =>
  spawn(command, args, options)

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

  constructor(
    command: string[],
    spawnFn: AcpSpawn = defaultAcpSpawn,
    spawnOptions: SpawnOptionsWithoutStdio = buildAcpSpawnOptions(),
  ) {
    this.child = spawnFn(command[0], command.slice(1), spawnOptions)

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuffer = (this.stderrBuffer + chunk.toString('utf8')).slice(-MAX_RECENT_STDERR_CHARS)
    })

    this.child.on('error', (err) => {
      this.rejectAllPending(new Error(`ACP adapter process error: ${err.message}`))
    })

    this.child.on('exit', (code) => {
      this.rejectAllPending(
        new Error(
          `ACP adapter exited unexpectedly (code ${code}).${
            this.stderrBuffer.trim() ? ` ${redactAdapterMessage(this.stderrBuffer.trim())}` : ''
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

  /** Bounded recent stderr captured so far, for error messages. */
  get recentStderr(): string {
    return redactAdapterMessage(this.stderrBuffer.trim())
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
