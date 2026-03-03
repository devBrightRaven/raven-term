import { app, BrowserWindow, ipcMain } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { ClaudeToolCall } from '../src/types/claude-agent'
import type { AgentEvent, AgentStatus, SessionState, SessionLabel } from '../src/types/session'

const EVENTS_CAP = 50
const SUB_AGENT_TOOLS = new Set(['Task', 'dispatch_agent', 'computer'])

function makeAgentStatus(agentId: string): AgentStatus {
  return { agentId, status: 'idle', recentEvents: [] }
}

function pushEvent(agent: AgentStatus, event: AgentEvent): AgentStatus {
  const events = [...agent.recentEvents, event]
  return {
    ...agent,
    recentEvents: events.length > EVENTS_CAP ? events.slice(-EVENTS_CAP) : events,
  }
}

function applyEvent(agent: AgentStatus, event: AgentEvent): AgentStatus {
  const base = pushEvent(agent, event)
  switch (event.type) {
    case 'tool_start':
      return { ...base, currentTool: event.toolName, status: 'running' }
    case 'tool_end':
      return { ...base, currentTool: undefined, status: 'idle' }
    case 'thinking':
      return { ...base, status: 'thinking' }
    case 'result':
      return { ...base, status: 'done', currentTool: undefined }
    case 'error':
      return { ...base, status: 'error', currentTool: undefined }
    default:
      return base
  }
}

export class SessionTracker {
  private sessions = new Map<string, SessionState>()
  private labels: SessionLabel[] = []
  private window: BrowserWindow

  constructor(window: BrowserWindow) {
    this.window = window
    this.loadLabels()
    this.registerIpcHandlers()
  }

  // Called by ClaudeAgentManager's IPC send — intercept tool-use / tool-result / stream / result
  handleSdkToolUse(sessionId: string, tool: ClaudeToolCall): void {
    const event: AgentEvent = {
      agentId: this.resolveAgentId(tool.toolName),
      type: 'tool_start',
      toolName: tool.toolName,
      input: tool.input,
      timestamp: tool.timestamp,
      source: 'sdk',
    }
    this.applyToSession(sessionId, event)
  }

  handleSdkToolResult(sessionId: string, result: { id: string; status: string; toolName?: string }): void {
    const type = result.status === 'error' ? 'error' : 'tool_end'
    const event: AgentEvent = {
      agentId: 'main',
      type,
      toolName: result.toolName,
      timestamp: Date.now(),
      source: 'sdk',
    }
    this.applyToSession(sessionId, event)
  }

  handleSdkStream(sessionId: string, data: { thinking?: string }): void {
    if (!data.thinking) return
    const event: AgentEvent = {
      agentId: 'main',
      type: 'thinking',
      timestamp: Date.now(),
      source: 'sdk',
    }
    this.applyToSession(sessionId, event)
  }

  handleSdkResult(sessionId: string, meta: { totalCost?: number; totalTokens?: number }): void {
    const event: AgentEvent = {
      agentId: 'main',
      type: 'result',
      timestamp: Date.now(),
      source: 'sdk',
    }
    const session = this.getOrCreate(sessionId, '')
    const updated: SessionState = {
      ...session,
      totalCost: meta.totalCost ?? session.totalCost,
      totalTokens: meta.totalTokens ?? session.totalTokens,
      mainAgent: applyEvent(session.mainAgent, event),
    }
    this.sessions.set(sessionId, updated)
    this.emit(sessionId, event, updated)
  }

  // Called by HookServer for PTY-mode sessions
  handleHookEvent(event: AgentEvent): void {
    // Hook events don't carry a sessionId in AgentEvent — we use the most recent session
    // TODO: when hook payload includes sessionId, wire it through AgentEvent
    const sessionId = this.latestSessionId() ?? 'hook-default'
    this.applyToSession(sessionId, event)
  }

