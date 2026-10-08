/** Return a canonical web URL for the main process, or null for every other scheme/input. */
export function validatedExternalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null

  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href
  } catch {
    return null
  }
}