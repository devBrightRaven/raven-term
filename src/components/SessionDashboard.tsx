import { useState, useEffect, useCallback } from 'react'
import { sessionStore } from '../stores/session-store'
import type { AgentStatus, SessionState } from '../types/session'

interface SessionDashboardProps {
  sessionId: string
  workspaceId: string
}

const STATUS_COLOR: Record<string, string> = {
  idle: '#6b7280',
  thinking: '#f59e0b',
  running: '#3b82f6',
  done: '#10b981',
  error: '#ef4444',
}

function AgentColumn({ agent, title }: { agent: AgentStatus; title: string }) {
  const dot = STATUS_COLOR[agent.status] ?? '#6b7280'
  const recent = agent.recentEvents.slice(-8)

  return (
    <div className="session-agent-col">
      <div className="session-agent-header">
        <span className="session-agent-dot" style={{ background: dot }} />
        <span className="session-agent-title">{title}</span>
        <span className="session-agent-status">{agent.status}</span>
      </div>
      {agent.currentTool && (
        <div className="session-agent-tool">Tool: {agent.currentTool}</div>
      )}
      <div className="session-timeline">
        {recent.map((ev, i) => (
          <span
            key={i}
            className={`session-event-pill session-event-${ev.type}`}
            title={`${ev.type}${ev.toolName ? ': ' + ev.toolName : ''}`}
          >
            {ev.toolName ?? ev.type}
          </span>
        ))}
      </div>
    </div>
  )
}

export function SessionDashboard({ sessionId, workspaceId }: Readonly<SessionDashboardProps>) {
  const [session, setSession] = useState<SessionState | undefined>(
    () => sessionStore.getSession(sessionId)
  )

  const refresh = useCallback(() => {
    setSession(sessionStore.getSession(sessionId))
  }, [sessionId])

  useEffect(() => {
    sessionStore.loadSessions(workspaceId)
    return sessionStore.subscribe(refresh)
  }, [workspaceId, refresh])

  if (!session) {
    return (
      <div className="session-dashboard session-dashboard-empty">
        No active session
      </div>
    )
  }

  return (
    <div className="session-dashboard">
      <div className="session-dashboard-meta">
        <span className="session-label">{session.label}</span>
        {session.totalCost > 0 && (
          <span className="session-cost">${session.totalCost.toFixed(4)}</span>
        )}
        {session.totalTokens > 0 && (
          <span className="session-tokens">{session.totalTokens.toLocaleString()} tokens</span>
        )}
      </div>
      <div className="session-dashboard-columns">
        <AgentColumn agent={session.mainAgent} title="Main Agent" />
        {session.subAgents.length > 0 && (
          <div className="session-agent-col session-sub-agents">
            <div className="session-agent-header">
              <span className="session-agent-title">Sub Agents</span>
            </div>
            {session.subAgents.map(sub => (
              <AgentColumn key={sub.agentId} agent={sub} title={sub.agentId} />
            ))}
          </div>
        )}
      </div>
      <button
        className="session-generate-hooks-btn"
        onClick={() => sessionStore.generateHooks()}
        title="Install PreToolUse/PostToolUse hook scripts in ~/.claude/hooks/"
      >
        Install Hooks
      </button>
    </div>
  )
}
