/**
 * Canonical FORGE identity geometry.
 *
 * Keep production components and generated assets on these coordinates. The
 * 120 x 120 system is intentionally integer-heavy so the mark stays crisp at
 * small sizes and generated files remain deterministic.
 */
export const FORGE_VIEW_BOX_SIZE = 120
export const FORGE_VIEW_BOX = `0 0 ${FORGE_VIEW_BOX_SIZE} ${FORGE_VIEW_BOX_SIZE}`

/** One mechanical module, authored once at twelve o'clock. */
export const FORGE_MODULE_PATH =
  'M49 10H71L80 27L75 39L66 35H54L45 39L40 27L49 10Z'

/** One spoke from the assembled module ring to the orchestration core. */
export const FORGE_TRACE_PATH = 'M60 38V45'

/** A chamfered processor package and its orchestration die. */
export const FORGE_CORE_PATH = 'M49 44H71L76 49V71L71 76H49L44 71V49L49 44Z'
export const FORGE_CORE_INSET_PATH =
  'M53 57V53H57M63 53H67V57M67 63V67H63M57 67H53V63'

/**
 * A narrow stepped channel removed from the upper-left module junctions.
 * It suggests an F only after the viewer notices the negative space; it is
 * never rendered as a foreground letter.
 */
export const FORGE_NEGATIVE_SPACE_PATH =
  'M52.5 29H58V30H53.5V46H57V47H53.5V66H52.5V29Z'

export const FORGE_MODULE_ROTATIONS = [0, 60, 120, 180, 240, 300] as const

export type ForgeAppearance = 'default' | 'monochrome' | 'light' | 'dark'
export type ForgeDetail = 'auto' | 'full' | 'simplified'

export function shouldSimplifyForgeDetails(
  size: number | string,
  detail: ForgeDetail = 'auto',
): boolean {
  if (detail === 'simplified') return true
  if (detail === 'full') return false
  if (typeof size === 'number') return size <= 20

  const pixelSize = /^\s*(\d+(?:\.\d+)?)px\s*$/i.exec(size)
  return pixelSize !== null && Number(pixelSize[1]) <= 20
}

export const FORGE_STATUSES = [
  'idle',
  'planning',
  'awaiting-approval',
  'executing',
  'reviewing',
  'completed',
  'failed',
  'disconnected',
] as const

export type ForgeStatus = (typeof FORGE_STATUSES)[number]

export const FORGE_STATUS_LABELS: Record<ForgeStatus, string> = {
  idle: 'Idle',
  planning: 'Planning',
  'awaiting-approval': 'Awaiting approval',
  executing: 'Executing',
  reviewing: 'Reviewing',
  completed: 'Completed',
  failed: 'Failed',
  disconnected: 'Disconnected',
}

export function isForgeStatus(value: unknown): value is ForgeStatus {
  return typeof value === 'string' && (FORGE_STATUSES as readonly string[]).includes(value)
}

export function normalizeForgeStatus(value: unknown): ForgeStatus {
  return isForgeStatus(value) ? value : 'idle'
}

export const FORGE_STATUS_CUE_PATHS: Partial<Record<ForgeStatus, string>> = {
  planning: 'M56 60H64M60 56V64',
  'awaiting-approval': 'M60 54V61M60 66V66.2',
  executing: 'M55 59.5A5 5 0 0 1 64 57M64 57V61',
  reviewing: 'M55 57H65M55 63H62',
  completed: 'M55 60L59 64L66 56',
  failed: 'M56 56L64 64M64 56L56 64',
  disconnected: 'M54 60H58M62 60H66',
}
