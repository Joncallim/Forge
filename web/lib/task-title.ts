import { generateText } from 'ai'
import { getModel, getProvider, listActiveProviders } from '@/lib/providers/registry'

const TITLE_SYSTEM_PROMPT =
  'You write short task titles. Given a task prompt, respond with ONLY a concise, ' +
  'specific title (max 8 words, no quotes, no trailing punctuation) summarizing what the task asks for.'

function truncatePrompt(prompt: string): string {
  return prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt
}

function sanitizeTitle(text: string): string {
  return text.trim().replace(/^["'.]+|["'.]+$/g, '').slice(0, 500)
}

function fallbackTitle(prompt: string): string {
  const oneLine = prompt.trim().split('\n')[0]
  return sanitizeTitle(oneLine).slice(0, 80) || 'Untitled task'
}

// ---------------------------------------------------------------------------
// generateTaskTitle
// ---------------------------------------------------------------------------
// Best-effort: picks the PM-assigned provider (or any active provider) to draft
// a short title from the prompt. Falls back to the first line of the prompt if
// no provider is available or the call fails, so task creation never blocks.
export async function generateTaskTitle(
  prompt: string,
  preferredProviderConfigId?: string,
): Promise<string> {
  try {
    let providerResult = preferredProviderConfigId
      ? await getProvider(preferredProviderConfigId)
      : null

    if (!providerResult) {
      const [active] = await listActiveProviders()
      if (active) providerResult = await getProvider(active.id)
    }

    if (!providerResult) return fallbackTitle(prompt)

    const model = await getModel(providerResult.config.id)
    if (!model) return fallbackTitle(prompt)

    const result = await generateText({
      model,
      system: TITLE_SYSTEM_PROMPT,
      prompt: truncatePrompt(prompt),
      temperature: 0.3,
    })

    const title = sanitizeTitle(result.text)
    return title || fallbackTitle(prompt)
  } catch (err) {
    console.error('[task-title] Failed to generate title, falling back', err)
    return fallbackTitle(prompt)
  }
}
