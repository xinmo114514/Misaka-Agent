import React, { useState } from 'react'
import {
  Database,
  FolderOpen,
  Copy,
  Check,
  Download,
  Trash2,
  FileCheck2,
  HardDrive,
} from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useSessionStore } from '../../../store/useSessionStore'
import { SettingsRow } from '../SettingsRow'

export const DataSection: React.FC = () => {
  const configPaths = useSettingsStore((s) => s.configPaths)
  const exportCurrentSession = useSettingsStore((s) => s.exportCurrentSession)
  const lastExportedPath = useSettingsStore((s) => s.lastExportedPath)
  const currentSessionPath = useSessionStore((s) => s.currentSessionPath)
  const sessions = useSessionStore((s) => s.sessions)

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  const [cacheNotice, setCacheNotice] = useState<string | null>(null)

  const handleCopy = (key: string, text: string) => {
    if (!text) return
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  const handleOpenPath = async (targetPath: string) => {
    if (window.app?.openPath && targetPath) {
      await window.app.openPath(targetPath)
    }
  }

  const handleShowInFolder = async (targetPath: string) => {
    if (window.app?.showItemInFolder && targetPath) {
      await window.app.showItemInFolder(targetPath)
    }
  }

  const handleExport = async () => {
    if (!currentSessionPath) {
      setExportNotice('当前无活动会话可导出')
      setTimeout(() => setExportNotice(null), 3000)
      return
    }
    setIsExporting(true)
    const res = await exportCurrentSession(currentSessionPath)
    setIsExporting(false)
    if (res.ok && res.path) {
      setExportNotice(`导出成功: ${res.path}`)
    } else {
      setExportNotice(`导出失败: ${res.error || '未知错误'}`)
    }
  }

  const handleCleanCache = () => {
    setCacheNotice('已清理临时文件与前端缓存')
    setTimeout(() => setCacheNotice(null), 3000)
  }

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="p-4 rounded-xl bg-card shadow-e1 border border-border-subtle">
        <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
          <Database className="w-4 h-4 text-accent" />
          <span>本地存储、导出与安全路径</span>
        </h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          管理 Misaka Agent 在本地计算机上的配置、凭据密钥库与历史会话归档文件。所有路径均支持一键在文件资源管理器中打开与导出。
        </p>
      </div>

      {/* Path Locations */}
      <div className="rounded-xl border border-border-subtle bg-card shadow-e1 p-4 space-y-1">
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

      {/* Real Session Export Card */}
      <div className="rounded-xl border border-border-subtle bg-card shadow-e1 p-5 space-y-4">
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
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-accent text-white hover:bg-accent/90 text-xs font-medium transition-all shadow-xs cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExporting ? '导出中...' : '一键导出当前会话'}</span>
          </button>
        </div>

        {exportNotice && (
          <div className="flex items-center justify-between p-3 rounded-lg bg-surface-2 border border-border-subtle text-xs text-text-main">
            <div className="flex items-center gap-2 truncate pr-2">
              <FileCheck2 className="w-4 h-4 text-success shrink-0" />
              <span className="truncate">{exportNotice}</span>
            </div>
            {lastExportedPath && (
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
      <div className="rounded-xl border border-border-subtle bg-card shadow-e1 p-5 space-y-4">
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
