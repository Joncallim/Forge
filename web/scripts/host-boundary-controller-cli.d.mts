export function buildHostBoundaryControllerRequest(
  operation: string,
  argv: readonly string[],
): Readonly<Record<string, unknown>>
export function validateHostBoundaryControllerResponse(
  value: unknown,
  request: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>
