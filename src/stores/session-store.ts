import type { AgentEvent, SessionState } from '../types/session'

type Listener = () => void

class SessionStore {
  private sessions = new Map<string, SessionState>()
  private listeners = new Set<Listener>()
  private unsubEvent: (() => void) | null = null
  private unsubUpdate: (() => void) | null = null

  init(): void {
    this.unsubEvent = window.electronAPI.session.onEvent((sessionId, rawEvent) => {
      const event = rawEvent as AgentEvent
      const session = this.sessions.get(sessionId)
      if (!session) return
      this.sessions.set(sessionId, applyEventToSession(session, event))
      this.notify()
    })

    this.unsubUpdate = window.electronAPI.session.onUpdate((sessionId, rawState) => {
      const state = rawState as SessionState
      this.sessions.set(sessionId, state)
      this.notify()
    })
  }

  dispose(): void {
    this.unsubEvent?.()
    this.unsubUpdate?.()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)
  }

  listSessions(workspaceId: string): SessionState[] {
    return [...this.sessions.values()].filter(s => s.workspaceId === workspaceId)
  }

  async loadSessions(workspaceId: string): Promise<void> {
    const list = await window.electronAPI.session.list(workspaceId) as SessionState[]
    for (const s of list) {
      this.sessions.set(s.sessionId, s)
    }
    this.notify()
  }

  async renameSession(sessionId: string, label: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      this.sessions.set(sessionId, { ...session, label })
      this.notify()
    }
    await window.electronAPI.session.rename(sessionId, label)
  }

  async generateHooks(): Promise<void> {
    await window.electronAPI.session.generateHooks()
  }
}

function applyEventToSession(session: SessionState, event: AgentEvent): SessionState {
  if (event.agentId === 'main') {
    return { ...session, mainAgent: applyEventToAgent(session.mainAgent, event) }
  }

  const existing = session.subAgents.find(a => a.agentId === event.agentId)
  if (existing) {
    return {
      ...session,
      subAgents: session.subAgents.map(a =>
        a.agentId === event.agentId ? applyEventToAgent(a, event) : a
      ),
    }
  }
  return {
    ...session,
    subAgents: [...session.subAgents, applyEventToAgent(
      { agentId: event.agentId, status: 'idle', recentEvents: [] },
      event,
    )],
  }
}

function applyEventToAgent(
  agent: SessionState['mainAgent'],
  event: AgentEvent,
): SessionState['mainAgent'] {
  const events = [...agent.recentEvents, event]
  const capped = events.length > 50 ? events.slice(-50) : events
  switch (event.type) {
    case 'tool_start': return { ...agent, currentTool: event.toolName, status: 'running', recentEvents: capped }
    case 'tool_end':   return { ...agent, currentTool: undefined, status: 'idle', recentEvents: capped }
    case 'thinking':   return { ...agent, status: 'thinking', recentEvents: capped }
    case 'result':     return { ...agent, status: 'done', currentTool: undefined, recentEvents: capped }
    case 'error':      return { ...agent, status: 'error', currentTool: undefined, recentEvents: capped }
    default:           return { ...agent, recentEvents: capped }
  }
}

export const sessionStore = new SessionStore()