  initSession(sessionId: string, workspaceId: string): void {
    if (this.sessions.has(sessionId)) return
    const label = this.findLabel(sessionId)?.label ?? this.generateLabel()
    this.sessions.set(sessionId, {
      sessionId,
      workspaceId,
      label,
      mainAgent: makeAgentStatus('main'),
      subAgents: [],
      startedAt: Date.now(),
      totalCost: 0,
      totalTokens: 0,
    })
  }

  private resolveAgentId(toolName: string): string {
    return SUB_AGENT_TOOLS.has(toolName) ? `sub-${toolName.toLowerCase()}` : 'main'
  }

  private applyToSession(sessionId: string, event: AgentEvent): void {
    const session = this.getOrCreate(sessionId, '')
    let updated: SessionState

    if (event.agentId === 'main') {
      updated = { ...session, mainAgent: applyEvent(session.mainAgent, event) }
    } else {
      const existing = session.subAgents.find(a => a.agentId === event.agentId)
      const agent = existing ?? makeAgentStatus(event.agentId)
      const updatedAgent = applyEvent(agent, event)
      const subAgents = existing
        ? session.subAgents.map(a => a.agentId === event.agentId ? updatedAgent : a)
        : [...session.subAgents, updatedAgent]
      updated = { ...session, subAgents }
    }

    this.sessions.set(sessionId, updated)
    this.emit(sessionId, event, updated)
  }

  private emit(sessionId: string, event: AgentEvent, state: SessionState): void {
    if (this.window.isDestroyed()) return
    this.window.webContents.send('session:event', sessionId, event)
    this.window.webContents.send('session:update', sessionId, state)
  }

  private getOrCreate(sessionId: string, workspaceId: string): SessionState {
    if (!this.sessions.has(sessionId)) {
      this.initSession(sessionId, workspaceId)
    }
    return this.sessions.get(sessionId)!
  }

  private latestSessionId(): string | undefined {
    let latest: SessionState | undefined
    for (const s of this.sessions.values()) {
      if (!latest || s.startedAt > latest.startedAt) latest = s
    }
    return latest?.sessionId
  }

  private generateLabel(): string {
    const now = new Date()
    return `Session ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }

  private findLabel(sessionId: string): SessionLabel | undefined {
    return this.labels.find(l => l.sessionId === sessionId)
  }

  listSessions(workspaceId: string): SessionState[] {
    return [...this.sessions.values()].filter(s => s.workspaceId === workspaceId)
  }

  async renameSession(sessionId: string, label: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      this.sessions.set(sessionId, { ...session, label })
    }

    const existing = this.labels.find(l => l.sessionId === sessionId)
    if (existing) {
      existing.label = label
      existing.updatedAt = Date.now()
    } else {
      this.labels.push({
        sessionId,
        label,
        workspaceId: session?.workspaceId ?? '',
        updatedAt: Date.now(),
      })
    }

    await this.saveLabels()
  }

  private labelsPath(): string {
    return path.join(app.getPath('userData'), 'sessions.json')
  }

  private async loadLabels(): Promise<void> {
    try {
      const raw = await fs.readFile(this.labelsPath(), 'utf-8')
      this.labels = JSON.parse(raw) as SessionLabel[]
    } catch {
      this.labels = []
    }
  }

  private async saveLabels(): Promise<void> {
    try {
      await fs.writeFile(this.labelsPath(), JSON.stringify(this.labels, null, 2), 'utf-8')
    } catch (e) {
      console.error('[SessionTracker] Failed to save labels:', e)
    }
  }

  private registerIpcHandlers(): void {
    ipcMain.handle('session:list', (_event, workspaceId: string) => {
      return this.listSessions(workspaceId)
    })

    ipcMain.handle('session:rename', async (_event, sessionId: string, label: string) => {
      await this.renameSession(sessionId, label)
      return { ok: true }
    })

    ipcMain.handle('session:generate-hooks', async () => {
      const { HookServer } = await import('./hook-server')
      await HookServer.generateHookScripts()
      return { ok: true }
    })
  }

  dispose(): void {
    ipcMain.removeHandler('session:list')
    ipcMain.removeHandler('session:rename')
    ipcMain.removeHandler('session:generate-hooks')
  }
}
