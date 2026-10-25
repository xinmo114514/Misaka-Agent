import { useContext, useId } from 'react'
import { ChevronRight, Terminal } from 'lucide-react'
import type { ChatMessage, ToolCall } from '../../types/session'
import type { ResearchSessionDescriptor } from '../../types/research'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { redactSecrets } from '../../lib/toolDisplay'
import { readableToolValue } from '../Timeline/ToolCallCard'
import { ResearchPagedField, useResearchPagedField } from './ResearchPagedField'
import { ResearchContentChangeContext } from './useResearchPaneReading'

type PreviewTool = ToolCall & { errorTruncated?: boolean; detailsTruncated?: boolean }

export function ResearchPaneTool({ runId, descriptor, message, tool }: {
  runId: string; descriptor: ResearchSessionDescriptor; message: ChatMessage; tool: PreviewTool
}) {
  const id = `${message.entryId || message.id}:${tool.id}`
  const contentId = useId()
  const open = useResearchSessionsStore(state => state.byExecutor[descriptor.executorId]?.folds[id] ?? false)
  const beforeChange = useContext(ResearchContentChangeContext)
  const args = typeof tool.arguments === 'string' ? tool.arguments
    : tool.arguments && Object.keys(tool.arguments).length ? JSON.stringify(tool.arguments, null, 2) : ''
  const result = readableToolValue(tool.result)
  const error = readableToolValue(tool.error)
  const argumentsState = useResearchPagedField({ runId, descriptor, entryId: tool.id, cacheEntryId: id, field: 'arguments', preview: args })
  const resultState = useResearchPagedField({ runId, descriptor, entryId: tool.id, cacheEntryId: id, field: 'result', preview: result,
    legacyCacheKey: !tool.error ? id : undefined })
  const errorState = useResearchPagedField({ runId, descriptor, entryId: tool.id, cacheEntryId: id, field: 'error', preview: error,
    legacyCacheKey: tool.error ? id : undefined })
  const errorTruncated = tool.errorTruncated ?? Boolean(tool.error && tool.result == null && tool.resultTruncated)
  const partial = readableToolValue(tool.partialResult)
  const details = readableToolValue(tool.details)
  const errors = [argumentsState.error, resultState.error, errorState.error].filter(Boolean)
  const hasFields = Boolean(args || tool.partialArguments || partial || result || details || error || tool.argumentsTruncated || tool.resultTruncated || errorTruncated)

  return <div className={`research-tool my-1 rounded-md border border-border-subtle bg-surface-1 ${tool.status === 'error' || tool.error ? 'research-tool--error' : ''}`}>
    <button type="button" aria-expanded={open} aria-controls={contentId} className="research-tool-heading" onClick={() => {
      beforeChange()
      useResearchSessionsStore.getState().setFold(descriptor.executorId, id, !open)
    }}><Terminal size={13} aria-hidden="true" /><span>{tool.name} · {tool.status}</span><ChevronRight size={12} className={open ? 'rotate-90' : ''} aria-hidden="true" /></button>
    {open && <div id={contentId} className="research-tool-fields">
      {(args || tool.argumentsTruncated) && <section aria-label="工具参数" className="research-tool-field"><h4>参数</h4>
        {tool.argumentsTruncated ? <ResearchPagedField state={argumentsState} initialLabel="读取完整参数" moreLabel="继续读取参数" completeLabel="完整参数已读取" redact /> : <pre>{redactSecrets(args)}</pre>}
      </section>}
      {tool.partialArguments && <section aria-label="实时工具参数" className="research-tool-field"><h4>实时参数</h4><pre>{redactSecrets(tool.partialArguments)}</pre></section>}
      {partial && <section aria-label="工具实时输出" className="research-tool-field"><h4>实时输出</h4><pre>{redactSecrets(partial)}</pre></section>}
      {(result || tool.resultTruncated && !error) && <section aria-label="工具输出" className="research-tool-field"><h4>输出</h4>
        {tool.resultTruncated ? <ResearchPagedField state={resultState} initialLabel="展开完整输出" moreLabel="继续读取" retryLabel="重试读取输出" completeLabel="完整输出已读取" redact /> : <pre>{redactSecrets(result)}</pre>}
      </section>}
      {details && <section aria-label="工具详情" className="research-tool-field"><h4>详情（记录预览）</h4><pre>{redactSecrets(details)}</pre>
        {tool.detailsTruncated && <p className="research-content-hint">详情为截断预览，当前接口尚未支持完整读取。</p>}
      </section>}
      {(error || errorTruncated) && <section aria-label="工具错误" className="research-tool-field research-tool-error"><h4>错误</h4>
        {errorTruncated ? <ResearchPagedField state={errorState} initialLabel={tool.result == null ? '展开完整输出' : '读取完整工具错误'}
          moreLabel="继续读取工具错误" retryLabel="重试读取工具错误" completeLabel="完整工具错误已读取" redact /> : <pre>{redactSecrets(error)}</pre>}
      </section>}
      {!hasFields && <p className="research-content-hint">暂无详细输出</p>}
    </div>}
    {!open && errors.map((failure, index) => <p key={index} role="alert" className="research-content-error">{failure}</p>)}
  </div>
}
