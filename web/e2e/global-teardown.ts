import '../lib/load-env'
import { resetState } from './helpers'

export default async function globalTeardown(): Promise<void> {
  await resetState()
}
