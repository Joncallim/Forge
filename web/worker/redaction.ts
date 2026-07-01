const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const DATABASE_URL_PATTERN = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s'"`<>)]+/gi
const DOCKER_AUTH_PATTERN = /(["'](?:auth|identitytoken|\.dockerconfigjson|dockerconfigjson)["']\s*:\s*)(["'])(?:(?!\2).){1,4096}\2/gi
// Redacts netrc-style `password <value>` tokens. The negative lookahead keeps
// the pattern from swallowing a lone `=`/`:` delimiter as the "value" when the
// input is actually a `password = <secret>` assignment (space before the
// delimiter); those forms are handled by the secret-assignment patterns below.
const NETRC_PASSWORD_PATTERN = /(\bpassword\s+)(?![=:])[^\s]+/gi
const PGPASS_ROW_PATTERN = /(^|\n)([^\s:#][^:\n]*:[^:\n]*:[^:\n]*:[^:\n]*:)[^\s:\n]+/g
const SECRET_KEY_NAME = '[A-Za-z0-9_.-]*(?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|client[_-]?secret|credential|private[_-]?key|npm[_-]?token)[A-Za-z0-9_.-]*'
const SECRET_ASSIGNMENT_PATTERN = new RegExp(`\\b(${SECRET_KEY_NAME})(\\s*[:=]\\s*)(["'])(?:(?!\\3).){1,4096}\\3`, 'gi')
const UNQUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(`\\b(${SECRET_KEY_NAME})(\\s*[:=]\\s*)[^\\s&"',}]+`, 'gi')

export function sanitizeWorkerMessage(value: unknown): string {
  return String(value)
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(DATABASE_URL_PATTERN, '[REDACTED_DATABASE_URL]')
    .replace(/\b(authorization:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*\b/gi, '$1[REDACTED_TOKEN]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^\s/]+@/gi, '$1[REDACTED_USERINFO]@')
    .replace(DOCKER_AUTH_PATTERN, '$1$2[REDACTED_TOKEN]$2')
    .replace(NETRC_PASSWORD_PATTERN, '$1[REDACTED_TOKEN]')
    .replace(PGPASS_ROW_PATTERN, '$1$2[REDACTED_TOKEN]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_=-]{10,}|sk_[A-Za-z0-9_=-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|xox[baprs]_[A-Za-z0-9_=-]{10,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:glpat|sk(?:-(?:proj|ant|live|test))?)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1$2$3[REDACTED_TOKEN]$3')
    .replace(UNQUOTED_SECRET_ASSIGNMENT_PATTERN, '$1$2[REDACTED_TOKEN]')
}
