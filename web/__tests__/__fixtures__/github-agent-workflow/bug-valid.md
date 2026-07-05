# [BUG] Dashboard refresh issue

### Bug Summary

The dashboard does not refresh after a worker finishes.

### Current Behaviour

The completed task keeps showing as running until the page is reloaded.

### Expected Behaviour

The dashboard should refresh and show the completed status automatically.

### Reproduction Steps

1. Open the dashboard.
2. Wait for a running task to finish.
3. Observe that the page does not refresh.

### Impact

Operators cannot trust the dashboard as the current source of truth.

### Severity

High - major workflow broken

### Acceptance Criteria

- [ ] The dashboard refreshes when the task completes.
- [ ] Existing related behaviour remains unaffected.
