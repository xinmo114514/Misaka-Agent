import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

/**
 * A de-identified replay of the event shape recorded for the frozen session
 * (`01a12604-995a-78f3-9ead-4a87cee33d83`, 2026-10-10). Argument byte counts are the ones actually
 * persisted; every word is invented. Two of the six recruitment calls carried `responsible` instead
 * of `responsibility`, `RecruitAgent` forbids extras, and the model re-sent those two — that is what
 * the reader was looking at (an execution lane reading 已完成 0/6) when the window stopped answering.
 */
export const RECRUIT_ARG_BYTES = [2221, 2327, 2086, 1850, 2183, 2173]
export const RETRY_ARG_BYTES = [2186, 2176]
/** The two calls the model mis-labelled in the recorded session (index into RECRUIT_ARG_BYTES). */
export const INVALID_CALLS = [1, 3]
/** The recorded session streamed ~13.3 KiB of arguments in 19.08s; a 16-char piece lands near here. */
export const RECORDED_PACE_MS_PER_CHUNK = 22
/** One 17,274-byte argument blob, as the recorded planning turn carried at 21:36:16. */
export const PLANNING_ARG_BYTES = 17_274

export type FixtureBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }

/** One scripted model answer: a whole assistant message, as a provider would stream it. */
export interface FixtureTurn { blocks: FixtureBlock[]; httpError?: { status: number; message: string; type: string } }

function filler(seed: number, chars: number): string {
  // Deterministic, content-free padding: the point is byte volume, not meaning.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 '
  let out = ''
  let cursor = seed * 7 + 3
  while (out.length < chars) {
    cursor = (cursor * 1103515245 + 12345) % 2147483648
    out += alphabet[cursor % alphabet.length]
  }
  return out.slice(0, chars)
}

/** A recruitment payload whose serialized arguments weigh `bytes`, as recorded. */
export function recruitInput(index: number, bytes: number, valid = true): Extract<FixtureBlock, {type:'tool_use'}> {
  const key = valid ? 'responsibility' : 'responsible'
  const shape = {
    name: `fixture-role-${index + 1}`,
    [key]: filler(index, 180),
    goal: filler(index + 50, 160),
    instructions: 'x',
  }
  const overhead = JSON.stringify(shape).length - 1
  const base = { ...shape, instructions: '' }
  const fixed = JSON.stringify(base).length
  base.instructions = filler(index + 91, Math.max(1, bytes - fixed))
  return { type: 'tool_use', name: 'desktop_recruit_agent', input: base }
}

/** The recorded first recruitment message: prose plus six parallel calls in one assistant turn. */
export function recruitmentTurn(): FixtureTurn {
  return {
    blocks: [
      { type: 'text', text: 'Recruiting six task specialists for the fixture question.' },
      ...RECRUIT_ARG_BYTES.map((bytes, index) => recruitInput(index, bytes, !INVALID_CALLS.includes(index))),
    ],
  }
}

/** The recorded retry message: the two calls the validator rejected, sent again with the right field. */
export function retryTurn(): FixtureTurn {
  return {
    blocks: RETRY_ARG_BYTES.map((bytes, index) => recruitInput(INVALID_CALLS[index] ?? index, bytes, true)),
  }
}

/** A turn that asks the reader a question, so the run reaches a real terminal state. */
export function clarificationTurn(): FixtureTurn {
  return {
    blocks: [{ type: 'tool_use', name: 'misaka_research_assign', input: {
      status: 'clarify', plan_markdown: 'Original fixture question. Goal: provenance.', tasks: [],
      clarifying_questions: ['Which collection should be examined first?'],
    } }],
  }
}

/** The single 17 KiB argument blob the recorded session reached during planning. */
export function planningTurn(): FixtureTurn {
  const input = { status: 'plan', plan_markdown: filler(3, PLANNING_ARG_BYTES - 60), tasks: [] as unknown[] }
  return { blocks: [{ type: 'tool_use', name: 'misaka_research_assign', input }] }
}

