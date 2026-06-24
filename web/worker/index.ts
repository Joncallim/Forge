import '../lib/load-env'
import { startWorker } from './runtime'

async function main(): Promise<void> {
  const handle = await startWorker('standalone')
  console.info(
    '[worker] This process only runs background tasks — it does not serve HTTP. ' +
      'Run "npm run dev" in another terminal to reach http://localhost:3000.',
  )

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
