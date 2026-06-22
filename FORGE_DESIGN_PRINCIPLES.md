# FORGE DESIGN PRINCIPLES

FORGE is an AI Engineering Command Center.

Humans make decisions.
Agents execute work.
FORGE makes the relationship visible.

The product should feel like operating a software organization composed of AI workers, not chatting with another AI assistant.

## Core References

- Linear
- Vercel
- GitHub Pull Requests
- Raycast
- Datadog
- BMAD Method
- Superpowers
- Anthropic Skills
- SuperClaude
- Claude Squad
- Archon

## Product Philosophy

Every screen must answer:

1. What is happening?
2. Why is it happening?
3. What needs my attention?
4. What decision should I make next?

## Primary Workflows

Brief -> Plan -> Architecture -> Work Package -> Agent Run -> Review -> Ship

Human review is a first-class workflow.

## Design Principles

- Clear state over decoration.
- Information density over empty whitespace.
- Evidence over conversation.
- Split-pane workflows over page hopping.
- Command-center UX over dashboard aesthetics.
- Operational visibility over marketing visuals.

## Required Screens

1. Command Center
2. Project Workspace
3. Task Workspace
4. Agent Workspace
5. Skill and Persona Library

## State Model

Every object should expose state:

- Queued
- Running
- Blocked
- Awaiting Review
- Failed
- Completed
- Merged
- Deployed

## Review Requirements

Every task should expose:

- Brief
- Requirements
- Architecture
- Plan
- Logs
- Diffs
- Tests
- Outputs
- Approval Actions

## Visual Rules

- Neutral interface.
- Compact layouts.
- Strong hierarchy.
- Color reserved for meaning.
- CSS-first animation.
- No decorative gradients.
- No giant empty cards.
- No chat-first workflows.

## Success Criteria

A user should feel:

'I am managing a team of AI workers delivering software.'

Not:

'I am chatting with a chatbot.'

See docs/UI_REFERENCE_STACK.md for detailed implementation guidance and repository references.