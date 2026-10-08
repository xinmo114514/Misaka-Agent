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
  zhipu: { monogram: '智', hue: 'var(--brand-zhipu)' },
  deepseek: { monogram: 'DS', hue: 'var(--brand-deepseek)' },
  anthropic: { monogram: 'C', hue: 'var(--brand-anthropic)' },
  openai: { monogram: 'O', hue: 'var(--brand-openai)' },
  kimi: { monogram: 'K', hue: 'var(--brand-kimi)' },
  xiaomi: { monogram: '米', hue: 'var(--brand-xiaomi)' },
  qwen: { monogram: '通', hue: 'var(--brand-qwen)' },
  custom: { monogram: '', hue: 'var(--brand-custom)' },
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
        className={`flex shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-surface-2 text-brand-custom ${className}`}
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
