# GitHub Agent Run Log

The GitHub-native workflow keeps a small run log in the project repository so an
accepted agent request is still visible after a chat session or GitHub Actions
job ends.

Each accepted implementation request writes one JSON file:

```text
.forge/runs/<issue-number>/<run-id>.json
```

For example:

```text
.forge/runs/146/issue-146-1234567890-1.json
```

The file records the issue number and title, requested runtime, requested action,
comment author, source comment id, current status, optional branch name, optional
pull request number, optional blocked reason, validation summary, timestamps, and
a short event history. It does not store API keys, credentials, full prompts, or
chat/model transcripts.

## Why This Exists

Issue comments and chat threads are not a durable workflow database. The run log
gives later steps a simple handoff point:

- #143 command routing records that a maintainer requested implementation.
- #144 dispatch can later move that record from `requested` to `running` or
  `blocked`.
- Later handoff and pull request steps can add a branch name and pull request
  number.
- The epic review pass can inspect what happened without relying on a lost chat
  session.

## Relationship To #32 Checkpoints

The #32 checkpoint files are human-readable Markdown notes under
`local-memory/checkpoints`. They help later agents or operators resume context,
but they are local support material, not workflow state.

The GitHub agent run log is different. It is structured JSON under `.forge/runs`
inside the project repository. It is the durable, machine-readable trail for
GitHub issue workflow runs. A checkpoint may explain what an agent learned or
planned; a run record says what request was accepted and what state that request
is in.

## Git Behavior

Forge still ignores most `.forge` output because task sandboxes can be large.
Only `.forge/runs/**/*.json` is unignored so run records can be reviewed and
committed deliberately. Do not put prompts, transcripts, secrets, or generated
task output in this run log.
