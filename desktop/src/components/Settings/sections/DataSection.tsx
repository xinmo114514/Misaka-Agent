import React, { useEffect, useRef, useState } from 'react'
import {
  Database,
  FolderOpen,
  Copy,
  Check,
  Download,
  Trash2,
  FileCheck2,
  HardDrive,
  AlertCircle,
  LoaderCircle,
  X,
} from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useSessionStore } from '../../../store/useSessionStore'
import { sessionHistoryCache } from '../../../lib/sessionHistoryCache'
import { clearSessionViewsExcept } from '../../../lib/sessionViewState'
import { clipboardErrorMessage, copyTextToClipboard } from '../../../lib/clipboard'
import { SettingsRow } from '../SettingsRow'

export const DataSection: React.FC = () => {
  const configPaths = useSettingsStore((s) => s.configPaths)
  const exportCurrentSession = useSettingsStore((s) => s.exportCurrentSession)
  const lastExportedPath = useSettingsStore((s) => s.lastExportedPath)
  const currentSessionPath = useSessionStore((s) => s.currentSessionPath)
  const sessions = useSessionStore((s) => s.sessions)

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<{ kind: 'pending' | 'success' | 'error'; text: string } | null>(null)
  const [pathNotice, setPathNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [clipboardNotice, setClipboardNotice] = useState<{ kind: 'pending' | 'success' | 'error'; text: string } | null>(null)
  const [copyingKey, setCopyingKey] = useState<string | null>(null)
  const copyingRef = useRef(false)
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [cacheNotice, setCacheNotice] = useState<string | null>(null)

  useEffect(() => () => {
    if (copiedResetTimer.current) clearTimeout(copiedResetTimer.current)
  }, [])

  const handleCopy = async (key: string, text: string) => {
    if (!text || copyingRef.current) return
    copyingRef.current = true
    setCopyingKey(key)
    setClipboardNotice({ kind: 'pending', text: '正在写入剪贴板…' })
    try {
      await copyTextToClipboard(text)
      setCopiedKey(key)
      setClipboardNotice({ kind: 'success', text: '路径已复制' })
      if (copiedResetTimer.current) clearTimeout(copiedResetTimer.current)
      copiedResetTimer.current = setTimeout(() => {
        setCopiedKey((current) => current === key ? null : current)
        copiedResetTimer.current = null
      }, 2000)
    } catch (error) {
      setCopiedKey(null)
      setClipboardNotice({ kind: 'error', text: `复制失败：${clipboardErrorMessage(error)}` })
    } finally {
      copyingRef.current = false
      setCopyingKey(null)
    }
  }

  const handleOpenPath = async (targetPath: string) => {
    setPathNotice(null)
    if (!window.app?.openPath || !targetPath) {
      setPathNotice({ kind: 'error', text: '系统目录打开功能不可用' })
      return
    }
    try {
      const result = await window.app.openPath(targetPath)
      setPathNotice(result.ok
        ? { kind: 'success', text: `已提交打开路径请求：${targetPath}` }
        : { kind: 'error', text: `打开路径失败：${result.error || '系统未能打开该路径'}` })
    } catch (error) {
      setPathNotice({ kind: 'error', text: `打开路径失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const handleShowInFolder = async (targetPath: string) => {
    setPathNotice(null)
    if (!window.app?.showItemInFolder || !targetPath) {
      setPathNotice({ kind: 'error', text: '系统文件定位功能不可用' })
      return
    }
    try {
      const result = await window.app.showItemInFolder(targetPath)
      setPathNotice(result.ok
        ? { kind: 'success', text: `已提交文件定位请求：${targetPath}` }
        : { kind: 'error', text: `定位文件失败：${result.error || '系统未能定位该文件'}` })
    } catch (error) {
      setPathNotice({ kind: 'error', text: `定位文件失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const handleExport = async () => {
    if (!currentSessionPath) {
      setExportNotice({ kind: 'error', text: '当前无活动会话可导出' })
      return
    }
    setExportNotice({ kind: 'pending', text: '正在导出 JSONL…' })
    setPathNotice(null)
    setIsExporting(true)
    try {
      const res = await exportCurrentSession(currentSessionPath)
      if (res.ok && res.path) setExportNotice({ kind: 'success', text: `导出成功：${res.path}` })
      else setExportNotice({ kind: 'error', text: `导出失败：${res.error || '结果未确认'}` })
    } catch (error) {
      setExportNotice({ kind: 'error', text: `导出失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setIsExporting(false)
    }
  }

  const handleCleanCache = () => {
    sessionHistoryCache.clear()
    clearSessionViewsExcept(currentSessionPath)
    setCacheNotice('已清理前端会话缓存')
    setTimeout(() => setCacheNotice(null), 3000)
  }

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="misaka-glass-panel relative p-4 rounded-xl bg-card shadow-e1 border border-border-subtle">
        <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
          <Database className="w-4 h-4 text-accent" />
          <span>本地存储、导出与安全路径</span>
        </h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          管理 Misaka Agent 在本地计算机上的配置、凭据密钥库与历史会话归档文件。所有路径均支持一键在文件资源管理器中打开与导出。
        </p>
      </div>

      {/* Path Locations */}
      <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-4 space-y-1">
        <SettingsRow
          title="配置根目录 (Agent Directory)"
          description="存放 settings.json, models.json 与主题配置文件的路径。"
        >
          <div className="flex items-center gap-1.5 max-w-md">
            <span className="text-[11.5px] font-mono bg-surface-2 px-2.5 py-1 rounded border border-border-subtle text-text-main truncate max-w-xs">
              {configPaths?.agentDir || '未获取'}
            </span>
            {configPaths?.agentDir && (
              <>
                <button
                  type="button"
                  onClick={() => handleCopy('agentDir', configPaths.agentDir)}
                  disabled={Boolean(copyingKey)}
                  className="p-1.5 rounded hover:bg-surface-2 text-dim hover:text-text-main border border-border-subtle transition-colors cursor-pointer"
                  title="复制路径"
                >
                  {copiedKey === 'agentDir' ? (
                    <Check className="w-3.5 h-3.5 text-success" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenPath(configPaths.agentDir)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer"
                  title="在系统资源管理器中打开"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-accent" />
                  <span>打开</span>
                </button>
              </>
            )}
          </div>
        </SettingsRow>

        <SettingsRow
          title="凭据密钥库 (Auth Storage)"
          description="加密保存供应商 API Key 与认证凭据的物理文件路径。"
        >
          <div className="flex items-center gap-1.5 max-w-md">
            <span className="text-[11.5px] font-mono bg-surface-2 px-2.5 py-1 rounded border border-border-subtle text-text-main truncate max-w-xs">
              {configPaths?.authPath || '未获取'}
            </span>
            {configPaths?.authPath && (
              <>
                <button
                  type="button"
                  onClick={() => handleCopy('authPath', configPaths.authPath)}
                  disabled={Boolean(copyingKey)}
                  className="p-1.5 rounded hover:bg-surface-2 text-dim hover:text-text-main border border-border-subtle transition-colors cursor-pointer"
                  title="复制路径"
                >
                  {copiedKey === 'authPath' ? (
                    <Check className="w-3.5 h-3.5 text-success" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleShowInFolder(configPaths.authPath)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer"
                  title="在资源管理器中定位文件"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-accent" />
                  <span>定位</span>
                </button>
              </>
            )}
          </div>
        </SettingsRow>

        <SettingsRow
          title="会话持久化目录 (Sessions Storage)"
          description="历史研究课题与对话 JSONL 文件的归档位置。"
        >
          <div className="flex items-center gap-1.5 max-w-md">
            <span className="text-[11.5px] font-mono bg-surface-2 px-2.5 py-1 rounded border border-border-subtle text-text-main truncate max-w-xs">
              {configPaths?.sessionsDir || '未获取'}
            </span>
            {configPaths?.sessionsDir && (
              <>
                <button
                  type="button"
                  onClick={() => handleCopy('sessionsDir', configPaths.sessionsDir)}
                  disabled={Boolean(copyingKey)}
                  className="p-1.5 rounded hover:bg-surface-2 text-dim hover:text-text-main border border-border-subtle transition-colors cursor-pointer"
                  title="复制路径"
                >
                  {copiedKey === 'sessionsDir' ? (
                    <Check className="w-3.5 h-3.5 text-success" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenPath(configPaths.sessionsDir)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer"
                  title="在系统资源管理器中打开"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-accent" />
                  <span>打开</span>
                </button>
              </>
            )}
          </div>
        </SettingsRow>
      </div>

      {clipboardNotice && <div role={clipboardNotice.kind === 'error' ? 'alert' : 'status'} className={`p-2.5 rounded-lg border text-xs ${clipboardNotice.kind === 'error' ? 'bg-danger-surface text-danger border-danger-border' : clipboardNotice.kind === 'success' ? 'bg-success-surface text-success border-success-border' : 'bg-surface-2 text-muted border-border-subtle'}`}>
        {clipboardNotice.text}
        {clipboardNotice.kind === 'error' && <button type="button" onClick={() => setClipboardNotice(null)} aria-label="关闭复制提示" className="float-right"><X className="w-3.5 h-3.5" /></button>}
      </div>}
      {pathNotice && <div role={pathNotice.kind === 'error' ? 'alert' : 'status'} className={`p-2.5 rounded-lg border text-xs ${pathNotice.kind === 'error' ? 'bg-danger-surface text-danger border-danger-border' : 'bg-success-surface text-success border-success-border'}`}>
        {pathNotice.text}
        {pathNotice.kind === 'error' && <button type="button" onClick={() => setPathNotice(null)} aria-label="关闭路径提示" className="float-right"><X className="w-3.5 h-3.5" /></button>}
      </div>}

      {/* Real Session Export Card */}
      <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-main flex items-center gap-2">
              <Download className="w-4 h-4 text-accent" />
              <span>当前会话导出与备份 (Export Session)</span>
            </h3>
            <p className="text-xs text-muted leading-relaxed">
              将当前活跃会话的全部问答、推理过程、工具调用与文献引用导出为标准的 JSONL 存档文件。
            </p>
          </div>

          <button
            type="button"
            onClick={handleExport}
            disabled={isExporting || !currentSessionPath}
            className="misaka-luminous flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-accent text-on-accent hover:bg-accent/90 text-xs font-medium transition-all shadow-xs cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExporting ? '导出中...' : '一键导出当前会话'}</span>
          </button>
        </div>

        {exportNotice && (
          <div role={exportNotice.kind === 'error' ? 'alert' : 'status'} className={`flex items-center justify-between p-3 rounded-lg border text-xs ${exportNotice.kind === 'error' ? 'bg-danger-surface text-danger border-danger-border' : exportNotice.kind === 'success' ? 'bg-success-surface text-success border-success-border' : 'bg-surface-2 text-muted border-border-subtle'}`}>
            <div className="flex items-center gap-2 truncate pr-2">
              {exportNotice.kind === 'pending' ? <LoaderCircle className="w-4 h-4 animate-spin shrink-0" /> : exportNotice.kind === 'error' ? <AlertCircle className="w-4 h-4 shrink-0" /> : <FileCheck2 className="w-4 h-4 text-success shrink-0" />}
              <span className="truncate">{exportNotice.text}</span>
            </div>
            {exportNotice.kind === 'success' && lastExportedPath && (
              <button
                type="button"
                onClick={() => handleShowInFolder(lastExportedPath)}
                className="px-2.5 py-1 rounded bg-surface-3 hover:border-border-strong hover:text-text-main border border-border text-xs shrink-0 cursor-pointer"
              >
                在文件夹中查看
              </button>
            )}
          </div>
        )}
      </div>

      {/* Storage Overview & Maintenance */}
      <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-main flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-accent" />
              <span>存储维护与缓存管理</span>
            </h3>
            <p className="text-xs text-muted leading-relaxed">
              当前共记录了 <strong className="text-text-main font-mono">{sessions.length}</strong> 个本地课题会话。定期清理渲染缓存有助于提升界面流程度。
            </p>
          </div>

          <button
            type="button"
            onClick={handleCleanCache}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5 text-dim" />
            <span>清理临时缓存</span>
          </button>
        </div>

        {cacheNotice && (
          <div className="p-2.5 rounded-lg bg-success-surface text-success border border-success-border text-xs flex items-center gap-2">
            <Check className="w-3.5 h-3.5" />
            <span>{cacheNotice}</span>
          </div>
        )}
      </div>
    </div>
  )
}
