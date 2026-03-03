import { useState, useEffect, useRef } from 'react'
import { sessionStore } from '../stores/session-store'
import type { SessionState } from '../types/session'

interface SessionSidebarProps {
  workspaceId: string
  activeSessionId?: string
  onSelectSession?: (sessionId: string) => void
}

const STATUS_CHAR: Record<string, string> = {
  idle: '○',
  thinking: '◑',
  running: '●',
  done: '✓',
  error: '✗',
}

function SessionRow({
  session,
  isActive,
  onSelect,
}: {
  session: SessionState
  isActive: boolean
  onSelect: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.label)
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDraft(session.label)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commit = async () => {
    setEditing(false)
    if (draft.trim() && draft !== session.label) {
      await sessionStore.renameSession(session.sessionId, draft.trim())
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') { setEditing(false); setDraft(session.label) }
  }

  const agentStatus = session.mainAgent.status
  const statusChar = STATUS_CHAR[agentStatus] ?? '○'

  return (
    <div
      className={`session-row ${isActive ? 'session-row-active' : ''}`}
      onClick={onSelect}
    >
      <span className={`session-row-status session-status-${agentStatus}`}>
        {statusChar}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className="session-row-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          onClick={e => e.stopPropagation()}
          autoFocus
        />
      ) : (
        <>
          <span className="session-row-label">{session.label}</span>
          <button
            className="session-row-rename-btn"
            onClick={startEdit}
            title="Rename"
          >
            ✎
          </button>
        </>
      )}
    </div>
  )
}

export function SessionSidebar({
  workspaceId,
  activeSessionId,
  onSelectSession,
}: Readonly<SessionSidebarProps>) {
  const [sessions, setSessions] = useState<SessionState[]>([])

  useEffect(() => {
    const refresh = () => setSessions(sessionStore.listSessions(workspaceId))
    refresh()
    sessionStore.loadSessions(workspaceId).then(refresh)
    return sessionStore.subscribe(refresh)
  }, [workspaceId])

  if (sessions.length === 0) {
    return (
      <div className="session-sidebar">
        <div className="session-sidebar-header">Sessions</div>
        <div className="session-sidebar-empty">No sessions yet</div>
      </div>
    )
  }

  return (
    <div className="session-sidebar">
      <div className="session-sidebar-header">Sessions</div>
      {sessions.map(s => (
        <SessionRow
          key={s.sessionId}
          session={s}
          isActive={s.sessionId === activeSessionId}
          onSelect={() => onSelectSession?.(s.sessionId)}
        />
      ))}
    </div>
  )
}
