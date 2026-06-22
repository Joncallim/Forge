# Terminal Installer Plan

The planned installer is a guided terminal interface, replacing long manual
checklists with clear steps and choices.

The goal is a keyboard-friendly terminal UI similar in spirit to Claude Code:
clear steps, visible progress, simple choices, and useful recovery messages.

## Goals

- Explain each install step in plain English.
- Show progress for slow steps such as Homebrew or Linux package installs,
  `npm install`, Docker image pulls, database migrations, and Ollama model
  downloads.
- Let the user choose between local AI, cloud AI, or configuring providers
  later.
- Let the user choose whether to use native services or Docker services.
- Keep secrets out of terminal history.
- Write a clear install summary and an uninstall record.

## Proposed Screens

1. Welcome
   - Detect macOS/Linux, Docker, Homebrew or Linux package manager, Node,
     PostgreSQL, Redis, GitHub CLI, and Ollama.
   - Show what is already installed.
2. Install mode
   - Native local services.
   - Docker local services.
   - Advanced/manual.
3. AI setup
   - Local Ollama model.
   - Cloud provider later.
   - Custom OpenAI-compatible endpoint later.
4. Credentials and data
   - Generate `.env`.
   - Explain where provider keys are stored.
   - Confirm whether an existing `.env` should be kept.
5. Progress
   - One row per step.
   - States: waiting, running, done, skipped, needs attention.
6. Finish
   - Show exact commands to start the web UI and worker.
   - Show how to uninstall.
   - Show where logs and settings live.

## Implementation Approach

Build this as a Node.js CLI under `web/scripts` or `scripts` using a TUI library
such as Ink, React Ink-compatible components, or a lighter prompt library if a
full-screen UI is too much for the first version.

The TUI should call the same shell-safe operations used by the existing scripts.
The shell scripts should remain available for automation and recovery.

## First Milestone

Before building the full TUI, keep improving the current shell scripts:

- print clear step names,
- print a preflight summary before machine changes,
- support `--check` for non-mutating readiness checks,
- detect GitHub CLI and authentication status,
- explain long waits before they happen,
- record install state,
- make uninstall safe and reversible by default,
- avoid noisy warnings for optional tools that are not installed.

Those pieces form the foundation for the future terminal UI.
