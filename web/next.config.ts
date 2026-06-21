import './lib/load-env'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Pin Turbopack's project root to this app directory. Without this, Next
  // infers the workspace root from the nearest lockfile and can pick a stray
  // lockfile in a parent/home directory, emitting a "inferred your workspace
  // root" warning and watching the wrong tree.
  turbopack: {
    root: process.cwd(),
  },
}

export default nextConfig
