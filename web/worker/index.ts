import '../lib/load-env'
import { startWorker } from './runtime'

async function main(): Promise<void> {
  const handle = await startWorker('standalone')

  const requestShutdown = (signal: NodeJS.Signals) => {
    console.info(`[worker] Received ${signal}; shutting down after current task`)
    void handle.stop()
  }

  process.once('SIGINT', requestShutdown)
  process.once('SIGTERM', requestShutdown)

  await handle.done
}

main().catch(() => {
  process.exit(1)
})
