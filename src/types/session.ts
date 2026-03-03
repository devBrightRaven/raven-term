export type AgentEventType = 'tool_start' | 'tool_end' | 'thinking' | 'result' | 'error'
export type AgentStatusType = 'idle' | 'thinking' | 'running' | 'done' | 'error'
export type AgentEventSource = 'sdk' | 'hook' | 'pty'

export interface AgentEvent {
  agentId: string        // 'main' | 'sub-{id}'
  type: AgentEventType
  toolName?: string
  input?: Record<string, unknown>
  timestamp: number
  source: AgentEventSource
}

export interface AgentStatus {
  agentId: string
  currentTool?: string
  status: AgentStatusType
  recentEvents: AgentEvent[]  // capped at 50
}

export interface SessionState {
  sessionId: string
  workspaceId: string
  label: string
  mainAgent: AgentStatus
  subAgents: AgentStatus[]
  startedAt: number
  totalCost: number
  totalTokens: number
}

export interface SessionLabel {
  sessionId: string
  label: string
  workspaceId: string
  updatedAt: number
}
