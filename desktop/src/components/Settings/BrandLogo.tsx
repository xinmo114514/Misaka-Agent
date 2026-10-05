import React from 'react'
import { Boxes, Sparkles } from 'lucide-react'

/**
 * A brand tile: a monogram in a tinted rounded square.
 *
 * Deliberately not vendor raster art — the desktop ships no third-party logo assets, and a
 * typographic mark stays crisp in both themes at every size. Each brand keeps one hue so it
 * is recognizable at a glance in the navigation rail.
 */
const BRAND_STYLE: Record<string, { monogram: string; hue: string }> = {
  zhipu: { monogram: '智', hue: '#3b6ea5' },
  deepseek: { monogram: 'DS', hue: '#4d6bfe' },
  anthropic: { monogram: 'C', hue: '#d97757' },
  openai: { monogram: 'O', hue: '#10a37f' },
  kimi: { monogram: 'K', hue: '#7a5af8' },
  xiaomi: { monogram: '米', hue: '#ff6900' },
  qwen: { monogram: '通', hue: '#615ced' },
  custom: { monogram: '', hue: '#8a8f98' },
}

interface BrandLogoProps {
  brandId: string
  size?: number
  className?: string
}

export const BrandLogo: React.FC<BrandLogoProps> = ({ brandId, size = 32, className = '' }) => {
  const style = BRAND_STYLE[brandId] ?? BRAND_STYLE.custom
  const dimension = `${size}px`

  if (brandId === 'custom') {
    return (
      <span
        className={`flex shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-surface-2 text-dim ${className}`}
        style={{ width: dimension, height: dimension }}
        aria-hidden="true"
      >
        <Boxes style={{ width: size * 0.5, height: size * 0.5 }} />
      </span>
    )
  }

  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg font-semibold ${className}`}
      style={{
        width: dimension,
        height: dimension,
        fontSize: `${Math.round(size * 0.42)}px`,
        color: style.hue,
        background: `color-mix(in srgb, ${style.hue} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${style.hue} 34%, transparent)`,
      }}
      aria-hidden="true"
    >
      {style.monogram || <Sparkles style={{ width: size * 0.5, height: size * 0.5 }} />}
    </span>
  )
}

export default BrandLogo
