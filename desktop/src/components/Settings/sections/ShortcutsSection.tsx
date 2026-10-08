import React, { useState, useEffect } from 'react'
import { Keyboard, Sparkles, CheckCircle2 } from 'lucide-react'
import { SettingsRow } from '../SettingsRow'

interface ShortcutItem {
  key: string
  macKey: string
  desc: string
  category: '导航与系统' | '对话与编辑'
}

const SHORTCUTS: ShortcutItem[] = [
  { key: 'Ctrl + K', macKey: 'Cmd + K', desc: '快速打开设置并聚焦全局搜索', category: '导航与系统' },
  { key: 'Ctrl + ,', macKey: 'Cmd + ,', desc: '一键打开 / 关闭客户端设置', category: '导航与系统' },
  { key: 'Ctrl + N', macKey: 'Cmd + N', desc: '新建研究会话', category: '导航与系统' },
  { key: 'Ctrl + B', macKey: 'Cmd + B', desc: '展开 / 折叠左侧边栏', category: '导航与系统' },
  { key: 'Enter', macKey: 'Enter', desc: '发送当前输入的研究课题或指令', category: '对话与编辑' },
  { key: 'Shift + Enter', macKey: 'Shift + Enter', desc: '在输入框中换行', category: '对话与编辑' },
  { key: 'Escape', macKey: 'Escape', desc: '退出设置页面或关闭浮层', category: '导航与系统' },
]

export const ShortcutsSection: React.FC = () => {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  const [activeTestKey, setActiveTestKey] = useState<string | null>(null)
  const [matchedDesc, setMatchedDesc] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const parts: string[] = []
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.metaKey) parts.push('Cmd')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')

      const keyName = e.key.toUpperCase()
      if (!['CONTROL', 'META', 'ALT', 'SHIFT'].includes(keyName)) {
        parts.push(keyName === ' ' ? 'Space' : e.key)
      }

      if (parts.length > 0) {
        const combo = parts.join(' + ')
        setActiveTestKey(combo)

        // Check match
        const matched = SHORTCUTS.find((s) => {
          const target = isMac ? s.macKey : s.key
          return target.toLowerCase().replace(/\s+/g, '') === combo.toLowerCase().replace(/\s+/g, '')
        })
        setMatchedDesc(matched ? matched.desc : null)
      }
    }

    const handleKeyUp = () => {
      // keep displayed for 1.5s
      const timer = setTimeout(() => {
        setActiveTestKey(null)
        setMatchedDesc(null)
      }, 1500)
      return () => clearTimeout(timer)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [isMac])

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="misaka-glass-panel relative p-4 rounded-xl bg-card shadow-e1 border border-border-subtle">
        <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
          <Keyboard className="w-4 h-4 text-accent" />
          <span>键盘快捷键与高效交互</span>
        </h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          桌面客户端现已支持全局快捷键快速呼出、会话新建与侧栏控制。您可以在下方实时测试按键响应。
        </p>
      </div>

      {/* Live Shortcut Tester Card */}
      <div className="misaka-glass-panel relative p-4 rounded-xl bg-card shadow-e1 border border-border-subtle space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-text-main flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-accent" />
            <span>快捷键实时检测器 (按键盘即可测试)</span>
          </span>
          {activeTestKey && (
            <span className="text-[11px] text-success flex items-center gap-1 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>检测到按键输入</span>
            </span>
          )}
        </div>
        <div className="p-3 rounded-lg bg-surface-2 border border-border-subtle flex items-center justify-between min-h-[48px]">
          <div className="flex items-center gap-2">
            {activeTestKey ? (
              <kbd className="px-3 py-1 rounded bg-accent text-on-accent font-mono text-xs shadow-xs font-semibold">
                {activeTestKey}
              </kbd>
            ) : (
              <span className="text-xs text-dim italic">请在键盘上按下任意快捷键组合...</span>
            )}
          </div>
          {matchedDesc && (
            <span className="text-xs text-accent font-medium">
              已匹配：{matchedDesc}
            </span>
          )}
        </div>
      </div>

      {/* Shortcuts List */}
      <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-4 space-y-1">
        {SHORTCUTS.map((sc) => {
          const displayKey = isMac ? sc.macKey : sc.key
          const isPressed =
            activeTestKey &&
            displayKey.toLowerCase().replace(/\s+/g, '') === activeTestKey.toLowerCase().replace(/\s+/g, '')

          return (
            <SettingsRow key={sc.key} title={sc.desc} badge={sc.category}>
              <kbd
                className={`px-2.5 py-1 rounded border font-mono text-[11px] shadow-xs transition-all ${
                  isPressed
                    ? 'bg-accent text-on-accent border-accent scale-105'
                    : 'bg-surface-2 text-text-main border-border-subtle'
                }`}
              >
                {displayKey}
              </kbd>
            </SettingsRow>
          )
        })}
      </div>
    </div>
  )
}
