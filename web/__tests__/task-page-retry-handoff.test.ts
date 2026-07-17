import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
  useRouter: vi.fn(),
}))

vi.mock('@/hooks/useTaskStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskStream')>()
  return {
    ...actual,
    useTaskStream: vi.fn(),
  }
})

import {
  approvedGrantPackagesFromGate,
  buildReviewGateDecisionRequestBody,
  canDeleteTaskStatus,
  canRetryHandoffForTaskStatus,
  canStopTaskStatus,
  filesystemGrantExpectedPointerFromState,
  mergeTaskRuns,
  reviewDecisionSuggestionFromArtifact,
  retryHandoffMessage,
  sandboxOutputsForPackage,
  securityReviewPayloadFromMetadata,
  securityReviewSubmissionPayloadFromForm,
  taskProgressSummary,
  unresolvedRequiredFilesystemGrants,
  workforceExecutionSummary,
} from '@/app/dashboard/tasks/[id]/page'

describe('task page retry handoff controls', () => {
  it('omits a pointer for D1 and preserves the exact D1 tuple for D2 reapproval', () => {
    expect(filesystemGrantExpectedPointerFromState({
      currentDecision: null,
      pointerFingerprint: null,
      pointerVersion: '0',
      workPackageId: 'package-1',
    })).toBeNull()

    expect(filesystemGrantExpectedPointerFromState({
      currentDecision: {
        capabilities: ['filesystem.project.read'],
        decision: 'approved',
        grantDecisionRevision: '17',
        id: 'decision-d1',
        reason: 'Reviewed D1',
      },
      pointerFingerprint: 'sha256:d1',
      pointerVersion: '1',
      workPackageId: 'package-1',
    })).toEqual({
      currentDecisionId: 'decision-d1',
      currentDecisionRevision: '17',
      pointerFingerprint: 'sha256:d1',
      pointerVersion: '1',
    })
  })

  it('distinguishes newly queued and already queued retry responses', () => {
    expect(retryHandoffMessage('retry_enqueued')).toBe('Recovery queued. The worker will re-evaluate this handoff.')
    expect(retryHandoffMessage('retry_already_queued')).toBe('Recovery is already queued. The worker will re-evaluate this handoff.')
  })

  it('allows task-level handoff retry for approved and running tasks without blocked packages', () => {
    expect(canRetryHandoffForTaskStatus('approved', false)).toBe(true)
    expect(canRetryHandoffForTaskStatus('running', false)).toBe(true)
    expect(canRetryHandoffForTaskStatus('running', true)).toBe(false)
    expect(canRetryHandoffForTaskStatus('awaiting_review', false)).toBe(false)
  })

  it('shows stop only for active tasks and never offers deletion for non-terminal', () => {
    expect(canStopTaskStatus('running')).toBe(true)
    expect(canStopTaskStatus('approved')).toBe(true)
    expect(canStopTaskStatus('failed')).toBe(false)
    expect(canStopTaskStatus('cancelled')).toBe(false)
    expect(canDeleteTaskStatus('running')).toBe(false)
    expect(canDeleteTaskStatus('approved')).toBe(false)
    // Terminal tasks (including failed/cancelled) are deletable in S5
    expect(canDeleteTaskStatus('failed')).toBe(true)
    expect(canDeleteTaskStatus('cancelled')).toBe(true)
    expect(canDeleteTaskStatus('completed')).toBe(true)
  })

  it('finds required filesystem grants that still need explicit approval', () => {
    expect(unresolvedRequiredFilesystemGrants([{
      id: 'pkg-fs',
      status: 'pending',
      title: 'Frontend work package',
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      }],
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            status: 'not_issued',
          },
        },
      },
    }])).toEqual([{
      missingCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
      packageId: 'pkg-fs',
      title: 'Frontend work package',
    }])

    expect(unresolvedRequiredFilesystemGrants([{
      id: 'pkg-approved',
      status: 'pending',
      title: 'Approved package',
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      }],
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'approved',
            grants: [{
              mcpId: 'filesystem',
              status: 'approved',
              capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            }],
          },
        },
      },
    }])).toEqual([])

    expect(unresolvedRequiredFilesystemGrants([{
      id: 'pkg-project-approved',
      status: 'pending',
      title: 'Project approved package',
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      }],
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'project-filesystem-approval',
            runtimeEnforcement: 'bounded_context_packet',
            grantMode: 'always_allow',
            status: 'approved',
            grants: [{
              mcpId: 'filesystem',
              status: 'approved',
              capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            }],
          },
        },
      },
    }])).toEqual([])

    expect(unresolvedRequiredFilesystemGrants([{
      id: 'pkg-covered-by-project-grant',
      status: 'pending',
      title: 'Covered by saved project grant',
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      }],
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            status: 'not_issued',
          },
        },
      },
    }], {
      enabled: true,
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
    })).toEqual([])

    expect(unresolvedRequiredFilesystemGrants([{
      id: 'pkg-denied',
      status: 'pending',
      title: 'Denied package',
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      }],
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'explicit-grant-approval',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'denied',
            deniedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
          },
        },
      },
    }])).toEqual([])
  })

  it('surfaces blocked package progress instead of showing active handoff progress', () => {
    expect(taskProgressSummary({
      status: 'running',
      workPackages: [{
        id: 'pkg-blocked',
        status: 'blocked',
        title: 'Frontend work package',
        blockedReason: "MCP 'filesystem' has no approved capabilities for required access.",
      }],
      approvalGates: [],
      runs: [{ ...runBase, status: 'running', stage: 'handoff', workPackageId: 'pkg-blocked' }],
      questions: [],
      artifacts: [],
    })).toEqual({
      stage: 'Blocked: Frontend work package',
      nextAction: 'Resolve the block, then queue handoff recovery from the blocked package.',
      detail: "MCP 'filesystem' has no approved capabilities for required access.",
    })
  })
})

