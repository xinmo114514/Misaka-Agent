import React, { useEffect, useMemo } from 'react'
import { Palette, Moon, Sun } from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { themeRegistry } from '../../../theme/registry'
import { SettingsRow } from '../SettingsRow'
import type { FontSizeOption } from '../../../types/settings'

const FONT_SIZE_OPTIONS: Array<{ id: FontSizeOption; label: string; desc: string }> = [
  { id: 'compact', label: '紧凑 (12px)', desc: '展示更多文献内容' },
  { id: 'standard', label: '标准 (13px)', desc: '均衡阅读体验' },
  { id: 'spacious', label: '舒适 (14px)', desc: '大字号专注研读' },
]

interface ThemeFamilyItem {
  key: string
  label: string
  lightId?: string
  darkId?: string
  standaloneId?: string
  standaloneMode?: 'light' | 'dark'
}

function resolveThemeFamilies(
  themeList: Array<{ id: string; label: string; mode: 'light' | 'dark' }>,
): ThemeFamilyItem[] {
  const families: ThemeFamilyItem[] = [
    { key: 'default', label: '经典默认' },
    { key: 'codex', label: '天空' },
    { key: 'claude', label: '羊皮纸' },
    { key: 'forest', label: '森林绿' },
  ]
  const handledIds = new Set<string>()

  for (const t of themeList) {
    if (t.id === 'light') {
      families[0].lightId = 'light'
      handledIds.add(t.id)
    } else if (t.id === 'dark') {
      families[0].darkId = 'dark'
      handledIds.add(t.id)
    } else if (t.id === 'codex-light') {
      families[1].lightId = 'codex-light'
      handledIds.add(t.id)
    } else if (t.id === 'codex-dark') {
      families[1].darkId = 'codex-dark'
      handledIds.add(t.id)
    } else if (t.id === 'claude-light') {
      families[2].lightId = 'claude-light'
      handledIds.add(t.id)
    } else if (t.id === 'claude-dark') {
      families[2].darkId = 'claude-dark'
      handledIds.add(t.id)
    } else if (t.id === 'forest-light') {
      families[3].lightId = 'forest-light'
      handledIds.add(t.id)
    } else if (t.id === 'forest-dark') {
      families[3].darkId = 'forest-dark'
      handledIds.add(t.id)
    }
  }

  for (const t of themeList) {
    if (handledIds.has(t.id)) continue
    const lightMatch = t.id.endsWith('-light') ? t.id.slice(0, -6) : null
    const darkMatch = t.id.endsWith('-dark') ? t.id.slice(0, -5) : null
    const baseKey = lightMatch || darkMatch

    if (baseKey) {
      let existing = families.find((f) => f.key === baseKey)
      if (!existing) {
        existing = {
          key: baseKey,
          label: t.label.replace(/\s*\((?:Light|Dark|浅色|深色)\)/i, ''),
        }
        families.push(existing)
      }
      if (t.mode === 'light') existing.lightId = t.id
      else existing.darkId = t.id
      handledIds.add(t.id)
    } else {
      families.push({
        key: t.id,
        label: t.label,
        standaloneId: t.id,
        standaloneMode: t.mode,
      })
      handledIds.add(t.id)
    }
  }

  return families.filter((f) => f.lightId || f.darkId || f.standaloneId)
}