export function defaultTurns(): FixtureTurn[] {
  return [recruitmentTurn(), retryTurn(), clarificationTurn()]
}

function chunkString(value: string, size: number): string[] {
  const out: string[] = []
  for (let cursor = 0; cursor < value.length; cursor += size) out.push(value.slice(cursor, cursor + size))
  return out
}

/**
 * One turn as Anthropic SSE events. A tool's `input_json_delta` is split into `chunkChars` pieces
 * because that is what a real provider does — and every piece makes the engine emit one
 * `message_update` that carries the whole message accumulated so far.
 */
export function sseEvents(turn: FixtureTurn, model: string, id: number, chunkChars = 16): Record<string, unknown>[] {
  const stopReason = turn.blocks.every(block => block.type === 'text') ? 'end_turn' : 'tool_use'
  const events: Record<string, unknown>[] = [
    { type: 'message_start', message: { id: `fixture-message-${id}`, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  ]
  turn.blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const piece of chunkString(block.text, chunkChars)) {
        events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
      }
      events.push({ type: 'content_block_stop', index })
      return
    }
    const callId = `fixture-call-${id}-${index}`
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: callId, name: block.name, input: {} } })
    for (const piece of chunkString(JSON.stringify(block.input), chunkChars)) {
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } })
    }
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } })
  events.push({ type: 'message_stop' })
  return events
}

export interface FixtureRequest { model: string; messages: unknown; path: string; toolNames?: string[] }
export interface FixtureResponse { events: number; bytes: number; paced: boolean }

export interface FixtureProvider {
  home: string
  workspace: string
  port: number
  requests: FixtureRequest[]
  responses: FixtureResponse[]
  close(): Promise<void>
}

export interface ProviderOptions {
  profile: string
  turns?: FixtureTurn[]
  /** Dynamic model boundary for concurrent worker/phase requests; never mutates engine state. */
  respond?: (payload: {model: string; messages: any[]; tools?: any[]; system?: unknown}, request: number) => FixtureTurn
  chunkChars?: number
  /** 0 writes the whole SSE body in one buffer (a burst); the recorded session sat near 22ms. */
  paceMs?: number
  /** Cut a response off after this many events: the provider stream ended before it completed. */
  truncateAfterEvents?: number
}

/**
 * A local provider that answers with scripted SSE, plus the home files that point Misaka at it.
 * Nothing here needs a real account; the point is the shape and volume the engine then puts on the
 * bridge's stdout.
 */
