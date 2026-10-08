import type {
  ResearchFinding,
  ResearchRunCard,
  ResearchRunDetail,
  ResearchRunSummary,
  ResearchTaskSummary,
} from '../types/research'

export type { ResearchRunCard, ResearchTaskSummary }

export interface ResearchNotice {
  customType?: string
  content?: string
  details?: Record<string, any>
  timestamp?: number
}

function parseQuestionsFromContent(content?: string): string[] {
  if (!content) return []
  const lines = content.split('\n')
  const questions: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      questions.push(trimmed.slice(2).trim())
    }
  }
  return questions
}

export function applyResearchNoticeToCard(
  existingCard: ResearchRunCard | undefined,
  notice: ResearchNotice,
): ResearchRunCard {
  const customType = notice.customType || ''
  const details = notice.details || {}
  const runId = String(details.run_id || details.runId || existingCard?.runId || '')
  const now = notice.timestamp || Date.now()

  const card: ResearchRunCard = existingCard
    ? { ...existingCard, updatedAt: now }
    : {
        runId,
        question: String(details.question || ''),
        status: 'active',
        phase: 'active',
        tasks: [],
        findings: [],
        pendingQuestions: [],
        report: null,
        error: null,
        updatedAt: now,
      }

  if (details.workspace && !card.workspace) {
    card.workspace = String(details.workspace)
  }
  if (details.question) card.question = String(details.question)

  if (customType === 'research-discipline') {
    card.status = card.status === 'done' ? 'done' : 'active'
    card.phase = card.phase || 'active'
    if (details.run_id) card.runId = String(details.run_id)
  } else if (customType === 'research-question') {
    if (details.question) card.question = String(details.question)
    else if (notice.content) {
      card.question = notice.content.replace(/^Research question\s*\|\s*/i, '').trim()
    }
    if (details.workspace) card.workspace = String(details.workspace)
  } else if (customType === 'research-progress') {
    if (details.status || details.result?.status) card.status = String(details.status || details.result.status)
    if (details.stage !== 'startup_error' && card.status === 'waiting_input') {
      card.status = 'active'
      card.pendingQuestions = []
      card.error = null
    }
    if (details.stage) card.stage = String(details.stage)
    if (details.phase) card.phase = String(details.phase)
    else if (details.stage === 'startup_error') card.phase = 'error'

    if (details.stage === 'startup_error') {
      card.status = 'error'
      if (notice.content) card.error = notice.content
    }

    if (Array.isArray(details.tasks) && details.tasks.length > 0) {
      const taskMap = new Map<string, ResearchTaskSummary>()
      const identity = (id: string, nodeId?: string) => `${nodeId || ''}:${id}`
      for (const t of card.tasks) taskMap.set(identity(t.id, t.nodeId), t)

      for (const [index, t] of details.tasks.entries()) {
        const title = String(t.title || '')
        const assignee = String(t.assignee || '')
        const nodeId = String(t.node_id || t.nodeId || details.node_id || details.nodeId || '') || undefined
        // Legacy notices lack IDs; positional identities are scoped to the real node,
        // never merged by a human title which may repeat or change.
        const id = String(t.id || `legacy-${index}`)
        const key = identity(id, nodeId)
        const prev = taskMap.get(key)
        const summaryItem: ResearchTaskSummary = {
          id, nodeId,
          title: title || prev?.title || '任务',
          assignee: assignee || prev?.assignee || '专家',
          status: t.status ? String(t.status) : prev?.status || 'running',
          summary: t.summary ? String(t.summary) : prev?.summary,
          round: typeof t.round === 'number' ? t.round : prev?.round,
          attempt: typeof t.attempt === 'number' ? t.attempt : prev?.attempt,
        }
        taskMap.set(key, summaryItem)
      }
      card.tasks = Array.from(taskMap.values())
    }
  } else if (customType === 'research-clarification') {
    card.status = 'waiting_input'
    if (Array.isArray(details.questions)) {
      card.pendingQuestions = details.questions.map(String)
    } else {
      const parsed = parseQuestionsFromContent(notice.content)
      if (parsed.length > 0) card.pendingQuestions = parsed
    }
  } else if (customType === 'research-final') {
    card.status = String(details.result?.status || details.status || 'done')
    card.phase = String(details.result?.phase || details.phase || card.status)
    card.pendingQuestions = []
    card.error = details.result?.last_error || null
    card.report = {
      artifactId: details.final_artifact || details.result?.final_artifact || undefined,
      content: notice.content,
      path: details.result?.final?.path,
    }
  } else if (customType === 'research-error') {
    card.status = 'error'
    card.error = notice.content || '研究发生异常'
  }

  return card
}

export function hydrateCardFromDetail(
  existingCard: ResearchRunCard | undefined,
  detail: ResearchRunDetail,
): ResearchRunCard {
  const run = detail.run
  const card: ResearchRunCard = {
    ...(existingCard || {
      runId: run.id,
      question: run.question,
      status: run.status,
      phase: run.phase,
      tasks: [],
      findings: [],
      pendingQuestions: [],
      report: null,
      error: null,
      updatedAt: Date.now(),
    }),
    runId: run.id,
    question: run.question || existingCard?.question || '',
    workspace: run.workspace || existingCard?.workspace,
    status: run.status || existingCard?.status || 'active',
    phase: run.phase || existingCard?.phase || 'active',
    pendingQuestions: [],
    error: run.last_error || null,
    updatedAt: Date.now(),
  }

  // Extract tasks from all graph nodes
  const tasks: ResearchTaskSummary[] = []
  const findings: ResearchFinding[] = []
  if (detail.graph?.nodes) {
    for (const node of detail.graph.nodes) {
      if (Array.isArray(node.findings)) {
        findings.push(...node.findings)
      }
      if (Array.isArray(node.cards)) {
        for (const c of node.cards) {
          tasks.push({
            id: c.id,
            nodeId: node.id,
            title: c.title,
            assignee: c.assignee || 'Sister',
            status: c.status || 'running',
            attempt: c.attempt,
          })
        }
      }
    }
  }

  card.tasks = tasks
  card.findings = findings

  if (Array.isArray(detail.pending_questions) && detail.pending_questions.length > 0) {
    card.pendingQuestions = detail.pending_questions.map(q => q.question)
    card.status = 'waiting_input'
  }

  if (run.final_artifact) {
    const reportMeta = detail.graph?.final_artifacts?.find(a => a.id === run.final_artifact)
    card.report = {
      artifactId: run.final_artifact,
      title: reportMeta?.title,
      path: reportMeta?.path || undefined,
      content: existingCard?.report?.content,
    }
  }

  return card
}

export function hydrateCardsFromRuns(
  existing: Record<string, ResearchRunCard>,
  runs: ResearchRunSummary[],
): Record<string, ResearchRunCard> {
  const result = { ...existing }
  for (const run of runs) {
    const prev = result[run.id]
    result[run.id] = {
      runId: run.id,
      question: run.question || prev?.question || '',
      workspace: run.workspace || prev?.workspace,
      status: run.status || prev?.status || 'active',
      phase: run.phase || prev?.phase || 'active',
      tasks: prev?.tasks || [],
      findings: prev?.findings || [],
      pendingQuestions: run.status === 'waiting_input' ? prev?.pendingQuestions || [] : [],
      report: run.final_artifact
        ? {
            ...prev?.report,
            artifactId: run.final_artifact,
            content: prev?.report?.content,
          }
        : prev?.report || null,
      error: run.last_error || null,
      updatedAt: run.updatedAt || prev?.updatedAt || Date.now(),
    }
  }
  return result
}
