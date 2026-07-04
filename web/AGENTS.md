<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Forge UI Skill Routing

When a task touches `web/app`, `web/components`, `web/hooks`, `web/app/globals.css`,
or any rendered dashboard/login/settings/provider surface, check for a relevant
Codex skill before implementing.

Use these by default when they fit:

- `build-web-apps:shadcn` for shadcn/base-ui component work, registries, forms,
  dialogs, tables, navigation, and dashboard composition.
- `build-web-apps:frontend-testing-debugging` for rendered UI verification,
  layout regressions, responsiveness, interaction bugs, and browser QA.
- `build-web-apps:react-best-practices` for React 19 / Next App Router patterns,
  server-client boundaries, state flow, and performance-sensitive decisions.
- `uncodixfy` when shaping new UI so Forge stays operator-focused instead of
  drifting into generic AI SaaS patterns.
- `ckm:ui-styling` or `product-design:audit` when reworking a whole user flow or
  dashboard section rather than patching a single component.
- `excalidraw-diagram` before major IA or workflow changes when a quick visual
  model would reduce ambiguity.

Prefer the current local stack over generic examples:

- Next.js App Router under `web/app`
- shadcn with `base-nova`
- Base UI primitives where already present
- Tailwind CSS v4 tokens in `web/app/globals.css`

For current docs and registries, prefer:

- `context7` for current Next.js, React, Tailwind, and library docs
- `shadcn` MCP for registry browsing and component install/search workflows
- `playwright` MCP for browser validation
