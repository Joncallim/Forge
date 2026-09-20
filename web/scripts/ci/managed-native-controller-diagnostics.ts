export const NATIVE_AUTHORITY_LOST = 'Managed native controller lost its one reserved peer administrator connection; reconnect is forbidden.'

export function managedNativeControllerFailureMessage(connectionLost: boolean, error: unknown): string {
  return connectionLost ? NATIVE_AUTHORITY_LOST : error instanceof Error ? error.message : String(error)
}
