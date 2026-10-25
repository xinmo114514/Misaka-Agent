/** Read-only browser fixture enrichment. No real model, filesystem or backend is executed. */
exports.paneDetailsFixtureInit = function paneDetailsFixtureInit(options = {}) {
  const previous = Object.getOwnPropertyDescriptor(window, 'bridge')
  const listeners = new Set()
  const fullReport = '# 研究报告 ROOT_REPORT_BEGIN\n\n' + '中文证据与边界🙂。'.repeat(6000) + '\n\nROOT_REPORT_END'
  const bytes = new TextEncoder().encode(fullReport)
  const reportPreview = new TextDecoder().decode(bytes.slice(0, 32768)).replace(/\uFFFD$/, '')
  let pageRequests = 0
  window.paneDetailsFixture = { pageRequests: () => pageRequests }
  Object.defineProperty(window, 'bridge', {
    configurable: true,
    get: () => previous.get.call(window),
    set: value => previous.set.call(window, {
      send: command => {
        if (command.type === 'get_research_session_content' && command.entryId === 'pane-details-report') {
          pageRequests++
          const fail = options.failFirstPage && pageRequests === 1
          const points = Array.from(fullReport)
          const start = command.offset || 0
          let part = '', used = 0
          for (const point of points.slice(start)) {
            const size = new TextEncoder().encode(point).length
            if (used + size > (command.limit || 8192)) break
            used += size; part += point
          }
          const end = start + Array.from(part).length
          queueMicrotask(() => listeners.forEach(callback => callback(fail
            ? { type: 'ack', requestId: command.requestId, ok: false, error: 'fixture report temporarily unavailable' }
            : { type: 'ack', requestId: command.requestId, ok: true, data: { content: part, nextOffset: end < points.length ? end : null, hasMore: end < points.length } })))
          return
        }
        value.send(command)
      },
      on: callback => {
        const deliver = message => {
          if (message.type === 'ack' && message.data?.runId && Array.isArray(message.data?.sessions)) {
            const data = structuredClone(message.data)
            for (const session of data.sessions) if (session.telemetry) {
              session.telemetry.model = { provider: 'fixture-provider', modelId: 'research-controller-very-long-model-name-reasoning-edition-2026' }
              session.telemetry.contextUsage = { tokens: 16000, contextWindow: 128000, percent: options.unknownPercent ? null : options.zeroPercent ? 0 : 12.5 }
              if (options.longPath) session.telemetry.cwd = 'C:/研究工作区/' + 'long-research-evidence-directory/'.repeat(12) + 'ROOT_PATH_END'
              if (options.withoutTelemetry) session.telemetry = null
            }
            message = { ...message, data }
          }
          if (message.type === 'ack' && message.data?.executorId === 'lo-root' && Array.isArray(message.data?.messages)) {
            const data = structuredClone(message.data)
            if (options.richContent !== false) data.messages = [
              ...(options.retainMessages ? data.messages : []),
              { id: 'pane-details-user', entryId: 'pane-details-user', role: 'user', timestamp: 1000, content: '核验两条证据路线并保留完整研究过程。' },
              { id: 'pane-details-assistant', entryId: 'pane-details-assistant', role: 'assistant', timestamp: 2000,
                errorMessage: '执行重试记录 ROOT_ASSISTANT_ERROR', blocks: [
                  { id: 'details-begin', type: 'text', contentIndex: 0, text: '起始推演 ROOT_BEGIN：先核验独立证据，再交叉比较。', isStreaming: false },
                  { id: 'details-thinking', type: 'thinking', contentIndex: 1, thinking: '检查证据边界 ROOT_THINKING', isStreaming: false },
                  { id: 'details-tool', type: 'toolCall', contentIndex: 2, toolCall: { id: 'details-plan-call', name: 'plan_research', status: 'error',
                    arguments: { plan: '研究设计完整参数 ROOT_ARGUMENTS', apiKey: 'sk-fixture-123456789012345678901234567890' },
                    partialResult: '实时进展 ROOT_PARTIAL', result: '结构化结论 ROOT_RESULT', details: { evidence: '引用追踪 ROOT_DETAILS' }, error: '重试说明 ROOT_ERROR' } },
                  { id: 'details-after', type: 'text', contentIndex: 3, text: '后续结论 ROOT_AFTER：按已读取的证据修正研究判断。', isStreaming: false },
                ] },
              { id: 'pane-details-report', entryId: 'pane-details-report', role: 'custom', customType: 'research-final', display: true, timestamp: 3000,
                content: options.longReport ? reportPreview : '# 阶段报告\n\n可读的研究结论 ROOT_REPORT_SHORT。', contentTruncated: Boolean(options.longReport),
                details: { run_id: 'r_desktop_fixture', incomplete: true, result: { status: 'partial' }, reason: '证据仍待补齐 ROOT_INCOMPLETE' } },
            ]
            if (data.telemetry) {
              data.telemetry.model = { provider: 'fixture-provider', modelId: 'research-controller-very-long-model-name-reasoning-edition-2026' }
              data.telemetry.contextUsage = { tokens: 16000, contextWindow: 128000, percent: options.unknownPercent ? null : options.zeroPercent ? 0 : 12.5 }
              if (options.longPath) data.telemetry.cwd = 'C:/研究工作区/' + 'long-research-evidence-directory/'.repeat(12) + 'ROOT_PATH_END'
              if (options.withoutTelemetry) data.telemetry = null
            }
            message = { ...message, data }
          }
          callback(message)
        }
        listeners.add(deliver)
        const unsubscribe = value.on(deliver)
        return () => { listeners.delete(deliver); unsubscribe?.() }
      },
    }),
  })
}
