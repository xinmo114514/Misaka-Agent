import { describe, expect, it } from 'vitest'
import {
  applyResearchNoticeToCard,
  hydrateCardFromDetail,
  hydrateCardsFromRuns,
} from './researchCards'
import type { ResearchRunCard, ResearchRunDetail, ResearchRunSummary } from '../types/research'

describe('researchCards event mapping and hydration', () => {
  it.each(['partial', 'stopped', 'error'])('keeps final report status %s and actual task statuses', status => {
    const card = applyResearchNoticeToCard({ runId: 'r1', question: 'Q', status: 'active', phase: 'executing', tasks: [{ id: 't1', title: 'T', status: 'running', assignee: 'A' }], updatedAt: 1 }, {
      customType: 'research-final', content: 'A partial report', details: { run_id: 'r1', result: { status, final: { path: '/report.md' } } },
    })
    expect(card.status).toBe(status)
    expect(card.tasks[0].status).toBe('running')
    expect(card.report?.path).toBe('/report.md')
  })

  it('merges tasks by ID and node scope, not shared titles', () => {
    let card = applyResearchNoticeToCard(undefined, { customType: 'research-progress', details: { run_id: 'r1', tasks: [
      { id: 't1', node_id: 'n1', title: 'Review', status: 'closed' }, { id: 't2', node_id: 'n1', title: 'Review', status: 'running' },
      { id: 't1', node_id: 'n2', title: 'Review', status: 'pending' },
    ] } })
    card = applyResearchNoticeToCard(card, { customType: 'research-progress', details: { run_id: 'r1', tasks: [{ id: 't2', node_id: 'n1', title: 'Renamed', status: 'closed' }] } })
    expect(card.tasks).toHaveLength(3)
    expect(card.tasks.find(t => t.id === 't2')?.title).toBe('Renamed')
  })

  it('hydrates report metadata without declaring partial work done or retaining stale questions/errors', () => {
    const existing: ResearchRunCard = { runId: 'r1', question: 'Q', status: 'waiting_input', phase: 'waiting_input', tasks: [], pendingQuestions: ['old'], error: 'old error', updatedAt: 1 }
    const detail: ResearchRunDetail = { run: { id: 'r1', question: 'Q', workspace: '/ws', status: 'partial', phase: 'stopped', nodes: 1, tasks: 0, final_artifact: 'a1', last_error: null },
      graph: { run: 'r1', question: 'Q', status: 'partial', phase: 'stopped', nodes: [], final_artifacts: [{ id: 'a1', kind: 'report', title: 'Partial', path: '/report', state: 'available' }] }, pending_questions: [] }
    const card = hydrateCardFromDetail(existing, detail)
    expect(card.status).toBe('partial')
    expect(card.phase).toBe('stopped')
    expect(card.pendingQuestions).toEqual([])
    expect(card.error).toBeNull()
    expect(card.report?.title).toBe('Partial')
    const resumed = hydrateCardsFromRuns({ r1: existing }, [{ ...detail.run, status: 'active', phase: 'executing', final_artifact: null }]).r1
    expect(resumed.pendingQuestions).toEqual([])
    expect(resumed.error).toBeNull()
  })
  it('initializes a new card on research-discipline', () => {
    const card = applyResearchNoticeToCard(undefined, {
      customType: 'research-discipline',
      content: 'Research mode is on for run r_123',
      details: { run_id: 'r_123' },
    })
    expect(card).toBeDefined()
    expect(card.runId).toBe('r_123')
    expect(card.status).toBe('active')
    expect(card.phase).toBe('active')
    expect(card.tasks).toEqual([])
  })

  it('updates stage, phase, and tasks on research-progress', () => {
    const initial: ResearchRunCard = {
      runId: 'r_123',
      question: 'Comparison question',
      status: 'active',
      phase: 'active',
      tasks: [],
      updatedAt: 100,
    }
    const updated = applyResearchNoticeToCard(initial, {
      customType: 'research-progress',
      content: 'Research r_123 | Dispatched literature reviews',
      details: {
        run_id: 'r_123',
        stage: 'critique',
        message: 'Reviewing evidence citations',
        tasks: [
          { title: '文献检索', assignee: 'literature-reviewer' },
          { title: '证据核验', assignee: 'fact-checker' },
        ],
      },
    })
    expect(updated.stage).toBe('critique')
    expect(updated.tasks).toHaveLength(2)
    expect(updated.tasks[0]).toMatchObject({
      title: '文献检索',
      assignee: 'literature-reviewer',
      status: 'running',
    })
    expect(updated.tasks[1]).toMatchObject({
      title: '证据核验',
      assignee: 'fact-checker',
      status: 'running',
    })
  })

  it('records clarification questions on research-clarification', () => {
    const initial: ResearchRunCard = {
      runId: 'r_123',
      question: 'Comparison question',
      status: 'active',
      phase: 'active',
      tasks: [],
      updatedAt: 100,
    }
    const updated = applyResearchNoticeToCard(initial, {
      customType: 'research-clarification',
      content: 'Research run needs clarification:\n- 是否限定在 2024 年以后的文献？\n- 是否包含私有基准测试？',
      details: {
        run_id: 'r_123',
        questions: ['是否限定在 2024 年以后的文献？', '是否包含私有基准测试？'],
      },
    })
    expect(updated.status).toBe('waiting_input')
    expect(updated.pendingQuestions).toEqual([
      '是否限定在 2024 年以后的文献？',
      '是否包含私有基准测试？',
    ])
  })

  it('records final report on research-final', () => {
    const initial: ResearchRunCard = {
      runId: 'r_123',
      question: 'Comparison question',
      status: 'active',
      phase: 'critique',
      tasks: [{ id: 't1', title: '文献检索', assignee: 'S1', status: 'running' }],
      updatedAt: 100,
    }
    const updated = applyResearchNoticeToCard(initial, {
      customType: 'research-final',
      content: '# Delivered final report\n\nFull conclusions...',
      details: {
        run_id: 'r_123',
        final_artifact: 'a_report',
      },
    })
    expect(updated.status).toBe('done')
    expect(updated.phase).toBe('done')
    expect(updated.report).toMatchObject({
      artifactId: 'a_report',
      content: '# Delivered final report\n\nFull conclusions...',
    })
  })

  it('records error on research-error', () => {
    const initial: ResearchRunCard = {
      runId: 'r_123',
      question: 'Comparison question',
      status: 'active',
      phase: 'active',
      tasks: [],
      updatedAt: 100,
    }
    const updated = applyResearchNoticeToCard(initial, {
      customType: 'research-error',
      content: 'Research run paused: Network error',
      details: { run_id: 'r_123' },
    })
    expect(updated.status).toBe('error')
    expect(updated.error).toBe('Research run paused: Network error')
  })

  it('hydrates card from ResearchRunDetail with graph nodes and tasks', () => {
    const detail: ResearchRunDetail = {
      run: {
        id: 'r_456',
        question: 'RAG analysis',
        workspace: 'C:/research',
        status: 'active',
        phase: 'branches',
        nodes: 2,
        tasks: 3,
        final_artifact: null,
      },
      graph: {
        run: 'r_456',
        question: 'RAG analysis',
        status: 'active',
        phase: 'branches',
        nodes: [
          {
            id: 'n_root',
            question: 'Root question',
            depth: 0,
            status: 'running',
            kind: 'root',
            parents: [],
            children: [],
            cards: [
              {
                id: 't_card_1',
                title: '综述文献',
                status: 'closed',
                assignee: 'reviewer',
              },
              {
                id: 't_card_2',
                title: '红队审查',
                status: 'running',
                assignee: 'red-team',
              },
            ],
          },
        ],
      },
      pending_questions: [],
    }

    const card = hydrateCardFromDetail(undefined, detail)
    expect(card.runId).toBe('r_456')
    expect(card.question).toBe('RAG analysis')
    expect(card.workspace).toBe('C:/research')
    expect(card.tasks).toHaveLength(2)
    expect(card.tasks[0]).toMatchObject({
      id: 't_card_1',
      title: '综述文献',
      status: 'closed',
      assignee: 'reviewer',
    })
    expect(card.tasks[1]).toMatchObject({
      id: 't_card_2',
      title: '红队审查',
      status: 'running',
      assignee: 'red-team',
    })
  })

  it('hydrates multiple cards from run summaries', () => {
    const existing: Record<string, ResearchRunCard> = {
      r_old: {
        runId: 'r_old',
        question: 'Old topic',
        status: 'done',
        phase: 'done',
        tasks: [],
        updatedAt: 50,
      },
    }
    const summaries: ResearchRunSummary[] = [
      {
        id: 'r_1',
        question: 'First run',
        workspace: 'C:/ws1',
        status: 'active',
        phase: 'plan',
        nodes: 1,
        tasks: 2,
      },
      {
        id: 'r_old',
        question: 'Old topic updated',
        workspace: 'C:/ws_old',
        status: 'done',
        phase: 'done',
        nodes: 3,
        tasks: 5,
      },
    ]

    const hydrated = hydrateCardsFromRuns(existing, summaries)
    expect(hydrated.r_1).toBeDefined()
    expect(hydrated.r_1.question).toBe('First run')
    expect(hydrated.r_old).toBeDefined()
    expect(hydrated.r_old.question).toBe('Old topic updated')
  })
})
