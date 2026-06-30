export function redactAdapterMessage(message: string): string {
  return message
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[oprsu]_[A-Za-z0-9_=-]{8,}|glpat-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[redacted-token]')
    .replace(/\b(gho|ghp|glpat|sk|sk-ant|xox[baprs])_[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi, 'Bearer [redacted-token]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]')
    .slice(0, 240)
}
