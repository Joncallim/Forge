/**
 * Issue-form round-trip tests.
 *
 * Verifies that the exact Markdown bodies produced by GitHub issue forms
 * (Feature, Bug, Other, Epic) pass through the production structural
 * validator and control-metadata parser correctly.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateIssue } from '@/scripts/github-agent-workflow/core/issue-validation'
import { parseControlMetadata } from '@/scripts/github-agent-workflow/core/issue-control'
import { evaluateReadiness, type ResolvedDependencyFact } from '@/scripts/github-agent-workflow/core/issue-readiness'

const FIXTURE_DIR = path.join(process.cwd(), '__tests__', '__fixtures__', 'github-agent-workflow')

async function readFixture(name: string): Promise<string> {
  return await readFile(path.join(FIXTURE_DIR, name), 'utf8')
}

describe('issue form round-trip', () => {
  describe('Feature form with canonical control metadata', () => {
    it('parses and validates a new Feature with no dependencies', async () => {
      const body = await readFixture('feature-form-with-control-rendered.md')
      const title = '[FEATURE] Feature with control metadata'

      // Structural validation
      const structural = validateIssue({ number: 1, title, body })
      expect(structural.valid).toBe(true)
      expect(structural.issueType).toBe('feature')

      // Control metadata parsing
      const control = parseControlMetadata(body, 'feature')
      expect(control.metadata.executionMode).toBe('implementation')
      expect(control.metadata.dependencies).toEqual([])
      expect(control.metadata.dependsOnNone).toBe(true)
      expect(control.metadata.explicit).toBe(true)
      expect(control.errors).toEqual([])

      // Readiness evaluation
      const readiness = evaluateReadiness({
        issueNumber: 1,
        issueState: 'open',
        issueType: 'feature',
        controlMetadata: control.metadata,
        structuralValid: true,
        structuralErrors: [],
        dependencyFacts: [],
        hasCycle: false,
        graphLimitExceeded: false,
        bodyTooLarge: false,
      })
      expect(readiness.dispatchable).toBe(true)
      expect(readiness.state).toBe('ready')
      expect(readiness.desiredReadinessLabels).toContain('ready-for-agent')
    })

    it('parses dependencies from form input', async () => {
      const body = await readFixture('feature-form-with-dependencies-rendered.md')
      const title = '[FEATURE] Feature with dependencies'

      const structural = validateIssue({ number: 2, title, body })
      expect(structural.valid).toBe(true)

      const control = parseControlMetadata(body, 'feature')
      expect(control.metadata.executionMode).toBe('implementation')
      expect(control.metadata.dependencies).toEqual([123, 456])
      expect(control.metadata.dependsOnNone).toBe(false)
      expect(control.errors).toEqual([])
    })

    it('detects an open dependency as blocked', async () => {
      const body = await readFixture('feature-form-with-dependencies-rendered.md')
      const control = parseControlMetadata(body, 'feature')

      const depFacts: ResolvedDependencyFact[] = [
        { issueNumber: 123, state: 'open', reasonCode: 'queue.issue_dependency_open' },
        { issueNumber: 456, state: 'closed_completed', reasonCode: 'queue.issue_dependency_open' },
      ]

      const readiness = evaluateReadiness({
        issueNumber: 2,
        issueState: 'open',
        issueType: 'feature',
        controlMetadata: control.metadata,
        structuralValid: true,
        structuralErrors: [],
        dependencyFacts: depFacts,
        hasCycle: false,
        graphLimitExceeded: false,
        bodyTooLarge: false,
      })
      expect(readiness.dispatchable).toBe(false)
      expect(readiness.state).toBe('dependency-blocked')
      expect(readiness.desiredReadinessLabels).toContain('dependency-blocked')
    })
  })

  describe('Bug form with canonical control metadata', () => {
    it('parses and validates a Bug with control metadata', async () => {
      const body = await readFixture('bug-form-with-control-rendered.md')
      const title = '[BUG] Bug with control metadata'

      const structural = validateIssue({ number: 3, title, body })
      expect(structural.valid).toBe(true)
      expect(structural.issueType).toBe('bug')

      const control = parseControlMetadata(body, 'bug')
      expect(control.metadata.executionMode).toBe('implementation')
      expect(control.metadata.dependencies).toEqual([])
      expect(control.metadata.dependsOnNone).toBe(true)
      expect(control.errors).toEqual([])

      const readiness = evaluateReadiness({
        issueNumber: 3,
        issueState: 'open',
        issueType: 'bug',
        controlMetadata: control.metadata,
        structuralValid: true,
        structuralErrors: [],
        dependencyFacts: [],
        hasCycle: false,
        graphLimitExceeded: false,
        bodyTooLarge: false,
      })
      expect(readiness.dispatchable).toBe(true)
      expect(readiness.state).toBe('ready')
    })
  })

  describe('Other form with canonical control metadata', () => {
    it('parses and validates an Other issue with control metadata', async () => {
      const body = await readFixture('other-form-with-control-rendered.md')
      const title = '[OTHER] Other with control metadata'

      const structural = validateIssue({ number: 4, title, body })
      expect(structural.valid).toBe(true)
      expect(structural.issueType).toBe('other')

      const control = parseControlMetadata(body, 'other')
      expect(control.metadata.executionMode).toBe('implementation')
      expect(control.metadata.dependencies).toEqual([])
      expect(control.errors).toEqual([])
    })
  })

  describe('Epic form with canonical control metadata', () => {
    it('parses and validates an Epic with tracking metadata', async () => {
      const body = await readFixture('epic-form-with-control-rendered.md')
      const title = '[EPIC] Epic with control metadata'

      const structural = validateIssue({ number: 5, title, body })
      expect(structural.valid).toBe(true)
      expect(structural.issueType).toBe('epic')

      const control = parseControlMetadata(body, 'epic')
      expect(control.metadata.executionMode).toBe('tracking')
      expect(control.metadata.dependencies).toEqual([])
      expect(control.metadata.dependsOnNone).toBe(true)
      expect(control.errors).toEqual([])

      // Tracking Epics are never dispatchable
      const readiness = evaluateReadiness({
        issueNumber: 5,
        issueState: 'open',
        issueType: 'epic',
        controlMetadata: control.metadata,
        structuralValid: true,
        structuralErrors: [],
        dependencyFacts: [],
        hasCycle: false,
        graphLimitExceeded: false,
        bodyTooLarge: false,
      })
      expect(readiness.dispatchable).toBe(false)
      expect(readiness.state).toBe('tracking-only')
      expect(readiness.desiredReadinessLabels).toContain('tracking-only')
    })
  })

  describe('no form produces immediate needs-clarification solely from metadata shape', () => {
    it('handles Feature with tracking mode explicitly', async () => {
      const body = [
        '# [FEATURE] Tracking feature',
        '',
        '### Forge Control Metadata',
        '',
        'Execution mode: tracking',
        'Depends on: none',
        '',
        '### Problem Statement',
        'Test',
        '### Desired Outcome',
        'Test',
        '### User Story',
        'Test',
        '### Requirements',
        '- Req',
        '### Acceptance Criteria',
        '- [ ] AC',
        '### Implementation Scope',
        'Small',
      ].join('\n')

      const control = parseControlMetadata(body, 'feature')
      expect(control.metadata.executionMode).toBe('tracking')
      expect(control.errors).toEqual([])

      const structural = validateIssue({ number: 6, title: '[FEATURE] Tracking feature', body })
      expect(structural.valid).toBe(true)

      const readiness = evaluateReadiness({
        issueNumber: 6,
        issueState: 'open',
        issueType: 'feature',
        controlMetadata: control.metadata,
        structuralValid: true,
        structuralErrors: [],
        dependencyFacts: [],
        hasCycle: false,
        graphLimitExceeded: false,
        bodyTooLarge: false,
      })
      expect(readiness.dispatchable).toBe(false)
      expect(readiness.state).toBe('tracking-only')
    })

    it('rejects invalid execution mode', async () => {
      const body = [
        '# [FEATURE] Bad mode',
        '',
        'Execution mode: invalid_mode',
        'Depends on: none',
        '',
        '### Problem Statement',
        'Test',
      ].join('\n')

      const control = parseControlMetadata(body, 'feature')
      expect(control.metadata.executionMode).toBeNull()
      expect(control.errors.length).toBeGreaterThan(0)
      expect(control.errors[0]).toContain('Invalid execution mode')
    })
  })
})
