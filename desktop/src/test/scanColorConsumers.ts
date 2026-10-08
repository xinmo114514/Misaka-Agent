/** Palette literals belong in theme definitions, never in rendering consumers.
 * Opaque black is allowed only inside a mask declaration: it encodes coverage,
 * not visible ink. Transparent and currentColor are shape/inheritance values. */
export function scanColorConsumers(path: string, source: string): string[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '')
  const findings: string[] = []
  const pattern = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\s*\(|\b(?:text|bg|border|divide|fill|stroke|ring|outline|shadow|decoration|from|via|to)-(?:[xytrblse]-)?(?:white|black|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3})\b/gi
  for (const match of clean.matchAll(pattern)) {
    const index = match.index!
    const before = clean.slice(Math.max(clean.lastIndexOf(';', index), clean.lastIndexOf('{', index)) + 1, index)
    if (match[0] === '#000' && /(?:-webkit-)?mask-image\s*:|--band-mask\s*:/.test(before)) continue
    findings.push(`${path}:${clean.slice(0, index).split('\n').length}: ${match[0]}`)
  }
  const namedInk = /\b(?:color|background(?:Color|-color)?|border(?:Color|-color)?|fill|stroke|hue)\s*:\s*["']?(?:\d+(?:px|rem)\s+(?:solid|dashed|dotted)\s+)?(white|black|red|blue|green|yellow|orange|purple|pink|gray|grey|silver|navy|teal|aqua|fuchsia|maroon|olive|lime|rebeccapurple)\b/gi
  for (const match of clean.matchAll(namedInk)) {
    findings.push(`${path}:${clean.slice(0, match.index!).split('\n').length}: ${match[1]}`)
  }
  return findings
}
