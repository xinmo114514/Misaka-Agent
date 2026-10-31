import fs from 'node:fs'
import path from 'node:path'
import type { FixtureTurn } from './researchRecruitmentFixture'

const prose = '# Test-material comparison\nBoth test sources record the meeting date. A records ten attendees; B records twelve including two staff. The counting boundaries differ. Neither source supplies independent corroboration.\n\n## Sources\nTEST-A.md\nTEST-B.md\n'
const text = (value = prose): FixtureTurn => ({blocks:[{type:'text',text:value}]})
const call = (name: string,input: Record<string,unknown>): FixtureTurn => ({blocks:[{type:'tool_use',name,input}]})
function plain(value:any):string {
  if(typeof value==='string') return value
  if(Array.isArray(value)) return value.map(plain).join('\n')
  return value?.text ? String(value.text) : value?.content ? plain(value.content) : ''
}
function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(directory,item.name)):[path.join(directory,item.name)])
}
/** Scripted model only: the app still recruits, claims workers, reviews, registers and persists artifacts. */
export function completeModelFixture(home: string) {
  return (payload: {messages:any[];tools?:any[];system?:unknown}): FixtureTurn => {
    const offered = new Set((payload.tools ?? []).map(tool=>tool.name))
    const messages = payload.messages.map(row=>plain(row.content)).join('\n')
    const last = payload.messages.at(-1)
    const prompt = plain(last?.content ?? '')
    const system = plain(payload.system ?? '')
    const used = (name:string) => payload.messages.some(row=>row.role==='assistant' && Array.isArray(row.content) && row.content.some((block:any)=>block.type==='tool_use' && block.name===name))
    if (offered.has('misaka_card_complete')) {
      if (!used('write')) {
        const packet = `${system}\n${messages}`
        const output = packet.match(/Write every new deliverable under `([^`]+)`/)?.[1]
        const delivery = packet.match(/## deliverable[ \t]*\r?\n([^\n]+)/i)?.[1]?.trim()
          ?? packet.match(/Deliver `([^`]+)`/)?.[1]?.split(/[\\/]/).at(-1)
        if (!output || !delivery) throw new Error('Model fixture: worker deliverable contract was not exposed')
        return call('write',{path:path.join(output,path.basename(delivery.replace(/`/g,''))),content:prose})
      }
      const critique=/red-team the (?:conclusion|saved final-report draft) at/i.test(messages)
      const divergence=/Read the conclusion at[^\n]*through the choices it made/.test(messages)
      const evidenceRequested = /Record final evidence-backed findings|Record the red-team issues|Record the alternatives/.test(prompt)
      if (!used('misaka_card_note') || evidenceRequested) return call('misaka_card_note',{text:'Test materials checked; bounded findings and limitations recorded.',
        findings:[],uncertain:['The fixture materials have no independent corroboration.'],
        ...(critique ? {issues:[]} : {}),...(divergence ? {alternatives:[]} : {})})
      // Native reviews deliberately ask their author to check file vs recorded
      // issues once before submission. Obey the genuine retry prompt, rather than
      // ending the model turn after that expected first-call rejection.
      if (/Before this review is submitted/.test(prompt)) return call('misaka_card_complete',{
        summary:'Checked that the review file and recorded issue/alternative lists agree; explicit evidence limitations retained.'})
      if (!used('misaka_card_complete') || /Logged on the card/.test(prompt)) return call('misaka_card_complete',{summary:'Delivered the bounded local-material comparison/review with explicit evidence limitations.'})
      return text('The contract deliverable is complete.')
    }
    if (last?.role==='user' && Array.isArray(last.content) && last.content.some((block:any)=>block.type==='tool_result')) return text('The command was recorded.')
    if (offered.has('misaka_research_report')) return call('misaka_research_report',{markdown:prose})
    if (offered.has('misaka_research_reconcile') && /Reconcile this level/.test(prompt)) return call('misaka_research_reconcile',{summary:'The single bounded node is complete; no branches are needed.'})
    if (offered.has('misaka_research_decide') && /Decide what|decisions=\[\]|node does next/i.test(prompt)) return call('misaka_research_decide',{decisions:[],declined:[]})
    if (offered.has('misaka_research_dispose') && /Dispose of/.test(prompt)) return call('misaka_research_dispose',{dispositions:[]})
    if (offered.has('misaka_research_assign') && /Read the live workspace view before planning|Plan this research|plan its own research/.test(prompt)) {
      const teams=walk(path.join(home,'state','sessions')).filter(file=>file.endsWith('desktop-team'+path.sep+'team.json'))
      const team=teams.map(file=>JSON.parse(fs.readFileSync(file,'utf8'))).at(-1)
      const members=team?.members ?? []
      const reader=members.find((member:any)=>member.name==='fixture-reader'), reviewer=members.find((member:any)=>member.name==='fixture-reviewer')
      if (!reader || !reviewer) throw new Error('Model fixture: recruited private members not found')
      return call('misaka_research_assign',{status:'ready',plan_markdown:'Compare the two short local test materials. The reviewer critiques the conclusion and then performs divergence review. Coverage check: no external sources are needed; independence and counting boundaries remain limitations.',
        tasks:[{local_id:'comparison',title:'Compare the local sources',question:'Which facts agree and where do counts differ?',rationale:'A bounded comparison answers the test question.',deliverable:'findings.md\nShared facts, discrepancy and limitations.',assignee:reader.name,assignee_reason:'Reads the two local sources.'}],
        red_team:{assignee:reviewer.name,reason:'Fits both evidence critique and divergence review.'}})
    }
    if (offered.has('desktop_recruit_agent') && !used('desktop_recruit_agent')) return {blocks:['fixture-reader','fixture-reviewer'].map(name=>({type:'tool_use' as const,name:'desktop_recruit_agent',input:{name,responsibility:'Compare/review the local test materials',goal:'Bounded comparison and review',instructions:'Use only TEST-A.md and TEST-B.md.'}}))}
    return text()
  }
}
