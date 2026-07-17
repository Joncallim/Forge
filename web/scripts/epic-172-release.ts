import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import {
  activateEpic172ReleaseSigner,
  installEpic172ReleaseSigner,
  recordEpic172ReleaseEvidence,
  recordEpic172TransitionAuthorization,
} from '../lib/mcps/epic-172-release-recorder'
import {
  epic172EnvelopeDigest,
  epic172ReleaseEvidenceSignedBytes,
  epic172TransitionAuthorizationSignedBytes,
  parseEpic172ReleaseEvidenceEnvelope,
  parseEpic172TransitionAuthorizationEnvelope,
} from '../lib/mcps/epic-172-release-verifier'

const WRITER_DATABASE_URL = 'FORGE_EPIC_172_EVIDENCE_DATABASE_URL'
const ADMIN_DATABASE_URL = 'FORGE_EPIC_172_ADMIN_DATABASE_URL'
const MAX_INPUT_BYTES = 128 * 1024

type Command =
  | 'activate-signer'
  | 'inspect'
  | 'install-signer'
  | 'prepare-authorization'
  | 'prepare-evidence'
  | 'record-authorization'
  | 'record-evidence'

export type Epic172ReleaseCli = Readonly<{
  command: Command
  options: Readonly<Record<string, string>>
}>

type SignedEnvelopeFile = Readonly<{
  envelope: unknown
  envelopeDigest: string
  detachedSignature: Uint8Array
}>

const commandOptions: Readonly<Record<Command, readonly string[]>> = {
  'activate-signer': ['actor', 'key-id', 'reason'],
  inspect: [],
  'install-signer': [
    'actor',
    'generation',
    'github-app-id',
    'key-id',
    'public-key',
    'reason',
    'ruleset-fingerprint',
    'valid-from',
    'valid-until',
  ],
  'prepare-authorization': ['input'],
  'prepare-evidence': ['input'],
  'record-authorization': ['input'],
  'record-evidence': ['input'],
}

function usage(): string {
  return `Epic 172 release bridge

The external signer creates signed JSON files. Forge never accepts a private key.

Commands:
  inspect
  install-signer --key-id UUID --generation N --public-key FILE --github-app-id ID \\
    --ruleset-fingerprint SHA256 --valid-from ISO --valid-until ISO --actor ID --reason TEXT
  activate-signer --key-id UUID --actor ID --reason TEXT
  prepare-evidence --input ENVELOPE_JSON
  prepare-authorization --input ENVELOPE_JSON
  record-evidence --input SIGNED_JSON
  record-authorization --input SIGNED_JSON

Environment:
  ${WRITER_DATABASE_URL}   dedicated forge_release_evidence_writer URL
  ${ADMIN_DATABASE_URL}     administrative read-only inspection URL

SIGNED_JSON has exactly: envelope, envelopeDigest, detachedSignatureBase64.`
}

