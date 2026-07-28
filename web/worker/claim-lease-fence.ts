const CLAIM_LEASE_LOST_MESSAGE = 'Queue claim lease ownership was lost.'

export class ClaimLeaseLostError extends Error {
  readonly code = 'claim_lease_lost'

  constructor() {
    super(CLAIM_LEASE_LOST_MESSAGE)
    this.name = 'ClaimLeaseLostError'
  }
}

export class ClaimLeaseFence {
  readonly #controller = new AbortController()
  #lost = false

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get lost(): boolean {
    return this.#lost
  }

  markLost(): boolean {
    if (this.#lost) return false
    this.#lost = true
    this.#controller.abort(new ClaimLeaseLostError())
    return true
  }

  assertOwned(): void {
    if (this.#lost) throw new ClaimLeaseLostError()
  }

  throwIfLost(): void {
    this.assertOwned()
  }
}

export function isClaimLeaseLostError(value: unknown): value is ClaimLeaseLostError {
  return value instanceof ClaimLeaseLostError
}
