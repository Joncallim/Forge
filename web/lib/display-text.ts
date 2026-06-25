function normalizeInlineDisplayText(text: string): string {
  return text
    .replace(/\$\\(?:r|R)ightarrow\\?\$?/g, '→')
    .replace(/\\(?:r|R)ightarrow\\?/g, '→')
}

export function normalizeMarkdownDisplayText(content: string): string {
  return content
    .split(/(```[\s\S]*?```)/g)
    .map((part) => (part.startsWith('```') ? part : normalizeInlineDisplayText(part)))
    .join('')
}