const packageBase = {
  id: 'pkg-1',
  status: 'ready',
  title: 'Frontend package',
}

const runBase = {
  id: 'run-1',
  taskId: 'task-1',
  agentType: 'frontend',
  modelIdUsed: 'model',
  status: 'completed',
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  startedAt: null,
  completedAt: null,
  errorMessage: null,
}

describe('task page Workforce beta presentation helpers', () => {
  it('distinguishes disabled handoff from failed sandbox execution metadata', () => {
    expect(workforceExecutionSummary({
      artifacts: [{
        id: 'artifact-disabled',
        agentRunId: 'run-handoff',
        artifactType: 'log_output',
        content: 'Forge handed off work package.\n\nRepository writes and specialist model execution are disabled for this handoff slice.',
        metadata: { repositoryWrites: false, source: 'work-package-handoff', workPackageId: 'pkg-1' },
        workPackageId: 'pkg-1',
      }],
      runs: [{ ...runBase, agentType: 'handoff', modelIdUsed: 'forge-handoff/no-op' }],
      workPackages: [packageBase],
    }).mode).toBe('disabled_handoff')

    expect(workforceExecutionSummary({
      artifacts: [{
        id: 'artifact-failed',
        agentRunId: 'run-failed',
        artifactType: 'log_output',
        content: 'Work package execution failed.',
        metadata: { repositoryWrites: false, source: 'work-package-executor', workPackageId: 'pkg-1' },
        workPackageId: 'pkg-1',
      }],
      runs: [],
      workPackages: [packageBase],
    }).mode).toBe('opt_in_sandbox')
  })

  it('reports running package execution and generated sandbox outputs', () => {
    expect(workforceExecutionSummary({
      artifacts: [],
      runs: [{ ...runBase, status: 'running', stage: 'implementation', workPackageId: 'pkg-1' }],
      workPackages: [{ ...packageBase, status: 'running' }],
    }).mode).toBe('running_package')

    const sandboxArtifact = {
      id: 'artifact-sandbox',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'Files written: 1',
      metadata: {
        commandResults: [{ command: ['npm', 'test'], exitCode: 0 }],
        files: ['src/app.tsx'],
        generatedBy: 'work-package-executor',
        sandboxPath: '/repo/.forge/task-runs/task-1/pkg-1',
        validationStatus: 'passed',
        workPackageId: 'pkg-1',
      },
      workPackageId: 'pkg-1',
    }

    expect(sandboxOutputsForPackage(packageBase, [sandboxArtifact])).toEqual([{
      artifactId: 'artifact-sandbox',
      commandCount: 1,
      fileCount: 1,
      files: ['src/app.tsx'],
      hostRepositoryWritePaths: [],
      hostRepositoryWrites: false,
      sandboxPath: '/repo/.forge/task-runs/task-1/pkg-1',
      validationStatus: 'passed',
    }])
    expect(workforceExecutionSummary({
      artifacts: [sandboxArtifact],
      runs: [],
      workPackages: [packageBase],
    }).mode).toBe('sandbox_output')
  })

  it('merges streamed runs with initial DB runs while preserving package execution fields', () => {
    expect(mergeTaskRuns([
      {
        ...runBase,
        id: 'run-db-package',
        attemptNumber: 2,
        stage: 'implementation',
        status: 'running',
        workPackageId: 'pkg-1',
      },
      {
        ...runBase,
        id: 'run-db-reviewer',
        agentType: 'reviewer',
        stage: 'review',
        workPackageId: 'pkg-2',
      },
    ], [
      {
        ...runBase,
        id: 'run-db-package',
        status: 'completed',
        outputTokens: 55,
      },
      {
        ...runBase,
        id: 'run-stream-new',
        stage: 'implementation',
        status: 'running',
        workPackageId: 'pkg-3',
      },
    ])).toMatchObject([
      {
        id: 'run-db-package',
        attemptNumber: 2,
        outputTokens: 55,
        stage: 'implementation',
        status: 'completed',
        workPackageId: 'pkg-1',
      },
      {
        id: 'run-db-reviewer',
        stage: 'review',
        workPackageId: 'pkg-2',
      },
      {
        id: 'run-stream-new',
        stage: 'implementation',
        status: 'running',
        workPackageId: 'pkg-3',
      },
    ])
  })

  it('extracts operator-approved grant snapshots from plan gate metadata chunks', () => {
    const packages = approvedGrantPackagesFromGate({
      id: 'gate-1',
      gateType: 'plan_approval',
      status: 'approved',
      metadata: {
        queryChunks: [
          JSON.stringify({
            approval: { approvedBy: 'user-1', source: 'task-approval' },
            mcpGrantPhases: {
              approved: {
                phase: 'approved',
                packages: [{
                  workPackageId: 'pkg-1',
                  assignedRole: 'backend',
                  proposedGrants: [{ mcpId: 'github', status: 'proposed' }],
                  promptOverlayPresent: true,
                }],
              },
            },
          }),
        ],
      },
    })

    expect(packages).toEqual([expect.objectContaining({
      assignedRole: 'backend',
      promptOverlayPresent: true,
      workPackageId: 'pkg-1',
    })])
  })

  it('normalizes structured security findings and explicit no-findings payloads', () => {
    expect(securityReviewPayloadFromMetadata({
      securityReview: {
        findings: [{
          description: 'Command argument is not constrained.',
          file: 'web/app/api/tasks/route.ts',
          line: 42,
          recommendation: 'Validate argv before execution.',
          severity: 'high',
          title: 'Unsafe command execution',
        }],
        summary: 'One high-risk issue.',
      },
    })).toMatchObject({
      findings: [{
        description: 'Command argument is not constrained.',
        location: 'web/app/api/tasks/route.ts:42',
        recommendation: 'Validate argv before execution.',
        severity: 'high',
        title: 'Unsafe command execution',
      }],
      state: 'findings',
      summary: 'One high-risk issue.',
    })

    expect(securityReviewPayloadFromMetadata({
      securityReview: {
        findings: [],
        summary: 'Security review completed without findings.',
      },
    })).toEqual({
      findings: [],
      state: 'no_findings',
      summary: 'Security review completed without findings.',
    })
  })

  it('renders SecurityFindingV1 payloads with actionable fields', () => {
    expect(securityReviewPayloadFromMetadata({
      securityReview: {
        schemaVersion: 1,
        verdict: 'findings',
        findings: [{
          reviewSurface: 'Sandbox execution',
          asset: 'web/worker/work-package-executor.ts',
          trustBoundary: 'Model output to sandbox filesystem',
          exploitPath: 'A generated path escapes the attempt directory.',
          impact: 'Host repository files could be overwritten.',
          requiredFix: 'Reject paths that resolve outside the sandbox root.',
          evidenceRefs: ['artifact-1', 'web/__tests__/work-package-executor.test.ts'],
          severity: 'critical',
          confidence: 'high',
          verificationState: 'Regression test added.',
        }],
        summary: 'One critical issue.',
      },
    })).toMatchObject({
      findings: [{
        description: expect.stringContaining('Host repository files could be overwritten.'),
        confidence: 'high',
        location: 'web/worker/work-package-executor.ts',
        recommendation: 'Reject paths that resolve outside the sandbox root.',
        severity: 'critical',
        status: 'Regression test added.',
        title: 'Sandbox execution',
      }],
      state: 'findings',
      summary: 'One critical issue.',
    })
  })

  it('prefills review gate comments from reviewer metadata when available', () => {
    expect(reviewDecisionSuggestionFromArtifact({
      gateType: 'reviewer_review',
      securityPayload: null,
      sourceArtifact: {
        id: 'artifact-review',
        agentRunId: 'run-review',
        artifactType: 'log_output',
        content: 'Fallback content',
        metadata: { reviewerComment: 'Use the reviewer finding as the decision reason.' },
        workPackageId: 'pkg-1',
      },
    })).toEqual({
      reason: 'Use the reviewer finding as the decision reason.',
      requiresHumanTradeoff: false,
    })
  })

  it.each(['high', 'critical'])('requires a human-written comment for %s security trade-offs', (severity) => {
    expect(reviewDecisionSuggestionFromArtifact({
      gateType: 'security_review',
      securityPayload: {
        findings: [{
          confidence: 'high',
          description: `${severity} command injection path.`,
          key: `${severity}-1`,
          location: 'web/api.ts',
          recommendation: 'Block untrusted shell input.',
          severity,
          status: '',
          title: 'Command injection',
        }],
        state: 'findings',
        summary: `${severity} issue.`,
      },
      sourceArtifact: null,
    })).toEqual({
      reason: '',
      requiresHumanTradeoff: true,
    })
  })

  it('builds structured no-findings security review payloads for security approvals', () => {
    const body = buildReviewGateDecisionRequestBody({
      action: 'approve',
      gateType: 'security_review',
      reason: 'Reviewed sandbox output and no security findings remain.',
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
    })

    expect(body.error).toBeNull()
    expect(body.body).toMatchObject({
      decision: 'completed',
      reason: 'Reviewed sandbox output and no security findings remain.',
      securityReview: {
        schemaVersion: 1,
        findings: [],
        noFindings: {
          evidenceRefs: ['11111111-1111-1111-1111-111111111111'],
          reviewSurface: 'Security review gate',
          verificationState: 'Reviewed sandbox output and no security findings remain.',
        },
        verdict: 'no_findings',
      },
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
    })
  })

  it('does not attach security review payloads to QA or reviewer gate decisions', () => {
    expect(buildReviewGateDecisionRequestBody({
      action: 'approve',
      gateType: 'qa_review',
      reason: 'QA passed.',
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
    }).body).not.toHaveProperty('securityReview')

    expect(buildReviewGateDecisionRequestBody({
      action: 'approve',
      gateType: 'reviewer_review',
      reason: 'Reviewer passed.',
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
    }).body).not.toHaveProperty('securityReview')
  })

  it('attaches structured security review payloads to security rework and reject decisions', () => {
    const securityReviewForm = {
      asset: 'web/worker/work-package-executor.ts',
      confidence: 'high',
      evidenceRefs: 'web/__tests__/work-package-executor.test.ts',
      exploitPath: 'A generated path escapes the attempt directory.',
      impact: 'Host repository files could be overwritten.',
      mode: 'finding' as const,
      requiredFix: 'Reject paths that resolve outside the sandbox root.',
      reviewSurface: 'Sandbox execution',
      severity: 'critical',
      trustBoundary: 'Model output to sandbox filesystem',
      verificationState: 'Regression test added.',
    }

    expect(buildReviewGateDecisionRequestBody({
      action: 'changes',
      gateType: 'security_review',
      reason: 'Fix the sandbox path guard.',
      securityReviewForm,
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
    }).body).toMatchObject({
      decision: 'needs_rework',
      securityReview: {
        findings: [{
          evidenceRefs: [
            '11111111-1111-1111-1111-111111111111',
            'web/__tests__/work-package-executor.test.ts',
          ],
          requiredFix: 'Reject paths that resolve outside the sandbox root.',
        }],
        verdict: 'findings',
      },
    })

    expect(buildReviewGateDecisionRequestBody({
      action: 'reject',
      gateType: 'security_review',
      reason: 'The sandbox path guard is still unsafe.',
      securityReviewForm,
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
    }).body).toMatchObject({
      decision: 'needs_rework',
      reason: 'Rejected: The sandbox path guard is still unsafe.',
      securityReview: {
        findings: [{
          evidenceRefs: [
            '11111111-1111-1111-1111-111111111111',
            'web/__tests__/work-package-executor.test.ts',
          ],
        }],
        verdict: 'findings',
      },
    })
  })

  it('rejects security approval bodies when the security form records findings', () => {
    const result = buildReviewGateDecisionRequestBody({
      action: 'approve',
      gateType: 'security_review',
      reason: 'Approving despite a finding.',
      securityReviewForm: {
        asset: 'web/worker/work-package-executor.ts',
        confidence: 'high',
        evidenceRefs: 'artifact-1',
        exploitPath: 'A generated path escapes the attempt directory.',
        impact: 'Host repository files could be overwritten.',
        mode: 'finding',
        requiredFix: 'Reject paths that resolve outside the sandbox root.',
        reviewSurface: 'Sandbox execution',
        severity: 'critical',
        trustBoundary: 'Model output to sandbox filesystem',
        verificationState: 'Regression test added.',
      },
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
    })

    expect(result.body).toBeNull()
    expect(result.error).toMatch(/requesting changes/i)
  })

  it('rejects security rework bodies unless the security form records a structured finding', () => {
    const result = buildReviewGateDecisionRequestBody({
      action: 'changes',
      gateType: 'security_review',
      reason: 'Needs security rework.',
      securityReviewForm: {
        asset: '',
        confidence: 'medium',
        evidenceRefs: 'artifact-1',
        exploitPath: '',
        impact: '',
        mode: 'no_findings',
        requiredFix: '',
        reviewSurface: 'Security review gate',
        severity: 'medium',
        trustBoundary: '',
        verificationState: '',
      },
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
    })

    expect(result.body).toBeNull()
    expect(result.error).toMatch(/structured finding/i)
  })

  it('keeps the current source artifact id in security evidence after the source changes', () => {
    const result = securityReviewSubmissionPayloadFromForm({
      fallbackVerification: 'Reviewed the new artifact.',
      form: {
        asset: '',
        confidence: 'medium',
        evidenceRefs: 'old-source-artifact, web/__tests__/security-review.test.ts',
        exploitPath: '',
        impact: '',
        mode: 'no_findings',
        requiredFix: '',
        reviewSurface: 'Security review gate',
        severity: 'medium',
        trustBoundary: '',
        verificationState: '',
      },
      sourceArtifactId: 'new-source-artifact',
    })

    expect(result.error).toBeNull()
    expect(result.payload?.noFindings?.evidenceRefs).toEqual([
      'new-source-artifact',
      'old-source-artifact',
      'web/__tests__/security-review.test.ts',
    ])
  })

  it('builds bounded structured finding payloads for security approvals', () => {
    const result = securityReviewSubmissionPayloadFromForm({
      fallbackVerification: 'Reviewed exploitability.',
      form: {
        asset: 'web/worker/work-package-executor.ts',
        confidence: 'high',
        evidenceRefs: 'artifact-1, web/__tests__/work-package-executor.test.ts',
        exploitPath: 'A generated path escapes the attempt directory.',
        impact: 'Host repository files could be overwritten.',
        mode: 'finding',
        requiredFix: 'Reject paths that resolve outside the sandbox root.',
        reviewSurface: 'Sandbox execution',
        severity: 'critical',
        trustBoundary: 'Model output to sandbox filesystem',
        verificationState: 'Regression test added.',
      },
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
    })

    expect(result.error).toBeNull()
    expect(result.payload).toMatchObject({
      schemaVersion: 1,
      findings: [{
        asset: 'web/worker/work-package-executor.ts',
        confidence: 'high',
        evidenceRefs: [
          '11111111-1111-1111-1111-111111111111',
          'artifact-1',
          'web/__tests__/work-package-executor.test.ts',
        ],
        exploitPath: 'A generated path escapes the attempt directory.',
        impact: 'Host repository files could be overwritten.',
        requiredFix: 'Reject paths that resolve outside the sandbox root.',
        reviewSurface: 'Sandbox execution',
        severity: 'critical',
        trustBoundary: 'Model output to sandbox filesystem',
        verificationState: 'Regression test added.',
      }],
      verdict: 'findings',
    })
  })
})
