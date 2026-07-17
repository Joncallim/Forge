import { resetState } from './helpers'

export default async function globalTeardown(): Promise<void> {
  // Protocol migration/concurrency suites run against an explicitly disposable
  // database where the Step 0 hard-delete guard is part of the assertion. Do
  // not weaken or drop that production guard just to make generic cleanup pass.
  if (process.env.RUN_FORGE_POSTGRES_TESTS === '1') return
  await resetState()
}
