// Shared client-side event name used to fan out a "task status changed,
// refetch dashboard-wide counts" signal between the task stream hook and the
// sidebar status strip. Kept in one place so both sides cannot drift.
export const TASK_STATUS_REFRESH_EVENT = 'forge:task-status-refresh'
