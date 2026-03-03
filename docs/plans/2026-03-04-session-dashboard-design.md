# Session Dashboard Design
Date: 2026-03-04

## Overview

Add a progress dashboard to raven-term that shows Claude Code session state
(main agent + subagents), allows conversation renaming, and surfaces session
history in the sidebar. Data sourced from SDK IPC events, Claude Code hooks
(HTTP POST), and PTY stdout parsing.

## Architecture

### Data Sources (Approach C)

| Source | Scenario | Mechanism |
|--------|----------|-----------|
| SDK IPC events | SDK-mode Claude sessions | Already flowing, re-aggregate |
| Claude Code hooks | PTY-mode `claude` CLI | `~/.claude/hooks/` → POST → local HTTP server |
| PTY stdout parse | Supplemental tool detection | Regex on terminal output |

### New Files

```
electron/
  hook-server.ts        Local HTTP server (localhost:27182) receiving hook POSTs
  session-tracker.ts    Aggregates SDK + hook events into unified AgentEvent format

src/
  components/
    SessionDashboard.tsx  Main dashboard UI (main + subagents columns)
    AgentStatusColumn.tsx Single agent status column
    SessionSidebar.tsx    Sidebar: session history + rename
  stores/
    session-store.ts      Dashboard state management
```

### Data Models

```typescript
interface AgentEvent {
  agentId: string          // 'main' | 'sub-{id}'
  type: 'tool_start' | 'tool_end' | 'thinking' | 'result' | 'error'
  toolName?: string
  input?: Record<string, unknown>
  timestamp: number
  source: 'sdk' | 'hook' | 'pty'
}

interface AgentStatus {
  agentId: string
  currentTool?: string
  status: 'idle' | 'thinking' | 'running' | 'done' | 'error'
  recentEvents: AgentEvent[]
}

interface SessionState {
  sessionId: string
  label: string            // user-editable conversation title
  mainAgent: AgentStatus
  subAgents: AgentStatus[]
  startedAt: number
  totalCost: number
  totalTokens: number
}
```

### IPC Channels (new)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `session:event` | main → renderer | Forward AgentEvent to dashboard |
| `session:list` | renderer → main | Request session list |
| `session:rename` | renderer → main | Rename a session label |
| `session:hook` | hook-server → main | Internal forwarding from HTTP |

### Hook Server

- Runs on `localhost:27182` as a lightweight HTTP server inside main process
- Accepts `POST /hook` with JSON body: `{ event, toolName, input, sessionId }`
- Hook files to add to `~/.claude/hooks/`:
  - `PreToolUse`: POST to hook server with tool name + input
  - `PostToolUse`: POST with result/error

### Dashboard UI Layout

```
┌──────────────────────────────────────────────────────┐
│  Session Dashboard                                   │
├──────────────────────┬───────────────────────────────┤
│  Main Agent          │  Sub Agents                   │
│  ──────────────────  │  ────────────────────────────  │
│  [●] Thinking...     │  [Sub-1] ReadFile: src/App.ts │
│  Tool: Bash          │  [Sub-2] Grep: pattern        │
│  Cost: $0.023        │  [Sub-3] idle                 │
│  Turns: 4            │                               │
├──────────────────────┴───────────────────────────────┤
│  Timeline: Read → Bash → Write → ...                 │
└──────────────────────────────────────────────────────┘
```

### Session Sidebar Layout

```
Sessions
─────────────────
▶ [✎] "Fix auth bug"       ← current, inline-editable
  [✎] "Refactor store"     ← history
  [✎] "Add dashboard"
─────────────────
```

- Session label stored in `sessions.json` (APPDATA)
- Inline edit on click: input field replaces label, blur/Enter to save
- Sessions scoped per workspace

## Integration Points

- `ClaudeAgentManager` already emits `ClaudeMessage` / `ClaudeToolCall` via IPC
- `session-tracker.ts` subscribes to these and maps them to `AgentEvent`
- Dashboard subscribes to `session:event` channel
- Hook server provides the same `AgentEvent` format for PTY-mode sessions

## Out of Scope

- Multi-machine session sync
- Session search/filter
- Subagent spawning control (view only)
