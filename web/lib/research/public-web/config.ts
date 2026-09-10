/** The public-web setting is intentionally opt-in. Unknown values fail closed. */
export function publicWebResearchEnabled(value = process.env.FORGE_AGENT_WEB_SEARCH): boolean {
  return value === '1'
}

export function publicWebResearchStatus(value = process.env.FORGE_AGENT_WEB_SEARCH): 'enabled' | 'disabled' {
  return publicWebResearchEnabled(value) ? 'enabled' : 'disabled'
}
