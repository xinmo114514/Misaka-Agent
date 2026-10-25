import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../types/session'
import type { ResearchConnectionProbeResult, ResearchConnectionRoute } from '../../types/research'
import { useSessionStore } from '../../store/useSessionStore'
import { requestResearch } from '../../lib/researchBridge'
import { redactSecrets } from '../../lib/toolDisplay'

function sanitized(text: string): string {
  return redactSecrets(text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1••••@'))
}

function routeText(route: ResearchConnectionRoute): string {
  return sanitized(route.mode === 'proxy'
    ? `代理：${route.proxy || '未记录代理地址'}；模型端点：${route.endpoint}` : `直连：${route.endpoint}`)
}

interface Props { message: ChatMessage; retryDisabled: boolean }

/** A transport/navigation or failure change retires the previous probe and its result. */
export function ResearchStartupFailure({ message, retryDisabled }: Props) {
  const sessionId = useSessionStore(s => s.researchBinding?.sessionId)
  const streamId = useSessionStore(s => s.researchBinding?.streamId)
  const pageVersion = useSessionStore(s => s.researchPageVersion)
  const key = JSON.stringify([sessionId, streamId, pageVersion, message.id, message.requestId,
    message.submissionError, message.executionError, message.errorCode, message.errorStage, message.errorDetails, message.researchNeedsConfiguration])
  return <FailureControls key={key} message={message} retryDisabled={retryDisabled} sessionId={sessionId} streamId={streamId} />
}

function FailureControls({ message, retryDisabled, sessionId, streamId }: Props & { sessionId?: string; streamId?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<ResearchConnectionProbeResult | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const alive = useRef(true)
  const busy = useRef(false)
  const retry = useSessionStore(s => s.retryResearchMessage)
  const restore = useSessionStore(s => s.restoreResearchMessageDraft)
  const restoreDisabled = useSessionStore(s => s.isSessionLoading || Boolean(s.sessionLoadError) || s.researchConversation.isAborting ||
    Boolean(s.researchPendingCreationRequestId))
  const hasRun = useSessionStore(s => Boolean(s.researchBinding?.runId))
  const needsConfiguration = message.researchNeedsConfiguration || !message.researchSubmission
  const details = message.errorDetails
  const summary = sanitized(message.submissionError || message.executionError || '研究启动失败，原始课题已保留。')
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const probe = async () => {
    if (busy.current || !sessionId) return
    busy.current = true
    setChecking(true)
    setResult(null)
    setProbeError(null)
    try {
      const next = await requestResearch<ResearchConnectionProbeResult>('check_research_connection', {
        sessionId, ...(streamId ? { streamId } : {}),
      })
      if (alive.current) setResult(next)
    } catch (error) {
      if (alive.current) setProbeError(sanitized(error instanceof Error ? error.message : String(error)))
    } finally {
      if (alive.current) { busy.current = false; setChecking(false) }
    }
  }

  return <section aria-label="研究启动错误" className="mt-2 space-y-2 rounded-lg border border-border-subtle bg-surface-2/40 p-3 text-xs">
    <p role="status" className="text-warning">{summary}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
        className="rounded-md border border-border-subtle px-2 py-1 hover:bg-surface-2">{expanded ? '收起详情' : '查看详情'}</button>
      <button type="button" onClick={probe} disabled={checking || !sessionId}
        className="rounded-md border border-border-subtle px-2 py-1 hover:bg-surface-2 disabled:opacity-40">{checking ? '检查中…' : '检查连接'}</button>
      {!hasRun && (needsConfiguration
        ? <button type="button" disabled={restoreDisabled} onClick={() => restore(message.id)}
            className="rounded-md border border-border-subtle px-2 py-1 hover:bg-surface-2 disabled:opacity-40">恢复到草稿</button>
        : <button type="button" disabled={retryDisabled} onClick={() => retry(message.id)}
            className="rounded-md border border-border-subtle px-2 py-1 hover:bg-surface-2 disabled:opacity-40">重试启动</button>)}
    </div>
    {expanded && <div className="space-y-2 text-muted">
      {details ? <>
        <p>{sanitized(`角色：${details.role}；模型：${details.provider} / ${details.modelId}；尝试：${details.attempt}；类别：${details.category}`)}</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{sanitized(details.message)}</pre>
        {details.stack && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{sanitized(details.stack)}</pre>}
        {details.diagnostics?.length ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{sanitized(JSON.stringify(details.diagnostics, null, 2))}</pre> : null}
        {details.route && <p className="break-all">{routeText(details.route)}</p>}
        {details.configurationError && <p>{sanitized(details.configurationError)}</p>}
      </> : <p>此记录未保存模型错误详情。</p>}
      {message.errorCode && <p>{sanitized(`${message.errorCode} · ${message.errorStage || 'startup'}`)}</p>}
    </div>}
    {needsConfiguration && <p className="text-muted">原记录缺少完整启动参数。恢复课题后，请点击正常发送按钮打开参数向导，再确认启动。</p>}
    {result && <div role="status" className="space-y-1 text-muted">
      <p className="break-all">{result.route ? routeText(result.route) : '连接地址配置有误，尚未解析到有效路由。'}</p>
      <p>{result.reachable ? 'TCP端口可达。TCP连通仅说明端口可达，尚未验证鉴权或模型推理。' : 'TCP端口不可达，尚未验证鉴权或模型推理。'}</p>
      {result.error && <pre className="whitespace-pre-wrap break-words">{sanitized(result.error)}</pre>}
    </div>}
    {probeError && <p role="status" className="text-warning">连接检查失败：{probeError}</p>}
    <p className="text-dim">代理服务恢复后可直接重试启动；如修改了进程环境变量，请完整重启应用后再试。检查连接不会调用模型，也不会更换代理或模型。</p>
  </section>
}
