/**
 * Reason-code registry contract test.
 *
 * Prevents accidental deletion or renaming of stable readiness reason codes.
 * The full list is defined in contracts/issue-readiness-result.ts.
 */

import { describe, expect, it } from 'vitest'
import { READINESS_REASON_CODES } from '@/scripts/github-agent-workflow/contracts/issue-readiness-result'

describe('readiness reason code registry', () => {
  it('contains exactly the required queue.* codes', () => {
    // All codes from #354 and its mandatory comments
    const expected = [
      'queue.issue_template_invalid',
      'queue.issue_control_missing',
      'queue.issue_control_duplicate',
      'queue.issue_execution_mode_invalid',
      'queue.issue_tracking_only',
      'queue.issue_closed',
      'queue.issue_dependency_syntax_invalid',
      'queue.issue_dependency_self',
      'queue.issue_dependency_duplicate',
      'queue.issue_dependency_is_pull_request',
      'queue.issue_dependency_tracking',
      'queue.issue_dependency_not_found',
      'queue.issue_dependency_open',
      'queue.issue_dependency_terminal_unsatisfied',
      'queue.issue_dependency_state_unknown',
      'queue.issue_dependency_inaccessible',
      'queue.issue_dependency_lookup_failed',
      'queue.issue_dependency_cycle',
      'queue.issue_dependency_graph_limit_exceeded',
      'queue.issue_body_too_large',
      'queue.issue_projection_update_failed',
    ]

    // Sort both for comparison
    const sortedExpected = [...expected].sort()
    const sortedActual = [...READINESS_REASON_CODES].sort()

    // Check that every expected code exists
    for (const code of sortedExpected) {
      expect(sortedActual).toContain(code)
    }

    // Check that the total count is correct
    expect(sortedActual.length).toBe(sortedExpected.length)

    // Exact match
    expect(sortedActual).toEqual(sortedExpected)
  })

  it('has no duplicate codes', () => {
    const unique = new Set(READINESS_REASON_CODES)
    expect(unique.size).toBe(READINESS_REASON_CODES.length)
  })

  it('uses stable dot-separated namespace', () => {
    for (const code of READINESS_REASON_CODES) {
      expect(code).toMatch(/^queue\.issue_[a-z_]+$/)
    }
  })
})