export const AppearanceSection: React.FC = () => {
  const themeName = useSettingsStore((s) => s.themeName)
  const setThemeName = useSettingsStore((s) => s.setThemeName)
  const themeError = useSettingsStore((s) => s.themeError)
  const themes = useSettingsStore((s) => s.themes)
  const loadThemes = useSettingsStore((s) => s.loadThemes)
  const currentTheme = themeName || 'dark'

  useEffect(() => {
    void loadThemes()
  }, [loadThemes])

  const fontSize = useSettingsStore((s) => s.fontSize)
  const setFontSize = useSettingsStore((s) => s.setFontSize)

  const families = useMemo(() => resolveThemeFamilies(themes), [themes])

  const currentMode = useMemo<'light' | 'dark'>(() => {
    const activeMeta = themes.find((t) => t.id === currentTheme)
    if (activeMeta) return activeMeta.mode
    return currentTheme.includes('light') ? 'light' : 'dark'
  }, [themes, currentTheme])

  const activeFamilyKey = useMemo(() => {
    for (const f of families) {
      if (
        f.lightId === currentTheme ||
        f.darkId === currentTheme ||
        f.standaloneId === currentTheme
      ) {
        return f.key
      }
    }
    if (currentTheme.includes('codex')) return 'codex'
    if (currentTheme.includes('claude')) return 'claude'
    if (currentTheme.includes('forest')) return 'forest'
    return 'default'
  }, [families, currentTheme])

  const handleModeChange = (mode: 'light' | 'dark') => {
    const activeFamily = families.find((f) => f.key === activeFamilyKey)
    if (activeFamily) {
      const targetId = mode === 'light' ? activeFamily.lightId : activeFamily.darkId
      if (targetId) {
        setThemeName(targetId)
        return
      }
    }
    setThemeName(mode === 'light' ? 'light' : 'dark')
  }

  return (
    <div className="space-y-6">
      <div className="misaka-glass-panel relative p-4 rounded-xl bg-card shadow-e1 border border-border-subtle">
        <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
          <Palette className="w-4 h-4 text-accent" />
          <span>界面主题与视觉个性化</span>
        </h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          定制桌面客户端的全局视觉风格，包括深浅色模式与时间线文本密度。修改实时生效并自动持久化。
        </p>
      </div>

      <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5 max-w-xl pr-4">
            <h3 className="font-medium text-text-main text-[13px]">主题模式 (Theme Mode)</h3>
            <p className="text-[12px] text-muted leading-relaxed font-normal">
              选择全局界面主题风格与明暗外观。更改将立即更新 Electron 主题监听与 CSS 自定义属性。
            </p>
          </div>

          <div
            className="shrink-0 flex items-center gap-1 bg-surface-2 p-1 rounded-lg border border-border-subtle"
            role="radiogroup"
            aria-label="明暗模式"
          >
            <button
              type="button"
              aria-label="浅色主题"
              aria-pressed={currentMode === 'light'}
              onClick={() => handleModeChange('light')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer ${
                currentMode === 'light'
                  ? 'bg-accent text-on-accent shadow-xs'
                  : 'text-muted hover:text-text-main hover:bg-surface-3'
              }`}
            >
              <Sun className="w-3.5 h-3.5" />
              <span>浅色</span>
            </button>
            <button
              type="button"
              aria-label="深色主题"
              aria-pressed={currentMode === 'dark'}
              onClick={() => handleModeChange('dark')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer ${
                currentMode === 'dark'
                  ? 'bg-accent text-on-accent shadow-xs'
                  : 'text-muted hover:text-text-main hover:bg-surface-3'
              }`}
            >
              <Moon className="w-3.5 h-3.5" />
              <span>深色</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          {families.map((family) => {
            const targetId =
              (currentMode === 'light' ? family.lightId : family.darkId) ??
              family.standaloneId ??
              family.lightId ??
              family.darkId ??
              'dark'

            const isActive =
              currentTheme === targetId ||
              (family.key === activeFamilyKey &&
                (currentTheme === family.lightId || currentTheme === family.darkId))

            const previewId =
              (currentMode === 'light' ? family.lightId : family.darkId) ??
              family.standaloneId ??
              family.lightId ??
              family.darkId

            const themeColors = previewId ? themeRegistry.get(previewId)?.colors : undefined
            const bg0 = themeColors?.['surface-0'] ?? 'var(--surface-0)'
            const bg1 = themeColors?.['surface-1'] ?? 'var(--surface-1)'
            const accent = themeColors?.['accent'] ?? 'var(--accent)'
            const accentSoft = themeColors?.['accent-soft'] ?? 'var(--rose-lite)'
            const muted = themeColors?.['muted'] ?? 'var(--muted)'
            const dim = themeColors?.['dim'] ?? 'var(--dim)'
            const borderSubtle = themeColors?.['border-subtle'] ?? 'var(--border-subtle)'

            return (
              <div
                key={family.key}
                role="button"
                tabIndex={0}
                aria-label={family.label}
                aria-pressed={isActive}
                onClick={() => setThemeName(targetId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setThemeName(targetId)
                  }
                }}
                className={`group relative flex flex-col rounded-2xl border p-2.5 text-left transition-all duration-150 cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/60 ${
                  isActive
                    ? 'misaka-luminous border-accent shadow-xs'
                    : 'border-border-subtle hover:border-border-strong hover:bg-surface-hover/30'
                }`}
                style={isActive && accent ? { borderColor: accent } : undefined}
              >
                <div
                  className="relative flex flex-col justify-between w-full h-24 rounded-xl border p-2.5 overflow-hidden transition-colors"
                  style={{
                    backgroundColor: bg0,
                    borderColor: borderSubtle,
                  }}
                >
                  <div className="flex items-start justify-between w-full">
                    <div className="flex flex-col gap-1">
                      <div
                        className="h-1.5 w-14 rounded-full"
                        style={{ backgroundColor: accent }}
                      />
                      <div
                        className="h-1 w-9 rounded-full opacity-60"
                        style={{ backgroundColor: accentSoft }}
                      />
                    </div>

                    <div
                      className="w-4 h-4 rounded-full flex items-center justify-center transition-all shrink-0"
                      style={
                        isActive
                          ? { border: `2px solid ${accent}` }
                          : { border: `1.5px solid ${borderSubtle}`, backgroundColor: bg1 }
                      }
                    >
                      {isActive && (
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: accent }}
                        />
                      )}
                    </div>
                  </div>

                  <div
                    className="w-full rounded-lg border p-2 flex flex-col gap-1.5 shadow-2xs mt-auto"
                    style={{
                      backgroundColor: bg1,
                      borderColor: borderSubtle,
                    }}
                  >
                    <div
                      className="h-1.5 w-16 rounded-full opacity-40"
                      style={{ backgroundColor: muted }}
                    />
                    <div
                      className="h-1.5 w-10 rounded-full opacity-25"
                      style={{ backgroundColor: dim }}
                    />
                  </div>
                </div>

                <span
                  className={`mt-2.5 text-xs text-center truncate transition-colors ${
                    isActive
                      ? 'font-semibold text-text-main'
                      : 'font-medium text-muted group-hover:text-text-main'
                  }`}
                >
                  {family.label}
                </span>
              </div>
            )
          })}
        </div>

        {themeError && (
          <div className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-[12px] text-danger">
            {themeError}
          </div>
        )}

        <div className="border-t border-border-subtle/60 pt-2">
          <SettingsRow
            title="阅读字号与文本密度 (Typography Density)"
            description="调节时间线正文与标题、思维链、代码块及工具输出的字号。"
          >
            <div className="flex items-center gap-1.5 bg-surface-2 p-1 rounded-lg border border-border-subtle">
              {FONT_SIZE_OPTIONS.map((opt) => {
                const isSelected = fontSize === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setFontSize(opt.id)}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-accent text-on-accent shadow-xs'
                        : 'text-muted hover:text-text-main hover:bg-surface-3'
                    }`}
                    title={opt.desc}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
        </SettingsRow>
      </div>
    </div>
  </div>
  )
}
