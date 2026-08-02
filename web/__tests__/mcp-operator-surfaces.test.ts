import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

describe('MCP operator presentation surfaces', () => {
  it('uses the shared presenter on task preview, package, project, and catalog surfaces', () => {
    const taskPage = source('../app/dashboard/tasks/[id]/page.tsx')
    const projectPage = source('../app/dashboard/projects/[id]/page.tsx')
    const catalogPage = source('../app/dashboard/mcps/page.tsx')

    expect(taskPage).toContain('admissionPresentationFromUnknown')
    expect(taskPage).toContain('<McpPresentation')
    expect(projectPage).toContain('projectMcpPresentationFromUnknown')
    expect(projectPage).toContain('<McpPresentation')
    expect(catalogPage).toContain('catalogMcpPresentation')
    expect(catalogPage).toContain('<McpPresentation')
  })

  it('keeps raw health errors and workspace paths out of MCP operator copy', () => {
    const projectPage = source('../app/dashboard/projects/[id]/page.tsx')
    const catalogPage = source('../app/dashboard/mcps/page.tsx')

    expect(projectPage).not.toContain('status.error')
    expect(projectPage).not.toContain('displayInstallPath')
    expect(catalogPage).not.toContain('workspaceMcpRootLabel')
    expect(catalogPage).not.toContain('font-mono text-sm text-muted-foreground break-all')
  })

  it('provides stable keyboard focus targets and mobile-preserving action order', () => {
    const taskPage = source('../app/dashboard/tasks/[id]/page.tsx')
    const projectPage = source('../app/dashboard/projects/[id]/page.tsx')
    const presentation = source('../components/mcps/McpPresentation.tsx')

    expect(taskPage).toContain('id={`filesystem-grant-${packageId}`}')
    expect(taskPage).toContain('id="task-plan-actions"')
    expect(projectPage).toContain('id="project-mcps-heading"')
    expect(projectPage).toContain('tabIndex={-1}')
    expect(presentation).toContain('role="group"')
    expect(presentation).toContain('presentation.actions.map')
    expect(presentation).not.toMatch(/\border-(?:reverse|last|first|\[)/u)
  })
})
