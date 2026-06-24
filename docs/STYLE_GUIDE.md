# Documentation Style Guide

This is the canonical standard for `docs/` content in Forge. Every major doc is
layered so that a non-technical reader, an operator, and a developer can each
read exactly as far as they need and then stop — without the technical readers
losing any depth.

The goal is not to remove technical content. The goal is to structure it so the
right reader finds the right depth quickly.

## The Documentation Pyramid

Every major doc moves top-down through four layers, in this order. Each layer is
a skimmable `##` section, so a reviewer can check structure from the headers
alone.

### Layer 1 — Plain-English Summary

Answers: What is this? Why does it exist? When would I use it? What happens if I
use it?

No implementation detail. No jargon. A non-technical reader must be able to stop
here and be correct about what the thing is and why it matches a need.

### Layer 2 — Operational Understanding

Answers: How does it behave? What goes in, what comes out? What are the common
workflows, and what happens when something goes wrong operationally?

Lean on examples. A reader should learn how to *use* the thing without needing to
understand how it works inside. No internal mechanics here (queue names, state
machines, schemas) — those belong in Layer 3.

### Layer 3 — Technical Details

Answers: How does it actually work, and how would I modify it?

Architecture, components, data flow, agent interactions, configuration, APIs,
schemas, protocols, dependencies. This section must be technically complete. Do
not oversimplify and do not drop detail to make it shorter — depth lives here.

### Layer 4 — Reference Material

The lookup layer: exact names, file paths, config options, package scripts,
limits, edge cases, and links to deeper docs. This is the source of truth a
developer scans without re-reading prose.

## The Three Readers

Every doc serves three readers at once, and each should be able to stop reading
the moment their question is answered:

- **Reader A — Business user.** "What is this and why should I care?" Served by
  Layer 1.
- **Reader B — Operator.** "How do I run it and what should I expect?" Served by
  Layers 1–2.
- **Reader C — Developer.** "How does it work and how do I change it?" Served by
  all four layers.

If Reader A has to read past Layer 1 to understand the basic purpose, the doc has
failed. If Reader C cannot find a queue name or a file path, the doc has also
failed.

## Documentation Smells

Flag and fix a doc when it:

- **Starts with architecture** instead of value — opens on components or data
  flow before saying what the thing is for.
- **Leads with implementation** — the first paragraph describes *how* before
  *what* or *why*.
- **Assumes AI knowledge** — expects the reader to already know agents, MCP,
  context engineering, tool routing, or model selection.
- **Uses unexplained jargon** — drops "queue", "orchestrator stage",
  "dead-letter list", etc. into an early layer without defining it.
- **Uses academic or internal language** — corporate-manual tone, or internal
  code names used before they are introduced.
- **Explains mechanism before value** — describes the machinery before the
  reader knows why they would care.
- **Buries or loses technical detail** — over-simplified to the point that
  Reader C can no longer find what they need.

Complexity should be discoverable, not mandatory: never force a reader to
understand internal architecture before understanding what the thing does.

## Rewrite Process

When rewriting an existing doc, work in this order:

1. **Find the user value** — what does this thing do for a reader, in one
   sentence?
2. **Write the plain-English summary** — value first, zero jargon. This becomes
   Layer 1.
3. **Add operational guidance** — how to run it, expected inputs/outputs, common
   workflows, what happens if it's down. This becomes Layer 2.
4. **Move every technical detail down** — relocate (never delete) architecture,
   queue names, state transitions, schemas, and APIs into Layer 3.
5. **Pull the lookups into a reference block** — exact names, file paths,
   scripts, and links become Layer 4.

The test: skim the `##` headers. They should read as the four layers in order,
and no two layers should repeat each other's purpose.

## Worked Example

Jargon-first opening (a Layer-3 sentence wearing a Layer-1 hat):

> Forge uses hierarchical orchestration with dynamic agent creation.

Pyramid-compliant Layer 1:

> Forge creates temporary AI teams to handle larger tasks. One worker
> coordinates the work while others focus on specific responsibilities.

The technical phrasing is not wrong and is not deleted — it moves down to Layer
3, where Reader C expects it:

> Internally, this is hierarchical orchestration: a coordinator process spawns
> specialist subagents per task and merges their outputs.

Same facts, three layers, each reader served at the right depth.
