/** Write text to the system clipboard and reject when the browser bridge is unavailable. */
export async function copyTextToClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('剪贴板接口不可用')
  }
  await clipboard.writeText(text)
}

export function clipboardErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '请检查剪贴板权限后重试'
}