export function parseEpic172ReleaseCliArgs(argv: readonly string[]): Epic172ReleaseCli {
  const [commandValue, ...rest] = argv
  if (!commandValue || commandValue === '--help' || commandValue === '-h') {
    throw new Error(usage())
  }
  if (!(commandValue in commandOptions)) throw new Error(`Unknown command: ${commandValue}\n\n${usage()}`)
  const command = commandValue as Command
  const allowed = new Set(commandOptions[command])
  const options: Record<string, string> = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Every ${command} option must use --name VALUE.`)
    }
    const name = flag.slice(2)
    if (!allowed.has(name)) throw new Error(`Unknown ${command} option: --${name}.`)
    if (name in options) throw new Error(`Duplicate ${command} option: --${name}.`)
    options[name] = value
  }
  for (const name of allowed) {
    if (!(name in options)) throw new Error(`Missing required ${command} option: --${name}.`)
  }
  return { command, options }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const contents = await readFile(path)
  if (contents.byteLength === 0 || contents.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`Input files must contain 1..${MAX_INPUT_BYTES} bytes.`)
  }
  return contents
}

function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The signed input must be a JSON object.')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`The signed input must contain exactly: ${keys.join(', ')}.`)
  }
  return record
}

export function decodeEpic172SignedEnvelope(value: unknown): SignedEnvelopeFile {
  const record = closedObject(value, ['detachedSignatureBase64', 'envelope', 'envelopeDigest'])
  if (typeof record.envelopeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.envelopeDigest)) {
    throw new Error('envelopeDigest must be a lowercase SHA-256 hex digest.')
  }
  if (
    typeof record.detachedSignatureBase64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(record.detachedSignatureBase64)
  ) {
    throw new Error('detachedSignatureBase64 must be one canonical 64-byte signature.')
  }
  const detachedSignature = Buffer.from(record.detachedSignatureBase64, 'base64')
  if (
    detachedSignature.byteLength !== 64
    || detachedSignature.toString('base64') !== record.detachedSignatureBase64
  ) {
    throw new Error('detachedSignatureBase64 must be one canonical 64-byte signature.')
  }
  return {
    envelope: record.envelope,
    envelopeDigest: record.envelopeDigest,
    detachedSignature,
  }
}

async function readSignedEnvelope(path: string): Promise<SignedEnvelopeFile> {
  const contents = await readBoundedFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(contents.toString('utf8'))
  } catch {
    throw new Error('The signed input must be valid UTF-8 JSON.')
  }
  return decodeEpic172SignedEnvelope(parsed)
}

async function readJson(path: string): Promise<unknown> {
  const contents = await readBoundedFile(path)
  try {
    return JSON.parse(contents.toString('utf8'))
  } catch {
    throw new Error('The input must be valid UTF-8 JSON.')
  }
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('generation must be a positive integer.')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('generation must be a positive safe integer.')
  return parsed
}

function parseDate(value: string, name: string): Date {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${name} must be an exact ISO-8601 UTC timestamp.`)
  }
  return parsed
}

