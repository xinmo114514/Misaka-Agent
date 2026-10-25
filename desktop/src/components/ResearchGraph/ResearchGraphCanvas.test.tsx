import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ResearchGraphCanvas } from './ResearchGraphCanvas'
import { useSessionStore } from '../../store/useSessionStore'
import { useResearchActivityStore, researchActivity } from '../../lib/researchActivityStore'
const mocks=vi.hoisted(()=>({request:vi.fn(),legacyGraph:vi.fn(),legacyList:vi.fn()}))
vi.mock('../../lib/bridge',()=>({request:mocks.request,newRequestId:()=> 'test'}))
vi.mock('../../theme/useThemeTokens',()=>({useThemeTokens:()=>({})}))
vi.mock('./ResearchNodeComponent',()=>({ResearchNodeComponent:()=>null}))
vi.mock('@xyflow/react',async()=>{const React=await import('react');return {ReactFlow:({nodes}:any)=><div>{nodes.map((node:any)=><span key={node.id}>{node.data.question}</span>)}</div>,Background:()=>null,Controls:()=>null,MiniMap:()=>null,MarkerType:{ArrowClosed:'arrow'},useNodesState:(value:any)=>[...React.useState(value),()=>{}],useEdgesState:(value:any)=>[...React.useState(value),()=>{}]}})
const run={id:'new',question:'New run',workspace:'/new',status:'active',phase:'active',tasks:0,nodes:1}
const graph={run:'new',question:'New run',status:'active',phase:'active',nodes:[{id:'n',question:'New graph node',depth:0,status:'planning',kind:'root',parents:[],children:[]}]}
beforeEach(()=>{vi.useFakeTimers();mocks.request.mockReset().mockImplementation(async(type:string)=>type==='get_research_details'?{run,graph}:{runs:[run]});mocks.legacyGraph.mockClear();useSessionStore.setState({researchCards:{},researchRuns:[run],researchRunId:'old',researchGraph:{...graph,run:'old',nodes:[{...graph.nodes[0],question:'Old graph node'}]} as any,fetchResearchGraph:mocks.legacyGraph,fetchResearchRuns:mocks.legacyList});useResearchActivityStore.setState({details:{new:{run,graph} as any},errors:{},lastSuccess:{}})})
afterEach(()=>{cleanup();researchActivity.stop();vi.useRealTimers()})
it('uses the explicitly selected run rather than an unrelated global graph',()=>{render(<ResearchGraphCanvas {...{runId:'new',showRunPicker:false}}/>);expect(screen.getByText('New graph node')).toBeInTheDocument();expect(screen.queryByText('Old graph node')).not.toBeInTheDocument()})
it('two graph views share one detail refresh without an independent graph timer',async()=>{render(<><ResearchGraphCanvas {...{runId:'new',showRunPicker:false}}/><ResearchGraphCanvas {...{runId:'new',showRunPicker:false}}/></>);await act(async()=>{await vi.advanceTimersByTimeAsync(1)});expect(mocks.request.mock.calls.filter(([type])=>type==='get_research_details')).toHaveLength(1);await act(async()=>{await vi.advanceTimersByTimeAsync(4000)});expect(mocks.request.mock.calls.filter(([type])=>type==='get_research_details')).toHaveLength(2);expect(mocks.legacyGraph).not.toHaveBeenCalled()})
