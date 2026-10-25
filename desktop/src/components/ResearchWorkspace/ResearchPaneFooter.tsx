import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { ResearchSessionTelemetry } from '../../types/research'
import { useAnchoredLayer } from '../../lib/useAnchoredLayer'
import { useDismiss } from '../../lib/useDismiss'
import { ESCAPE_PRIORITY, useHasHigherEscapeLayer } from '../../lib/useEscapeLayer'

export function ResearchPaneFooter({ telemetry, sessionLabel }: { telemetry: ResearchSessionTelemetry | null; sessionLabel?: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const initiallyFocused = useRef(false)
  const id = useId()
  const foregroundOpen = useHasHigherEscapeLayer(ESCAPE_PRIORITY.side)
  const higherDialogOpen = useHasHigherEscapeLayer(ESCAPE_PRIORITY.popover)
  const anchor = useAnchoredLayer(open, trigger, 'end', { placement: 'above', collision: true, width: 360, maxHeight: 480 })
  const close = () => {
    if (layer.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true })
    setOpen(false)
  }
  useDismiss(open, close, [root, layer], trigger)
  useEffect(() => {
    if (!open) { initiallyFocused.current = false; return }
    // Asynchronous approvals may arrive without a focus/pointer event. Dismiss without restoring
    // background-trigger focus: the higher dialog now owns visibility, focus and Escape.
    if (higherDialogOpen) { setOpen(false); return }
    if (!anchor || !foregroundOpen || initiallyFocused.current) return
    // The popover's Escape registration first yields an expanded reader's inertness/focus trap.
    // Focus only after that owner's layout effects have completed the foreground handoff.
    const expandedHost = trigger.current?.closest('[data-research-expanded-pane]')
    if (expandedHost && !expandedHost.hasAttribute('data-foreground-open')) return
    if (layer.current) {
      initiallyFocused.current = true
      layer.current.focus({ preventScroll: true })
    }
  }, [anchor, foregroundOpen, higherDialogOpen, open])

  const n = (value: number | null | undefined) => value == null ? '未知' : value.toLocaleString()
  const percent = (value: number | null | undefined) => value == null ? '未知' : `${Number(value.toFixed(1))}%`
  const context = telemetry?.contextUsage
  const groups = telemetry ? [
    { name: '模型', rows: [
      ['模型', telemetry.model ? `${telemetry.model.provider}/${telemetry.model.modelId}` : '未知'],
      ['思考级别', telemetry.thinkingLevel || '未知'],
    ] },
    { name: '上下文', rows: [
      ['上下文 Token', n(context?.tokens)], ['上下文窗口', n(context?.contextWindow)], ['上下文占用', percent(context?.percent)],
      ['自动压缩', telemetry.autoCompact == null ? '未知' : telemetry.autoCompact ? '开启' : '关闭'],
      ['压缩次数', n(telemetry.compactionCount)],
    ] },
    { name: '用量', rows: [
      ['输入 Token', n(telemetry.tokens.input)], ['输出 Token', n(telemetry.tokens.output)],
      ['缓存读取', n(telemetry.tokens.cacheRead)], ['缓存写入', n(telemetry.tokens.cacheWrite)],
      ...(telemetry.tokens.reasoning != null ? [['推理 Token', n(telemetry.tokens.reasoning)]] : []),
      ['缓存命中', percent(telemetry.cacheHitRate)],
      ['计费', telemetry.subscription == null ? '未知' : telemetry.subscription ? '订阅' : '按量'],
      ['费用', telemetry.subscription == null ? '未知' : telemetry.subscription ? '(sub)' : telemetry.cost == null ? '未知' : `$${telemetry.cost.toFixed(4)}`],
    ] },
    { name: '运行信息', rows: [['权限模式', telemetry.permissionMode || '未知'], ['工作目录', telemetry.cwd || '未知']] },
  ] : []
  const detailsLabel = sessionLabel ? `会话详情：${sessionLabel}` : '会话详情'
  return <footer ref={root} className="research-pane-footer" aria-label="会话遥测">
    <span className="research-context-label">上下文 {context?.percent == null ? '—' : percent(context.percent)}</span>
    <button ref={trigger} type="button" className="research-telemetry-entry" aria-label={`查看${detailsLabel}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => open ? close() : setOpen(true)}>详情</button>
    {open && anchor && createPortal(<div ref={layer} id={id} role="dialog" tabIndex={-1} aria-label={detailsLabel}
      className="research-telemetry-popover misaka-glass-popover" data-placement={anchor.placement}
      style={{ left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: anchor.maxHeight,
        transform: anchor.placement === 'above' ? 'translateY(-100%)' : undefined }}>
      <div className="research-telemetry-heading"><div><strong>会话详情</strong>{sessionLabel && <p>{sessionLabel}</p>}</div>
        <button type="button" aria-label="关闭会话详情" onClick={close}><X size={16} aria-hidden="true" /></button>
      </div>
      <div className="research-telemetry-content">{telemetry ? groups.map((group, index) => <section key={group.name} aria-labelledby={`${id}-${index}`}>
        <h3 id={`${id}-${index}`}>{group.name}</h3>
        <dl className="research-telemetry-grid">{group.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>) : <p>暂无会话遥测</p>}</div>
    </div>, document.body)}
  </footer>
}