async function inspectReleaseBridge(): Promise<boolean> {
  const sql = postgres(requiredEnvironment(ADMIN_DATABASE_URL), { max: 1, debug: false, onnotice: () => {} })
  try {
    const [enablement] = await sql<{ state: string; stateFingerprint: string }[]>`
      select state, state_fingerprint as "stateFingerprint"
      from public.forge_epic_172_enablement_state
      where singleton_id = 'epic-172'
    `
    const [retention] = await sql<{ constraintCount: number }[]>`
      select count(*)::int as "constraintCount"
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_namespace namespace_row
        on namespace_row.oid = constraint_row.connamespace
      where namespace_row.nspname = 'public'
        and constraint_row.contype = 'f'
        and constraint_row.confdeltype = 'r'
    `
    const [trigger] = await sql<{ enabled: boolean }[]>`
      select (trigger_row.tgenabled <> 'D') as enabled
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_class table_row on table_row.oid = trigger_row.tgrelid
      where table_row.relname = 'projects'
        and trigger_row.tgname = 'forge_epic_172_projects_no_hard_delete'
        and not trigger_row.tgisinternal
    `
    const roles = await sql<{ role: string; canLogin: boolean; inherits: boolean }[]>`
      select rolname as role, rolcanlogin as "canLogin", rolinherit as inherits
      from pg_catalog.pg_roles
      where rolname = any(${sql.array([
        'forge_release_routines_owner',
        'forge_release_evidence_writer',
        'forge_release_evidence_consumer',
        'forge_release_transition',
      ])}::text[])
      order by rolname
    `
    const [receipt] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from public.forge_epic_172_release_evidence
      where evidence_kind = 'step0_retention_bridge'
        and owner_issue = 179
        and owner_slice = 'step0'
        and predecessor_receipt_ids = '[]'::jsonb
    `
    const roleMap = new Map(roles.map((role) => [role.role, role]))
    const principalsReady = roleMap.get('forge_release_routines_owner')?.canLogin === false
      && roleMap.get('forge_release_routines_owner')?.inherits === false
      && ['forge_release_evidence_writer', 'forge_release_evidence_consumer', 'forge_release_transition']
        .every((role) => roleMap.get(role)?.canLogin === true && roleMap.get(role)?.inherits === false)
    const ready = enablement?.state === 'disabled'
      && (retention?.constraintCount ?? 0) >= 43
      && trigger?.enabled === true
      && principalsReady
    process.stdout.write(`${JSON.stringify({
      ready,
      enablement,
      restrictForeignKeys: retention?.constraintCount ?? 0,
      projectHardDeleteGuard: trigger?.enabled === true,
      principals: roles,
      step0ReceiptCount: receipt?.count ?? 0,
    }, null, 2)}\n`)
    return ready
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function runEpic172ReleaseCli(cli: Epic172ReleaseCli): Promise<number> {
  if (cli.command === 'inspect') return (await inspectReleaseBridge()) ? 0 : 2
  if (cli.command === 'prepare-evidence' || cli.command === 'prepare-authorization') {
    const rawEnvelope = await readJson(cli.options.input)
    const envelope = cli.command === 'prepare-evidence'
      ? parseEpic172ReleaseEvidenceEnvelope(rawEnvelope)
      : parseEpic172TransitionAuthorizationEnvelope(rawEnvelope)
    const signedBytes = cli.command === 'prepare-evidence'
      ? epic172ReleaseEvidenceSignedBytes(envelope)
      : epic172TransitionAuthorizationSignedBytes(envelope)
    process.stdout.write(`${JSON.stringify({
      envelope,
      envelopeDigest: epic172EnvelopeDigest(envelope),
      signingPayloadBase64: signedBytes.toString('base64'),
    }, null, 2)}\n`)
    return 0
  }
  const databaseUrl = requiredEnvironment(WRITER_DATABASE_URL)
  if (cli.command === 'install-signer') {
    const keyBytes = await readBoundedFile(cli.options['public-key'])
    const publicKey = createPublicKey(keyBytes.toString('utf8').includes('BEGIN PUBLIC KEY')
      ? keyBytes
      : { key: keyBytes, format: 'der', type: 'spki' })
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('public-key must be an Ed25519 public key.')
    const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' })
    const signerKeyId = await installEpic172ReleaseSigner({
      databaseUrl,
      signerKeyId: cli.options['key-id'],
      generation: parsePositiveInteger(cli.options.generation),
      publicKeySpki,
      githubAppId: cli.options['github-app-id'],
      rulesetFingerprint: cli.options['ruleset-fingerprint'],
      validFrom: parseDate(cli.options['valid-from'], 'valid-from'),
      validUntil: parseDate(cli.options['valid-until'], 'valid-until'),
      actor: cli.options.actor,
      reason: cli.options.reason,
    })
    process.stdout.write(`${JSON.stringify({ signerKeyId, status: 'installed' })}\n`)
    return 0
  }
  if (cli.command === 'activate-signer') {
    const signerKeyId = await activateEpic172ReleaseSigner({
      databaseUrl,
      signerKeyId: cli.options['key-id'],
      actor: cli.options.actor,
      reason: cli.options.reason,
    })
    process.stdout.write(`${JSON.stringify({ signerKeyId, status: 'active' })}\n`)
    return 0
  }
  const signed = await readSignedEnvelope(cli.options.input)
  if (cli.command === 'record-evidence') {
    const result = await recordEpic172ReleaseEvidence({ databaseUrl, ...signed })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  }
  const result = await recordEpic172TransitionAuthorization({ databaseUrl, ...signed })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2)
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      process.stdout.write(`${usage()}\n`)
      return
    }
    process.exitCode = await runEpic172ReleaseCli(parseEpic172ReleaseCliArgs(argv))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Epic 172 release command failed.'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