export async function createFixtureProvider(options: ProviderOptions): Promise<FixtureProvider> {
  const home = path.join(options.profile, 'home')
  const workspace = path.join(options.profile, 'workspace')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const turns = [...(options.turns ?? defaultTurns())]
  const requests: FixtureRequest[] = []
  const responses: FixtureResponse[] = []
  const server = http.createServer((request, response) => {
    const pieces: Buffer[] = []
    request.on('data', chunk => pieces.push(Buffer.from(chunk)))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(pieces).toString('utf8')) as { model: string; messages: any[]; tools?: any[]; system?: unknown }
      requests.push({ model: payload.model, messages: payload.messages, path: request.url || '', toolNames:payload.tools?.map(tool=>String(tool.name)) })
      let turn: FixtureTurn | undefined
      try { turn = options.respond ? options.respond(payload, requests.length) : turns.shift() }
      catch (error) {
        response.writeHead(500)
        response.end(JSON.stringify({error:{type:'fixture_contract_error',message:String(error)}}))
        return
      }
      if (!turn) {
        response.writeHead(500)
        response.end('Fixture provider has no scripted turn left.')
        return
      }
      if (turn.httpError) {
        const body = JSON.stringify({ error: { type: turn.httpError.type, message: turn.httpError.message } })
        response.writeHead(turn.httpError.status, { 'Content-Type': 'application/json' })
        responses.push({ events: 0, bytes: Buffer.byteLength(body), paced: false })
        response.end(body)
        return
      }
      const events = sseEvents(turn, payload.model, requests.length, options.chunkChars ?? 16)
      const limited = options.truncateAfterEvents ? events.slice(0, options.truncateAfterEvents) : events
      const line = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      const body = limited.map(line).join('')
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      responses.push({ events: limited.length, bytes: Buffer.byteLength(body), paced: (options.paceMs ?? 0) > 0 })
      const pace = options.paceMs ?? 0
      if (pace <= 0) { response.end(body); return }
      let cursor = 0
      const pump = () => {
        if (response.destroyed) return
        if (cursor >= limited.length) { response.end(); return }
        response.write(line(limited[cursor]))
        cursor += 1
        setTimeout(pump, pace)
      }
      pump()
    })
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture provider did not bind a TCP port')
  const providerBase = `http://127.0.0.1:${address.port}/fixture`
  fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: providerBase, api: 'anthropic-messages', apiKey: 'fixture-not-a-real-key',
    models: [{ id: 'fixture-model', name: 'Fixture Model', reasoning: false, input: ['text'],
      contextWindow: 200000, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), 'utf8')
  const settings = { defaultProvider: 'fixture', defaultModel: 'fixture-model', retry: { enabled: false } }
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings), 'utf8')
  fs.mkdirSync(path.join(home, 'profiles', 'last_order'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'last_order', 'settings.json'), JSON.stringify(settings), 'utf8')
  return {
    home, workspace, port: address.port, requests, responses,
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

/** Windows keeps a handle on a just-exited process's directory for a moment. */
export async function removeProfile(profile: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(profile, { recursive: true, force: true }); return }
    catch { await new Promise(resolve => setTimeout(resolve, 500)) }
  }
  process.stderr.write(`fixture: could not remove ${profile}\n`)
}

/** One bridge envelope, exactly as `desktop/electron/main.ts` hands it to the renderer. */
export interface FixtureEnvelope {
  seq: number
  sessionId: string
  streamId: string
  mainSentAt: number
  mainBytes: number
  event: Record<string, unknown>
}

export interface EnvelopeOptions {
  sessionId: string
  streamId: string
  startSeq: number
  /** All rows in one message share a timestamp, as the engine's do. */
  timestampBase?: number
  argBytes?: number[]
  chunkChars?: number
  /** How many of the calls the validator rejects, in the recorded run it was the 2nd and 4th. */
  invalid?: number[]
  /** Append the team snapshot and the settle event, as the real host does. */
  team?: boolean
}

function seal(envelope: Omit<FixtureEnvelope, 'mainBytes'>): FixtureEnvelope {
  // main.ts stamps the serialized line length; the renderer can only report a backlog against it.
  const probe = { ...envelope, mainBytes: 0 }
  return { ...probe, mainBytes: JSON.stringify(probe).length }
}

/**
 * The bridge-level event stream for one assistant message holding N parallel recruitment calls:
 * a `message_update` per streamed argument piece, each carrying the whole accumulated snapshot (as
 * `MessageUpdateEvent.message` does), then the tool executions and their results.
 */
