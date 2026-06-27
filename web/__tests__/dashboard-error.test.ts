import { describe, expect, it } from 'vitest'
import { isDevManifestError } from '@/app/dashboard/error'

describe('isDevManifestError', () => {
  it('recognizes the dev build-manifest ENOENT signature', () => {
    const error = new Error(
      "ENOENT: no such file or directory, open '/repo/web/.next/dev/server/app/dashboard/projects/page/build-manifest.json'",
    )
    expect(isDevManifestError(error)).toBe(true)
  })

  it('does not match unrelated ENOENT errors', () => {
    const error = new Error("ENOENT: no such file or directory, open '/some/other/file.json'")
    expect(isDevManifestError(error)).toBe(false)
  })

  it('does not match unrelated errors', () => {
    expect(isDevManifestError(new Error('Network request failed'))).toBe(false)
  })
})
