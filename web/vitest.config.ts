import { defineConfig } from 'vitest/config'
import path from 'path'
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 10_000,
    exclude: ['e2e/**', 'node_modules/**', '.next/**', '**/*.uninstall-trash.*'],
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
})
