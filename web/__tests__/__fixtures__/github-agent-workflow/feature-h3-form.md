# [FEATURE] Validate GitHub issues against FORGE templates

### Problem Statement

FORGE relies on structured GitHub Issues as the implementation contract.

### Desired Outcome

Complete issues become `ready-for-agent` and incomplete ones become `needs-clarification`.

### User Story

As a FORGE user,
I want issue structure to be validated,
So that agents do not invent missing requirements.

### Requirements

- Add a deterministic issue validator.
- Re-check issues after edits.

### Acceptance Criteria

- [ ] Opening a complete Feature issue applies `ready-for-agent`.
- [ ] Opening an incomplete Feature issue applies `needs-clarification`.
- [ ] Tests or validation steps are included.
