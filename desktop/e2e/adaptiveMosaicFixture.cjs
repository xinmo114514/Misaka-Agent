/** Isolated UI projection and stream fixtures; never calls a model or writes a research file. */
exports.adaptiveMosaicFixtureInit = function adaptiveMosaicFixtureInit(options = {}) {
  const previous = Object.getOwnPropertyDescriptor(window, 'bridge')
  let projectedBridge
  const requests = new Map(), commands = [], descriptors = new Map(), researchListeners = new Set()
  const memberCount = options.memberCount ?? 4
  let sequence = 10000
  window.adaptiveMosaicFixture = {
    members: () => [...descriptors.values()].filter(item => item.role === 'sister').map(item => item.executorId),
    commands: () => structuredClone(commands),
    stream: (ticks = 1) => {
      for (let tick = 0; tick < ticks; tick++) for (const descriptor of descriptors.values()) {
        const id = descriptor.executorId
        const snapshot = { runId: 'r_desktop_fixture', executorId: id, sessionId: descriptor.sessionId,
          nodeId: descriptor.nodeId, taskId: descriptor.taskId, generation: descriptor.generation, attempt: descriptor.attempt,
          revision: ++sequence, historyVersion: id === 'lo-root' ? 'v1:2' : 'v1:2', availability: 'available',
          telemetry: descriptor.telemetry, error: null, runtimeSource: 'live',
          streaming: { id: `${id}-stream`, role: 'assistant', content: `并行核验 ${id} STREAM_${ticks}_${tick}。` + '持续核验证据与边界。'.repeat(tick + 1), isStreaming: true, timestamp: 10000 } }
        for (const callback of researchListeners) callback({ seq: sequence, streamId: 'fixture-research-stream', event: { type: 'research_session_snapshot', snapshot } })
      }
    },
  }
  Object.defineProperty(window, 'bridge', {
    configurable: true,
    get: () => projectedBridge,
    set: value => {
      previous.set.call(window, value)
      const base = previous.get.call(window)
      projectedBridge = {
      send: command => { requests.set(command.requestId, command); commands.push(structuredClone(command)); base.send(command) },
      on: callback => base.on(message => {
        if (message.type === 'ack' && message.data?.runId && Array.isArray(message.data?.sessions)) {
          const data = structuredClone(message.data), nodeId = data.graph.nodes[0]?.id
          const actual = data.sessions.filter(item => item.nodeId === nodeId && item.role === 'sister')
          if (memberCount > actual.length && actual.length) {
            for (let index = actual.length; index < memberCount; index++) {
              const id = `mosaic-extra-${index + 1}`
              const member = { ...structuredClone(actual[0]), executorId: id, sessionId: `session-${id}`,
                sessionFile: `C:/research/.misaka/sessions/${id}.jsonl`, taskId: `task-${id}`, label: `成员任务 ${index + 1}`,
                cardTitle: `成员任务 ${index + 1} · 独立证据核验`, isCurrent: true, status: 'ready', generation: 0, attempt: 1,
                endedAt: null, startedAt: Date.now() }
              data.sessions.push(member); actual.push(member)
            }
          }
          descriptors.clear()
          for (const item of data.sessions.filter(item => item.nodeId === nodeId)) descriptors.set(item.executorId, item)
          message = { ...message, data }
        }
        const command = requests.get(message.requestId)
        if (message.type === 'ack' && command?.type === 'get_research_session_history' && message.data?.messages) {
          const data = structuredClone(message.data), root = data.executorId === 'lo-root'
          if (options.shortController && root) data.messages = [
            { id: 'mosaic-short-u', entryId: 'mosaic-short-u', role: 'user', content: '比较两条证据路线。', timestamp: 1 },
            { id: 'mosaic-short-a', entryId: 'mosaic-short-a', role: 'assistant', content: '主控已拆分任务，等待独立核验。MOSAIC_ROOT_END', timestamp: 2 },
          ]
          if (options.longMembers && !root) data.messages = [
            { id: `${data.executorId}-long`, entryId: `${data.executorId}-long`, role: 'assistant', timestamp: 2,
              content: '成员完整阅读记录。\n\n' + Array.from({ length: 35 }, (_, index) => `### 证据 ${index + 1}\n\n核验来源、任务边界与不同解释，保留完整上下文。`).join('\n\n') + '\n\nMOSAIC_MEMBER_END' },
          ]
          if (data.executorId.startsWith('mosaic-extra-')) { data.availability = 'available'; data.telemetry = descriptors.get(data.executorId)?.telemetry ?? null }
          message = { ...message, data }
        }
        callback(message)
      }),
    } },
  })
  let researchBridge
  Object.defineProperty(window, 'researchBridge', { configurable: true, get: () => researchBridge,
    set: value => { researchBridge = {
      send: command => { commands.push(structuredClone(command)); value.send(command) },
      on: callback => { researchListeners.add(callback); const unsubscribe = value.on(callback); return () => { researchListeners.delete(callback); unsubscribe?.() } },
    } },
  })
}
