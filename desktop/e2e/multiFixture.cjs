/** Browser-only projection shaping; all transcript IDs still come from the real UI fixture. */
exports.multiFixtureInit = function multiFixtureInit(options) {
  let bridge
  Object.defineProperty(window, 'bridge', {
    configurable: true,
    get: () => bridge,
    set: value => {
      bridge = {
        send: command => {
          if (options.loading && command.type === 'get_research_sessions') return
          value.send(command)
        },
        on: callback => value.on(message => {
          if (options.longHistory && message.type === 'ack' && message.data?.executorId && Array.isArray(message.data?.messages)) {
            const data = structuredClone(message.data)
            data.messages = Array.from({ length: 12 }, (_, index) => data.messages.map(row => ({
              ...row, id: `${row.id}-reading-${index}`, entryId: `${row.entryId || row.id}-reading-${index}`,
              blocks: row.blocks?.map(block => ({ ...block, id: `${block.id}-reading-${index}` })),
            }))).flat()
            callback({ ...message, data })
            return
          }
          if (message.type === 'ack' && message.data?.runId && Array.isArray(message.data?.sessions)) {
            if (options.error) {
              callback({ ...message, ok: false, error: 'multi fixture read failure' })
              return
            }
            const data = structuredClone(message.data)
            const nodeId = data.graph.nodes[0]?.id
            const controller = data.sessions.find(item => item.nodeId === nodeId && item.role === 'last_order')
            const pool = [
              ...data.sessions.filter(item => item.role === 'sister'),
              ...data.sessions.filter(item => item.role === 'last_order' && item.executorId !== controller?.executorId),
            ]
            const members = pool.slice(0, options.memberCount ?? 4).map((item, index) => ({
              ...item, nodeId, role: 'sister', taskId: `multi-polish-task-${index}`,
              label: `成员任务 ${index + 1}`, cardTitle: `成员任务 ${index + 1} · ${item.cardTitle || item.label}`,
              isCurrent: options.history && index === 0 ? false : true,
              contract: item.contract || `# 成员任务 ${index + 1}\n保留独立证据、来源与研究结论。`,
            }))
            const changedIds = new Set(members.map(item => item.executorId))
            data.sessions = [
              ...(!options.noController && controller ? [controller] : []),
              ...members,
              ...data.sessions.filter(item => item.executorId !== controller?.executorId && !changedIds.has(item.executorId)),
            ]
            window.multiPolishFixture = { rootId: controller?.executorId, memberIds: members.map(item => item.executorId), nodeId }
            callback({ ...message, data })
            return
          }
          callback(message)
        }),
      }
    },
  })
}
