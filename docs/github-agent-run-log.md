# GitHub Agent Run Log

> Part of the GitHub-native agent workflow. For how the run log fits the rest of
> the workflow (states, module ownership, implemented features), see
> [`github-native-agent-workflow-architecture.md`](./github-native-agent-workflow-architecture.md).

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
- #144 dispatch moves that record from `requested` to `handed-off` or `blocked`.
- #153 handoff can add artifact paths. Pull request linking is reserved for a
  future slice after the current no-auto-agent workflow.
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
Only `.forge/runs/<issue-number>/<run-id>.json` is unignored so run records can
be reviewed and committed deliberately. Do not put prompts, transcripts, secrets,
or generated task output in this run log.

The GitHub Actions command router writes and commits the run JSON before it marks
the issue with `agent-requested` or posts the accepted-request comment. If the
file cannot be written or pushed, the router stops instead of making the issue
look ready for dispatch without a durable run record.

The workflow checks out trusted default-branch code, then pushes only the run-log
JSON to the dedicated `forge/agent-run-log` branch. It must not run fork, pull
request, issue-comment, or run-log-branch code while holding `contents: write`.
Keeping the run log on its own branch avoids direct commits to protected default
branches while still making the record visible in the repository.

When a workflow needs to read or update an existing run record, it uses a
temporary Git worktree for `forge/agent-run-log`. The job still runs Forge's
scripts from the default-branch checkout. The temporary worktree is only a data
view of `.forge/runs/<issue-number>/<run-id>.json`; workflows must not run code
from it.

Run-log persistence intentionally fails closed. If Forge cannot write and push
the durable record, it does not apply `agent-requested` and does not post the
accepted-request comment. That keeps later dispatch from seeing an issue as
queued without a durable run record.

## Handoff Artifacts

Handoff files are not durable run-log records. They live under a nested,
git-ignored directory:

```text
.forge/runs/<issue-number>/<run-id>/handoff.md
.forge/runs/<issue-number>/<run-id>/prompt.md
.forge/runs/<issue-number>/<run-id>/metadata.json
```

GitHub Actions uploads that directory as a workflow artifact when handoff is
generated in Actions. Local handoff generation prints the paths. The repository
must not commit those prompt or metadata files, and they must not contain
secrets, credentials, model transcripts, or local auth material.

Because the artifact directory starts with `.forge`, the GitHub Actions upload
step must explicitly include hidden files.
