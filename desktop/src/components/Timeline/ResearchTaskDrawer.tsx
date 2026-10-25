import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Quote,
  RefreshCw,
  Terminal,
  X,
} from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { request } from '../../lib/bridge'
import type { ResearchArtifactDetail, ResearchExecutionInstance, ResearchExecutionPage, ResearchTaskDetail } from '../../types/research'
import { executionEntryToToolCall, instanceIsRunning, recordedTime, shouldPoll, terminalCommandOf } from '../../lib/researchExecution'
import { ToolCallRow } from './ToolCallCard'
import { MarkdownContent } from './MarkdownContent'

const POLL_MS = 2000
const PAGE_LIMIT = 100

const AVAILABILITY: Record<string, { label: string; tone: string }> = {
  available: { label: '', tone: '' },
  not_started: { label: '尚未开始执行', tone: 'text-dim' },
  missing: { label: '执行记录缺失', tone: 'text-warning' },
  interrupted: { label: '执行被中断', tone: 'text-warning' },
}

export const ResearchExecutionPanel: React.FC<{
  runId: string
  taskId: string
  workspace?: string
  sessionId?: string
  open: boolean
}> = ({ runId, taskId, workspace, sessionId, open }) => {
  const [page, setPage] = useState<ResearchExecutionPage | null>(null)
  const [instanceId, setInstanceId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const inFlight = useRef<Promise<unknown> | null>(null)
  // A response for the card the reader left must never land on the card they opened.
  const token = `${runId}|${taskId}|${instanceId ?? ''}`
  const owner = useRef(token)
  useEffect(() => { owner.current = token }, [token])

  const fetchPage = useCallback(async (cursor?: string | null) => {
    const expected = token
    const call = request<{ execution: ResearchExecutionPage | null }>('get_research_execution', {
      ...(sessionId ? { sessionId } : {}), runId, taskId, ...(workspace ? { workspace } : {}),
      ...(instanceId ? { instanceId } : {}), ...(cursor ? { cursor } : {}), limit: PAGE_LIMIT,
    })
    inFlight.current = call
    setLoading(true)
    try {
      const result = await call
      if (owner.current !== expected) return
      const execution = result.execution
      if (!execution) {
        setError('这条任务不属于当前研究，没有可读的执行记录。')
        setPage(null)
        return
      }
      setError(null)
      setRefreshedAt(Date.now())
      setPage(previous => {
        if (!cursor || !previous || previous.instanceId !== execution.instanceId) return execution
        const seen = new Set(previous.entries.map(entry => entry.toolCallId))
        return { ...execution, entries: [...previous.entries, ...execution.entries.filter(entry => !seen.has(entry.toolCallId))] }
      })
    } catch (failure) {
      if (owner.current !== expected) return
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (owner.current === expected) {
        inFlight.current = null
        setLoading(false)
      }
    }
  }, [instanceId, runId, sessionId, taskId, token, workspace])

  // The first read for a card, and again whenever the reader switches instance.
  useEffect(() => {
    if (!open) return
    setPage(null)
    setError(null)
    void fetchPage(null)
  }, [open, fetchPage])

  useEffect(() => { if (!open) setInstanceId(null) }, [open])

  // Poll only a live instance, never overlapping a request that has not come back.
  useEffect(() => {
    const instance = page?.instances.find(item => item.instanceId === (page.instanceId ?? page.instances[0]?.instanceId))
    if (!open || !page) return
    if (!shouldPoll({ open, instance, availability: page.availability })) return
    const timer = window.setInterval(() => {
      if (inFlight.current) return
      void fetchPage(null)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [open, page, fetchPage])

  const selected: ResearchExecutionInstance | undefined = page?.instances.find(item => item.instanceId === page.instanceId)
    ?? page?.instances[0]
  const availability = AVAILABILITY[page?.availability ?? 'available']

  return (
    <div className="border border-border-subtle rounded-xl overflow-hidden bg-surface-1" data-testid="research-execution-panel">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-subtle">
        <div className="flex items-center gap-2 min-w-0">
          <Terminal className="w-3.5 h-3.5 text-dim shrink-0" />
          <span className="font-medium text-text-main text-xs">执行记录与工具调用</span>
          {page && <span className="text-[10px] text-dim shrink-0">{page.entries.length} 条</span>}
          {availability.label && <span className={`text-[10px] shrink-0 ${availability.tone}`}>{availability.label}</span>}
        </div>
        <button
          type="button"
          onClick={() => void fetchPage(null)}
          disabled={loading || !open}
          aria-label="刷新执行记录"
          className="flex h-6 w-6 items-center justify-center rounded-md text-dim hover:bg-surface-2 hover:text-text-main disabled:opacity-40 cursor-pointer"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="p-3 space-y-2 max-h-72 overflow-y-auto bg-surface-2/40 text-[11px]">
        {error && <p role="alert" className="text-danger">{error}</p>}
        {loading && !page && <p className="text-dim">正在读取执行记录…</p>}

        {page && page.instances.length > 1 && (
          <label className="flex items-center gap-2 text-dim">
            <span className="shrink-0">执行实例</span>
            <select
              className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-1 px-1.5 py-1 text-[11px] text-text-main outline-none focus:border-accent"
              value={page.instanceId ?? selected?.instanceId ?? ''}
              onChange={event => setInstanceId(event.target.value)}
              aria-label="选择执行实例"
            >
              {page.instances.map(instance => (
                <option key={instance.instanceId} value={instance.instanceId}>
                  第 {instance.generation} 代 · 第 {instance.attempt} 次 · {instance.phase} · {instance.status}
                </option>
              ))}
            </select>
          </label>
        )}

        {page && selected && (
          <p className="text-dim" data-testid="execution-instance-meta">
            {instanceIsRunning(selected) ? '进行中' : '已结束'}
            {' · '}
            {recordedTime(selected.startedAt) ? `${recordedTime(selected.startedAt)} 开始` : '开始时间未记录'}
            {selected.failureKind ? ` · 失败原因 ${selected.failureKind}` : ''}
            {selected.exitCode !== null && selected.exitCode !== undefined ? ` · 退出码 ${selected.exitCode}` : ''}
          </p>
        )}

        {page?.reason && <p className="text-dim">{page.reason}</p>}

        {page && page.entries.length > 0 && (
          <ul className="space-y-1.5">
            {page.entries.map(entry => {
              const command = terminalCommandOf(entry)
              // ToolCallRow renders its own <li>; an outer <li> here nests lists and trips
              // React's hydration warning (Task 6). The record marker moves to a plain
              // container with role="listitem" inside the list.
              return (
                <div key={entry.toolCallId} role="listitem" data-execution-record={entry.toolCallId}>
                  {command && (
                    <pre className="mb-1 rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-[10.5px] text-text-main whitespace-pre-wrap break-all">
                      $ {command}
                    </pre>
                  )}
                  <ToolCallRow toolCall={executionEntryToToolCall(entry)} />
                  {entry.startedAt === null && <p className="mt-0.5 text-[10px] text-dim">时间未记录</p>}
                </div>
              )
            })}
          </ul>
        )}

        {page?.hasMore && (
          <button type="button" onClick={() => void fetchPage(page.nextCursor)}
            className="rounded-md border border-border-subtle px-2 py-1 text-[10.5px] text-accent hover:bg-surface-2 cursor-pointer">
            继续读取后续记录
          </button>
        )}

        {refreshedAt && page && !loading && (
          <p className="text-[10px] text-dim">读取于 {new Date(refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
        )}
      </div>
    </div>
  )
}

export const ResearchTaskDrawer: React.FC = () => {
  const activeTask = useSessionStore(s => s.activeResearchTaskId)
  const setActiveTask = useSessionStore(s => s.setActiveResearchTask)
  const currentWorkspace = useSessionStore(s => s.currentWorkspace)
  const researchSessionId = useSessionStore(s => s.researchBinding?.sessionId)
  const researchCard = useSessionStore(s => activeTask ? s.researchCards[activeTask.runId] : undefined)

  const [detail, setDetail] = useState<ResearchTaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedArtifact, setSelectedArtifact] = useState<ResearchArtifactDetail | null>(null)

  useEffect(() => {
    if (!activeTask) {
      setDetail(null)
      setSelectedArtifact(null)
      return
    }

    let live = true
    setLoading(true)
    setError(null)
    setDetail(null)
    setSelectedArtifact(null)
    const workspace = researchCard?.workspace || currentWorkspace

    void request<{ detail: ResearchTaskDetail }>('get_research_task', {
      runId: activeTask.runId,
      taskId: activeTask.taskId,
      workspace,
    })
      .then(res => {
        if (!live) return
        if (res.detail) {
          setDetail(res.detail)
        } else {
          setError('未找到任务详情')
        }
      })
      .catch(err => {
        if (!live) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (live) setLoading(false)
      })

    return () => {
      live = false
    }
  }, [activeTask, currentWorkspace, researchCard?.workspace])

  if (!activeTask) return null

  const isClosed = detail?.status === 'closed' || detail?.status === 'done'
  const isRunning = detail?.status === 'running'

  return (
    <div
      className="flex h-full w-[380px] flex-col border-l border-border-subtle bg-card text-xs select-none shadow-e3 animate-in slide-in-from-right duration-200"
      data-testid="research-task-drawer"
    >
      {/* Drawer Header */}
      <div className="flex items-center justify-between border-b border-border-subtle bg-surface-2/60 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-surface-3 text-text-main shrink-0">
            {isClosed ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-success" />
            ) : isRunning ? (
              <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
            ) : (
              <Clock className="w-3.5 h-3.5 text-dim" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-text-main text-xs truncate">
              {detail?.title || '任务详情'}
            </h2>
            <div className="text-[10px] text-muted font-mono flex items-center gap-1.5">
              <span>Sister {detail?.assignee || '专家'}</span>
              {detail?.round !== undefined && <span>· 第 {detail.round} 轮</span>}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setActiveTask(null)}
          aria-label="关闭任务抽屉"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-dim hover:bg-surface-3 hover:text-text-main transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Drawer Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="py-8 text-center text-dim text-xs">
            <Loader2 className="w-4 h-4 animate-spin mx-auto mb-2 text-accent" />
            <span>正在加载任务详情…</span>
          </div>
        )}

        {error && (
          <div className="p-3 rounded-xl bg-danger-surface border border-danger-border text-danger text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {detail && (
          <>
            {/* Task Objective */}
            <div className="p-3 rounded-xl bg-surface-2/40 border border-border-subtle space-y-1.5">
              <span className="text-[10.5px] font-semibold text-muted uppercase tracking-wider block">
                任务目标与指示
              </span>
              <p className="text-[12px] leading-relaxed text-text-main whitespace-pre-wrap">
                {detail.body || '无详细目标描述'}
              </p>
            </div>

            {/* Artifacts Produced */}
            {detail.artifacts && detail.artifacts.length > 0 && (
              <div className="space-y-2">
                <span className="text-[10.5px] font-semibold text-muted uppercase tracking-wider block">
                  产出文件 ({detail.artifacts.length})
                </span>
                <div className="space-y-1.5">
                  {detail.artifacts.map(artifact => (
                    <div
                      key={artifact.id}
                      className="p-2.5 rounded-xl border border-border-subtle bg-surface-1 hover:bg-surface-2 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="w-3.5 h-3.5 text-accent shrink-0" />
                          <span className="font-medium text-text-main truncate text-xs">
                            {artifact.title || artifact.path}
                          </span>
                        </div>
                        {artifact.content && (
                          <button
                            type="button"
                            onClick={() => setSelectedArtifact(selectedArtifact?.id === artifact.id ? null : artifact)}
                            className="text-[10.5px] text-accent hover:underline shrink-0"
                          >
                            {selectedArtifact?.id === artifact.id ? '收起' : '查看'}
                          </button>
                        )}
                      </div>
                      {selectedArtifact?.id === artifact.id && artifact.content && (
                        <div className="mt-2.5 pt-2.5 border-t border-border-subtle text-[11.5px] max-h-48 overflow-y-auto">
                          <MarkdownContent content={artifact.content} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Findings & Citations */}
            {detail.findings && detail.findings.length > 0 && (
              <div className="space-y-2">
                <span className="text-[10.5px] font-semibold text-muted uppercase tracking-wider block">
                  证据与核心发现 ({detail.findings.length})
                </span>
                <div className="space-y-2">
                  {detail.findings.map(finding => (
                    <div
                      key={finding.id}
                      className="p-3 rounded-xl border border-border-subtle bg-surface-1 space-y-2"
                    >
                      <p className="text-[12px] leading-relaxed text-text-main font-medium">
                        {finding.text}
                      </p>
                      {finding.citations && finding.citations.length > 0 && (
                        <div className="space-y-1 pt-1 border-t border-border-subtle/60">
                          {finding.citations.map((cite, cIdx) => (
                            <div key={cIdx} className="text-[10.5px] text-muted flex items-start gap-1.5">
                              <Quote className="w-3 h-3 text-accent shrink-0 mt-0.5" />
                              <span className="italic">“{cite.quote}”</span>
                              {cite.source_file && (
                                <span className="font-mono text-[10px] text-dim ml-auto shrink-0">
                                  ({cite.source_file})
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Execution / Tool Transcript */}
            <ResearchExecutionPanel
              runId={activeTask.runId}
              taskId={activeTask.taskId}
              workspace={researchCard?.workspace || currentWorkspace || undefined}
              sessionId={researchSessionId}
              open
            />
          </>
        )}
      </div>
    </div>
  )
}
