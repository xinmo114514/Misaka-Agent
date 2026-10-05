import React from 'react'
import { Palette, Moon, Sun, Check } from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { SettingsRow } from '../SettingsRow'
import type { FontSizeOption } from '../../../types/settings'

const FONT_SIZE_OPTIONS: Array<{ id: FontSizeOption; label: string; desc: string }> = [
  { id: 'compact', label: '紧凑 (12px)', desc: '展示更多文献内容' },
  { id: 'standard', label: '标准 (13px)', desc: '均衡阅读体验' },
  { id: 'spacious', label: '舒适 (14px)', desc: '大字号专注研读' },
]

export const AppearanceSection: React.FC = () => {
  const themeName = useSettingsStore((s) => s.themeName)
  const setThemeName = useSettingsStore((s) => s.setThemeName)
  const themeError = useSettingsStore((s) => s.themeError)
  const currentTheme = themeName || 'dark'

  const fontSize = useSettingsStore((s) => s.fontSize)
  const setFontSize = useSettingsStore((s) => s.setFontSize)

  return (
    <div className="space-y-6">
      <div className="p-4 rounded-xl bg-card shadow-e1 border border-border-subtle">
        <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
          <Palette className="w-4 h-4 text-accent" />
          <span>界面主题与视觉个性化</span>
        </h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          定制桌面客户端的全局视觉风格，包括深浅色模式与时间线文本密度。修改实时生效并自动持久化。
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-card shadow-e1 p-4 space-y-1">
        <SettingsRow
          title="主题风格 (Theme Mode)"
          description="选择全局界面主题。更改将立即更新 Electron 主题监听与 CSS 自定义属性。"
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setThemeName('dark')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer ${
                currentTheme === 'dark'
                  ? 'bg-accent text-white border-accent shadow-xs'
                  : 'bg-surface-2 hover:bg-surface-3 text-muted hover:text-text-main border-border-subtle'
              }`}
            >
              <Moon className="w-3.5 h-3.5" />
              <span>深色主题 (Dark)</span>
              {currentTheme === 'dark' && <Check className="w-3.5 h-3.5 ml-1" />}
            </button>

            <button
              type="button"
              onClick={() => setThemeName('light')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer ${
                currentTheme === 'light'
                  ? 'bg-accent text-white border-accent shadow-xs'
                  : 'bg-surface-2 hover:bg-surface-3 text-muted hover:text-text-main border-border-subtle'
              }`}
            >
              <Sun className="w-3.5 h-3.5" />
              <span>浅色主题 (Light)</span>
              {currentTheme === 'light' && <Check className="w-3.5 h-3.5 ml-1" />}
            </button>
          </div>
        </SettingsRow>

        {themeError && (
          <div className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-[12px] text-danger">
            {themeError}
          </div>
        )}

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
                      ? 'bg-accent text-white shadow-xs'
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
  )
}