export function recruitmentEnvelopes(options: EnvelopeOptions): FixtureEnvelope[] {
  const { sessionId, streamId } = options
  const argBytes = options.argBytes ?? RECRUIT_ARG_BYTES
  const invalid = options.invalid ?? [...INVALID_CALLS]
  const chunkChars = options.chunkChars ?? 64
  const timestamp = options.timestampBase ?? 1_760_000_000_000
  let seq = options.startSeq
  const out: FixtureEnvelope[] = []
  const emit = (event: Record<string, unknown>) => {
    out.push(seal({ seq: seq++, sessionId, streamId, mainSentAt: timestamp, event }))
  }
  const content: Record<string, unknown>[] = [{ type: 'text', text: 'Recruiting the fixture team.' }]
  const calls = argBytes.map((bytes, index) => ({
    id: `fixture-call-${timestamp}-${index}`,
    name: 'desktop_recruit_agent',
    pieces: chunkString(JSON.stringify(recruitInput(index, bytes, !invalid.includes(index)).input), chunkChars),
  }))

  emit({ type: 'agent_start' })
  emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp } })
  emit({ type: 'message_update', message: { role: 'assistant', content: [...content], timestamp },
    assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
  emit({ type: 'message_update', message: { role: 'assistant', content: [...content], timestamp },
    assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Recruiting the fixture team.' } })

  calls.forEach((call, index) => {
    const contentIndex = index + 1
    content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: {} })
    emit({ type: 'message_update', message: { role: 'assistant', content: content.map(block => ({ ...block })), timestamp },
      assistantMessageEvent: { type: 'toolcall_start', contentIndex, id: call.id, toolName: call.name } })
    let partial = ''
    for (const piece of call.pieces) {
      partial += piece
      // The engine parses the accumulated JSON when it can and keeps the previous object when it
      // cannot; the snapshot below is the whole message, which is what makes the stream quadratic.
      let parsed: unknown = null
      try { parsed = JSON.parse(partial) } catch { /* an unfinished argument blob stays unparsed */ }
      content[contentIndex] = { type: 'toolCall', id: call.id, name: call.name,
        arguments: (parsed ?? (content[contentIndex] as { arguments: unknown }).arguments) as Record<string, unknown> }
      emit({ type: 'message_update', message: { role: 'assistant', content: content.map(block => ({ ...block })), timestamp },
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex, id: call.id, delta: piece } })
    }
    emit({ type: 'message_update', message: { role: 'assistant', content: content.map(block => ({ ...block })), timestamp },
      assistantMessageEvent: { type: 'toolcall_end', contentIndex, toolCall: { ...content[contentIndex] } } })
  })

  emit({ type: 'message_end', message: { role: 'assistant', content: content.map(block => ({ ...block })),
    timestamp, stopReason: 'tool_use' } })
  calls.forEach((call, index) => {
    const rejected = invalid.includes(index)
    emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name,
      args: (content[index + 1] as { arguments: Record<string, unknown> }).arguments })
    emit({ type: 'tool_execution_update', toolCallId: call.id, toolName: call.name,
      args: {}, partialResult: { content: [{ type: 'text', text: 'validating role definition…' }] } })
    emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, isError: rejected,
      result: rejected
        ? { content: [{ type: 'text', text: '1 validation error for RecruitAgent\nresponsible\n  Extra inputs are not permitted' }] }
        : { content: [{ type: 'text', text: `Task-local member registered: fixture-role-${index + 1}` }] } })
    emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      isError: rejected, timestamp, content: rejected
        ? [{ type: 'text', text: '1 validation error for RecruitAgent\nresponsible\n  Extra inputs are not permitted' }]
        : [{ type: 'text', text: `Task-local member registered: fixture-role-${index + 1}` }] } })
  })

  if (options.team !== false) {
    // The bridge publishes the controller's team snapshot beside the transcript, and the reader's
    // roster panel re-renders from it; the recorded run did this after every recruitment call.
    emit({ type: 'desktop-team', details: { team: {
      teamId: sessionId, scene: 'desktop_research',
      members: argBytes.map((bytes, index) => ({
        id: `fixture-member-${index}`, name: `fixture-role-${index + 1}`, kind: 'task_agent',
        status: 'ready', responsibility: filler(index, 120), goal: filler(index + 5, 90),
        instructions: filler(index + 9, Math.min(bytes, 600)), tools: ['read', 'web_search'], skills: [],
        taskIds: [`t_${index}`],
      })),
    } } })
  }
  emit({ type: 'agent_settled' })
  return out
}

export function makeProfile(prefix: string): string {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const resolved = path.resolve(profile)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix.replace(/-$/, ''))) {
    throw new Error('Unexpected temporary profile')
  }
  return resolved
}
