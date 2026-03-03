import { useState, useRef, useEffect, useCallback } from 'react'
import type { Workspace } from '../types'
import { workspaceStore } from '../stores/workspace-store'
import { ActivityIndicator } from './ActivityIndicator'
import { SessionSidebar } from './SessionSidebar'

interface SidebarProps {
  width: number
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  groups: string[]
  activeGroup: string | null
  onSetActiveGroup: (group: string | null) => void
  onSetWorkspaceGroup: (id: string, group: string | undefined) => void
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
  onRenameWorkspace: (id: string, alias: string) => void
  onReorderWorkspaces: (workspaceIds: string[]) => void
  onOpenEnvVars: (workspaceId: string) => void
  onOpenSettings: () => void
  onOpenAbout: () => void
}

export function Sidebar({
  width,
  workspaces,
  activeWorkspaceId,
  groups,
  activeGroup,
  onSetActiveGroup,
  onSetWorkspaceGroup,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameWorkspace,
  onReorderWorkspaces,
  onOpenEnvVars,
  onOpenSettings,
  onOpenAbout
}: Readonly<SidebarProps>) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragPosition, setDragPosition] = useState<'before' | 'after' | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; workspaceId: string } | null>(null)
  const [githubUrl, setGithubUrl] = useState<string | null>(null)
  const [groupEditTarget, setGroupEditTarget] = useState<string | null>(null)
  const [groupEditValue, setGroupEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const groupInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Filter workspaces by active group
  const filteredWorkspaces = activeGroup
    ? workspaces.filter(w => w.group === activeGroup)
    : workspaces

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  useEffect(() => {
    if (groupEditTarget && groupInputRef.current) {
      groupInputRef.current.focus()
      groupInputRef.current.select()
    }
  }, [groupEditTarget])

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    if (contextMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [contextMenu])

  const [agentResting, setAgentResting] = useState(false)

  // Fetch GitHub URL and agent resting state when context menu opens
  useEffect(() => {
    if (!contextMenu) { setGithubUrl(null); setAgentResting(false); return }
    const ws = workspaces.find(w => w.id === contextMenu.workspaceId)
    if (!ws) return
    window.electronAPI.git.getGithubUrl(ws.folderPath).then(url => setGithubUrl(url))
    // Check if agent session is resting
    const agent = workspaceStore.getAgentTerminal(contextMenu.workspaceId)
    if (agent) {
      window.electronAPI.claude.isResting(agent.id).then(r => setAgentResting(r)).catch(() => {})
    }
  }, [contextMenu, workspaces])

  // Context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent, workspaceId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, workspaceId })
  }, [])

  const handleDoubleClick = (workspace: Workspace, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(workspace.id)
    setEditValue(workspace.alias || workspace.name)
  }

  const handleRenameSubmit = (id: string) => {
    onRenameWorkspace(id, editValue)
    setEditingId(null)
  }

  const handleKeyDown = (id: string, e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit(id)
    } else if (e.key === 'Escape') {
      setEditingId(null)
    }
  }

  // Set Group via inline edit
  const handleSetGroup = useCallback((workspaceId: string) => {
    const workspace = workspaces.find(w => w.id === workspaceId)
    setGroupEditTarget(workspaceId)
    setGroupEditValue(workspace?.group || '')
    setContextMenu(null)
  }, [workspaces])

  const handleGroupEditSubmit = useCallback(() => {
    if (groupEditTarget) {
      const trimmed = groupEditValue.trim()
      onSetWorkspaceGroup(groupEditTarget, trimmed || undefined)
      setGroupEditTarget(null)
      setGroupEditValue('')
    }
  }, [groupEditTarget, groupEditValue, onSetWorkspaceGroup])

  const handleGroupEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleGroupEditSubmit()
    } else if (e.key === 'Escape') {
      setGroupEditTarget(null)
      setGroupEditValue('')
    }
  }, [handleGroupEditSubmit])

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, workspaceId: string) => {
    setDraggedId(workspaceId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', workspaceId)
    requestAnimationFrame(() => {
      const target = e.target as HTMLElement
      target.classList.add('dragging')
    })
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    const target = e.target as HTMLElement
    target.classList.remove('dragging')
    setDraggedId(null)
    setDragOverId(null)
    setDragPosition(null)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, workspaceId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    if (draggedId === workspaceId) return

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    const position = e.clientY < midY ? 'before' : 'after'

    setDragOverId(workspaceId)
    setDragPosition(position)
  }, [draggedId])

  const handleDragLeave = useCallback(() => {
    setDragOverId(null)
    setDragPosition(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault()

    if (!draggedId || draggedId === targetId) {
      setDraggedId(null)
      setDragOverId(null)
      setDragPosition(null)
      return
    }

    const currentOrder = workspaces.map(w => w.id)
    const draggedIndex = currentOrder.indexOf(draggedId)
    const targetIndex = currentOrder.indexOf(targetId)

    if (draggedIndex === -1 || targetIndex === -1) return

    // Remove dragged item
    currentOrder.splice(draggedIndex, 1)

    // Calculate new index
    let newIndex = currentOrder.indexOf(targetId)
    if (dragPosition === 'after') {
      newIndex += 1
    }

    // Insert at new position
    currentOrder.splice(newIndex, 0, draggedId)

    onReorderWorkspaces(currentOrder)

    setDraggedId(null)
    setDragOverId(null)
    setDragPosition(null)
  }, [draggedId, dragPosition, workspaces, onReorderWorkspaces])

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">Workspaces</div>
      {/* Group Filter */}
      {groups.length > 0 && (
        <div className="sidebar-group-filter">
          <select
            value={activeGroup || ''}
            onChange={(e) => onSetActiveGroup(e.target.value || null)}
          >
            <option value="">All</option>
            {groups.map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>
      )}
      <div className="workspace-list">
        {filteredWorkspaces.map(workspace => (
          <div
            key={workspace.id}
            className={`workspace-item ${workspace.id === activeWorkspaceId ? 'active' : ''} ${dragOverId === workspace.id ? `drag-over-${dragPosition}` : ''}`}
            onClick={() => onSelectWorkspace(workspace.id)}
            onContextMenu={(e) => handleContextMenu(e, workspace.id)}
            draggable
            onDragStart={(e) => handleDragStart(e, workspace.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, workspace.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, workspace.id)}
          >
            <div className="workspace-item-content">
              <div className="drag-handle" title="Drag to reorder">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="9" cy="6" r="2"/>
                  <circle cx="15" cy="6" r="2"/>
                  <circle cx="9" cy="12" r="2"/>
                  <circle cx="15" cy="12" r="2"/>
                  <circle cx="9" cy="18" r="2"/>
                  <circle cx="15" cy="18" r="2"/>
                </svg>
              </div>
              <div
                className="workspace-item-info"
                onDoubleClick={(e) => handleDoubleClick(workspace, e)}
              >
                {editingId === workspace.id ? (
                  <input
                    ref={inputRef}
                    type="text"
                    className="workspace-rename-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => handleRenameSubmit(workspace.id)}
                    onKeyDown={(e) => handleKeyDown(workspace.id, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="workspace-alias">{workspace.alias || workspace.name}</span>
                    {groupEditTarget === workspace.id ? (
                      <input
                        ref={groupInputRef}
                        type="text"
                        className="workspace-rename-input"
                        value={groupEditValue}
                        onChange={(e) => setGroupEditValue(e.target.value)}
                        onBlur={handleGroupEditSubmit}
                        onKeyDown={handleGroupEditKeyDown}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="Group name (empty to remove)"
                        style={{ fontSize: '11px' }}
                      />
                    ) : (
                      <span className="workspace-folder">
                        {workspace.group ? `[${workspace.group}] ` : ''}{workspace.name}
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="workspace-item-actions">
                <ActivityIndicator
                  workspaceId={workspace.id}
                  size="small"
                />
              </div>
            </div>
          </div>
        )
        )}
      </div>
      {activeWorkspaceId && (
        <SessionSidebar workspaceId={activeWorkspaceId} />
      )}

      <div className="sidebar-footer">
        <button className="add-workspace-btn" onClick={onAddWorkspace}>
          + Add Workspace
        </button>
        <div className="sidebar-footer-buttons">
          <button className="settings-btn" onClick={onOpenSettings}>
            Settings
          </button>
          <button className="settings-btn" onClick={onOpenAbout}>
            About
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="workspace-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              const ws = workspaces.find(w => w.id === contextMenu.workspaceId)
              if (ws) window.electronAPI.shell.openPath(ws.folderPath)
              setContextMenu(null)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <polyline points="10 13 14 9 10 5" />
            </svg>
            Open in Explorer
          </div>
          {githubUrl && (
            <div
              className="context-menu-item"
              onClick={() => {
                window.electronAPI.shell.openExternal(githubUrl)
                setContextMenu(null)
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
              </svg>
              Open on GitHub
            </div>
          )}
          <div
            className="context-menu-item"
            onClick={() => handleSetGroup(contextMenu.workspaceId)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Set Group...
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onOpenEnvVars(contextMenu.workspaceId)
              setContextMenu(null)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Environment Variables
          </div>
          {(() => {
            const agent = workspaceStore.getAgentTerminal(contextMenu.workspaceId)
            if (!agent) return null
            return (
              <div
                className="context-menu-item"
                onClick={async () => {
                  if (agentResting) {
                    await window.electronAPI.claude.wakeSession(agent.id)
                  } else {
                    await window.electronAPI.claude.restSession(agent.id)
                  }
                  setContextMenu(null)
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {agentResting ? (
                    <>
                      <circle cx="12" cy="12" r="10" />
                      <polygon points="10 8 16 12 10 16 10 8" />
                    </>
                  ) : (
                    <>
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </>
                  )}
                </svg>
                {agentResting ? 'Wake Agent' : 'Rest Agent'}
              </div>
            )
          })()}
          <div className="context-menu-divider" />
          <div
            className="context-menu-item danger"
            onClick={() => {
              onRemoveWorkspace(contextMenu.workspaceId)
              setContextMenu(null)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Close Workspace
          </div>
        </div>
      )}
    </aside>
  )
}
