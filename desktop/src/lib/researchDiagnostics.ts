export interface ResearchSubmissionDiagnostic {
  requestId: string
  type: string
  chars: number
  blank: boolean
  startsWithSlash: boolean
  sessionId: string | null
}

const submissions: Readonly<ResearchSubmissionDiagnostic>[] = []

/** Keep only shape/identity evidence; prompt bodies and extra properties never enter the ring. */
export function recordResearchSubmissionDiagnostic(input: { requestId: string; text: unknown; sessionId?: string | null }): void {
  const text = typeof input.text === 'string' ? input.text : ''
  submissions.push(Object.freeze({ requestId: input.requestId, type: typeof input.text, chars: text.length,
    blank: !text.trim(), startsWithSlash: text.trimStart().startsWith('/'), sessionId: input.sessionId ?? null }))
  if (submissions.length > 100) submissions.splice(0, submissions.length - 100)
}

export function getResearchSubmissionDiagnostics(): ReadonlyArray<Readonly<ResearchSubmissionDiagnostic>> {
  return submissions.slice()
}
