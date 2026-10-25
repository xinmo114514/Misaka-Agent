import { FileCheck2, ListChecks } from 'lucide-react'
import type { ChatMessage, MessageBlock } from '../../types/session'
import type { ResearchSessionDescriptor } from '../../types/research'
import { getMessageBlocks } from '../../lib/messageBlocks'
import { redactSecrets } from '../../lib/toolDisplay'
import { MarkdownContent } from '../Timeline/MarkdownContent'
import { readableToolValue } from '../Timeline/ToolCallCard'
import { ResearchPagedBody } from './ResearchPagedField'
import { ResearchPaneTool } from './ResearchPaneTool'

type PreviewMessage = ChatMessage & { thinkingTruncated?: boolean; errorMessageTruncated?: boolean }

function ReportState({ message }: { message: ChatMessage }) {
  const details = message.details
  const status = details?.result?.status ?? details?.status
  const incomplete = details?.incomplete === true || Boolean(status && status !== 'done')
  if (!incomplete) return null
  const reasons = [...new Set([details?.reason, details?.reasons, details?.incompleteReason, details?.incompleteReasons,
    details?.error, details?.last_error, details?.result?.reason, details?.result?.reasons, details?.result?.last_error]
    .map(readableToolValue).filter(Boolean).map(redactSecrets))]
  return <div className="research-report-state" role="status"><strong>不完整报告</strong>
    {status && <span>状态：{String(status)}</span>}{reasons.map(reason => <p key={reason}>{reason}</p>)}
  </div>
}

export function ResearchPaneMessage({ runId, descriptor, message, initialBrief = false }: {
  runId: string; descriptor: ResearchSessionDescriptor; message: PreviewMessage; initialBrief?: boolean
}) {
  const phase = message.customType === 'research-phase'
  const report = message.customType === 'research-final'
  const compacted = message.customType === 'session-compacted'
  const blocks = message.role === 'assistant' ? getMessageBlocks(message) : null
  const textBlocks = blocks?.filter(block => block.type === 'text') ?? []
  const truncated = Boolean(message.contentTruncated && message.entryId)
  const anchor = (id: string) => JSON.stringify([message.entryId || message.id, id])
  const thinking = (text: string, key: string) => <details key={key} data-research-reading-anchor={anchor(key)}>
    <summary className="cursor-pointer text-dim">思考过程</summary>
    {message.thinkingTruncated && <p className="research-content-hint">思考过程为截断预览，当前接口尚未支持完整读取。</p>}
    <p className="whitespace-pre-wrap text-muted">{redactSecrets(text)}</p>
  </details>
  const body = (text: string, streaming?: boolean) => truncated
    ? <ResearchPagedBody runId={runId} descriptor={descriptor} entryId={message.entryId!} field="content" preview={text} label="读取完整消息" isStreaming={streaming} />
    : <MarkdownContent content={text} isStreaming={streaming} />
  const renderBlock = (block: MessageBlock) => {
    if (block.type === 'thinking') return thinking(block.thinking, block.id)
    return <div key={block.id} data-research-reading-anchor={anchor(block.id)}>
      {block.type === 'toolCall' ? <ResearchPaneTool runId={runId} descriptor={descriptor} message={message} tool={block.toolCall} />
        : textBlocks.length === 1 ? body(block.text, block.isStreaming ?? message.isStreaming)
          : <MarkdownContent content={block.text} isStreaming={block.isStreaming ?? message.isStreaming} />}
    </div>
  }
  const nonAssistantBody = <div data-research-reading-anchor={anchor('body')}>{message.content && body(message.content, message.isStreaming)}</div>

  return <article className={`research-message ${report ? 'research-message--report' : phase ? 'research-message--phase' : message.role === 'custom' ? 'research-message--notice' : ''}`}>
    <div className="research-message-label">{report ? <><FileCheck2 size={12} aria-hidden="true" />研究报告</> : compacted ? '上下文已压缩'
      : message.role === 'custom' ? (phase ? '阶段说明' : message.customType === 'research-progress' ? '调度记录' : message.customType === 'research-question' ? '研究课题' : '研究通知')
        : message.role === 'assistant' ? 'Agent' : message.role === 'user' ? '任务输入' : message.role}</div>
    {report && <ReportState message={message} />}
    {blocks ? blocks.map(renderBlock) : <>
      {phase || initialBrief ? <details className="research-phase-disclosure"><summary><ListChecks size={13} aria-hidden="true" />{phase ? '查看本阶段指令与约束' : '查看完整研究任务说明'}</summary>{nonAssistantBody}</details> : nonAssistantBody}
      {message.thinking && thinking(message.thinking, 'thinking')}
      {(message.toolCalls ?? message.blocks?.filter(block => block.type === 'toolCall').map(block => block.toolCall) ?? []).map(tool =>
        <div key={tool.id} data-research-reading-anchor={anchor(tool.id)}><ResearchPaneTool runId={runId} descriptor={descriptor} message={message} tool={tool} /></div>)}
    </>}
    {blocks && truncated && textBlocks.length > 1 && <section className="research-full-message" aria-label="完整消息正文" data-research-reading-anchor={anchor('full-content')}>
      <h4>完整消息正文</h4><p className="research-content-hint">上方保留消息原序预览；此处单独读取合并正文。</p>
      <ResearchPagedBody runId={runId} descriptor={descriptor} entryId={message.entryId!} field="content"
        preview={message.content || textBlocks.map(block => block.text).join('')} label="读取完整消息" revealOnRead isStreaming={message.isStreaming} />
    </section>}
    {message.errorMessage && <div className="research-message-error" data-research-reading-anchor={anchor('error')}>
      <p role="status">{redactSecrets(message.errorMessage)}</p>
      {message.errorMessageTruncated && <p className="research-content-hint">执行错误为截断预览，当前接口尚未支持完整读取。</p>}
    </div>}
  </article>
}
