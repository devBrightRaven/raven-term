import { BrowserWindow } from 'electron'
import { createRequire } from 'module'
import * as fsSync from 'fs'
import * as fsPromises from 'fs/promises'
import * as pathModule from 'path'
import type { ClaudeMessage, ClaudeToolCall, ClaudeSessionState } from '../src/types/claude-agent'
import type { Query, PermissionMode, CanUseTool } from '@anthropic-ai/claude-agent-sdk'

export interface AgentObserver {
  onToolUse: (sessionId: string, tool: ClaudeToolCall) => void
  onToolResult: (sessionId: string, result: { id: string; status: string; toolName?: string }) => void
  onStream: (sessionId: string, data: { thinking?: string }) => void
  onResult: (sessionId: string, meta: { totalCost?: number; totalTokens?: number }) => void
}

// Lazy import the SDK (it's an ES module)
let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null

async function getQuery() {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    queryFn = sdk.query
  }
  return queryFn
}

// Map file extension to media type for image content blocks
function getMediaType(filePath: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const ext = pathModule.extname(filePath).toLowerCase()
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

async function imageToContentBlock(filePath: string): Promise<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | null> {
  try {
    const data = await fsPromises.readFile(filePath)
    // Skip images > 20MB base64 to avoid API rejection
    if (data.length > 15 * 1024 * 1024) return null
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: getMediaType(filePath),
        data: data.toString('base64'),
      },
    }
  } catch {
    return null
  }
}

// Resolve the Claude Code CLI path at module level
// In packaged Electron apps, asarUnpack puts files under app.asar.unpacked
// but require.resolve returns the app.asar path — we need to fix that.
function resolveClaudeCodePath(): string {
  let resolved = ''
  try {
    const req = createRequire(import.meta.url ?? __filename)
    resolved = req.resolve('@anthropic-ai/claude-code/cli.js')
  } catch {
    // Fallback: try require.resolve directly (works in CommonJS context)
    try {
      resolved = require.resolve('@anthropic-ai/claude-code/cli.js')
    } catch {
      return ''
    }
  }
  // In packaged apps, the file is in app.asar.unpacked but resolve returns app.asar
  // child_process.spawn cannot access files inside app.asar, so point to the unpacked copy
  if (resolved.includes('app.asar') && !resolved.includes('app.asar.unpacked')) {
    resolved = resolved.replace('app.asar', 'app.asar.unpacked')
  }
  return resolved
}

export interface SessionSummary {
  sdkSessionId: string
  timestamp: number
  preview: string
  messageCount: number
}

interface SessionMetadata {
  model?: string
  sdkSessionId?: string
  cwd?: string
  totalCost: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  numTurns: number
  contextWindow: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
}

interface QueuedMessage {
  prompt: string
  images?: string[]
}

interface SessionInstance {
  abortController: AbortController
  state: ClaudeSessionState
  sdkSessionId?: string
  cwd: string
  metadata: SessionMetadata
  queryInstance?: Query
  pendingPermissions: Map<string, PendingRequest>
  pendingAskUser: Map<string, PendingRequest>
  permissionMode: PermissionMode
  messageQueue: QueuedMessage[]
  isResting?: boolean
}

// Persists SDK session IDs across stop/restart so we can resume conversations
const sdkSessionIds = new Map<string, string>()

export class ClaudeAgentManager {
  private sessions: Map<string, SessionInstance> = new Map()
  private window: BrowserWindow
  private observer: AgentObserver | null = null

  constructor(window: BrowserWindow) {
    this.window = window
  }

  setObserver(observer: AgentObserver): void {
    this.observer = observer
  }

  private send(channel: string, ...args: unknown[]) {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, ...args)
    }
  }

  private static readonly MSG_BUFFER_CAP = 300

  private addMessage(sessionId: string, msg: ClaudeMessage) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(msg)
      if (session.state.messages.length > ClaudeAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-ClaudeAgentManager.MSG_BUFFER_CAP)
      }
    }
    this.send('claude:message', sessionId, msg)
  }

  private addToolCall(sessionId: string, tool: ClaudeToolCall) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(tool)
      if (session.state.messages.length > ClaudeAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-ClaudeAgentManager.MSG_BUFFER_CAP)
      }
    }
    this.send('claude:tool-use', sessionId, tool)
    this.observer?.onToolUse(sessionId, tool)
  }

  private updateToolCall(sessionId: string, toolId: string, updates: Partial<ClaudeToolCall>) {
    const session = this.sessions.get(sessionId)
    if (session) {
      const idx = session.state.messages.findIndex(
        m => 'toolName' in m && m.id === toolId
      )
      if (idx !== -1) {
        Object.assign(session.state.messages[idx], updates)
      }
    }
    this.send('claude:tool-result', sessionId, { id: toolId, ...updates })
    this.observer?.onToolResult(sessionId, { id: toolId, status: updates.status ?? 'completed', toolName: undefined })
  }

  async startSession(sessionId: string, options: { cwd: string; prompt?: string; sdkSessionId?: string }): Promise<boolean> {
    // Prevent duplicate session creation
    if (this.sessions.has(sessionId)) {
      return true
    }

    try {
      const abortController = new AbortController()
      const state: ClaudeSessionState = {
        sessionId,
        messages: [],
        isStreaming: false,
      }

      // If an explicit SDK session ID was given (e.g. from /resume), store it
      if (options.sdkSessionId) {
        sdkSessionIds.set(sessionId, options.sdkSessionId)
      }

      // Restore SDK session ID if we had one before (for resume after restart)
      const previousSdkSessionId = sdkSessionIds.get(sessionId)

      this.sessions.set(sessionId, {
        abortController,
        state,
        sdkSessionId: previousSdkSessionId,
        cwd: options.cwd,
        metadata: {
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          numTurns: 0,
          contextWindow: 0,
        },
        pendingPermissions: new Map(),
        pendingAskUser: new Map(),
        permissionMode: 'default',
        messageQueue: [],
      })

      // If no initial prompt, just set up session and wait
      if (!options.prompt) {
        const resumeNote = previousSdkSessionId ? ' (resumed)' : ''
        this.send('claude:message', sessionId, {
          id: `sys-init-${sessionId}`,
          sessionId,
          role: 'system',
          content: `Claude Code session ready${resumeNote}. Type a message to start.`,
          timestamp: Date.now(),
        } satisfies ClaudeMessage)
        // Load history from previous session if resuming
        if (previousSdkSessionId) {
          this.loadSessionHistory(sessionId, previousSdkSessionId, options.cwd).catch(e => {
            console.warn('Failed to load session history on auto-resume:', e)
          })
        }
        return true
      }

      await this.runQuery(sessionId, options.prompt)
      return true
    } catch (error) {
      console.error('Failed to start Claude session:', error)
      this.send('claude:error', sessionId, String(error))
      return false
    }
  }

  async sendMessage(sessionId: string, prompt: string, images?: string[]): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.send('claude:error', sessionId, 'Session not found')
      return false
    }

    // Auto-wake resting sessions
    if (session.isResting) {
      session.isResting = false
    }

    if (session.state.isStreaming) {
      // Abort current query and immediately send the new message
      // The SDK session ID is preserved, so the next runQuery will resume with conversation context
      session.abortController.abort()
      session.pendingPermissions.clear()
      session.pendingAskUser.clear()
      session.messageQueue.length = 0
      session.messageQueue.push({ prompt, images })
      return true
    }

    // Note: user message is added by the frontend — don't duplicate here
    await this.runQuery(sessionId, prompt, images)
    return true
  }

  private async runQuery(sessionId: string, prompt: string, images?: string[]) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.state.isStreaming = true
    session.abortController = new AbortController()

    // Collect stderr output for better error diagnostics
    let stderrOutput = ''

    try {
      const query = await getQuery()

      // Build options — resume if we have a previous SDK session ID
      const resumeId = session.sdkSessionId
      const claudeCodePath = resolveClaudeCodePath()
      console.log(`[Claude] runQuery: cwd=${session.cwd}, resumeId=${resumeId || 'none'}, claudeCodePath=${claudeCodePath || 'none'}`)
      const canUseTool: CanUseTool = async (toolName, input, opts) => {
        // Check if this is an AskUserQuestion tool
        if (toolName === 'AskUserQuestion') {
          return new Promise((resolve) => {
            session.pendingAskUser.set(opts.toolUseID, { resolve })
            this.send('claude:ask-user', sessionId, {
              toolUseId: opts.toolUseID,
              questions: (input as Record<string, unknown>).questions,
            })
          })
        }

        // For all other tools, send permission request to frontend
        return new Promise((resolve) => {
          session.pendingPermissions.set(opts.toolUseID, { resolve })
          this.send('claude:permission-request', sessionId, {
            toolUseId: opts.toolUseID,
            toolName,
            input,
            suggestions: opts.suggestions,
          })
        })
      }

      const currentMode = session.permissionMode
      const queryOptions: Record<string, unknown> = {
        abortController: session.abortController,
        cwd: session.cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: { type: 'preset', preset: 'claude_code' },
        permissionMode: currentMode,
        ...(currentMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        maxThinkingTokens: 31999,
        canUseTool,
        ...(claudeCodePath ? { pathToClaudeCodeExecutable: claudeCodePath } : {}),
        stderr: (data: string) => {
          console.error('[Claude Code stderr]', data)
          stderrOutput += data
        },
      }

      if (resumeId) {
        queryOptions.resume = resumeId
        queryOptions.continue = true
      }

      // Build prompt: if images are attached, construct a multi-content SDKUserMessage
      let promptArg: unknown = prompt
      if (images && images.length > 0) {
        const imageBlocks = (await Promise.all(
          images.filter(p => fsSync.existsSync(p)).map(p => imageToContentBlock(p))
        )).filter(Boolean) as Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>
        if (imageBlocks.length > 0) {
          const contentBlocks = [
            ...imageBlocks,
            { type: 'text' as const, text: prompt },
          ]
          const userMessage = {
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: contentBlocks,
            },
          }
          async function* singleMessage() {
            yield userMessage
          }
          promptArg = singleMessage()
        }
      }

      const generator = query({
        prompt: promptArg as Parameters<typeof query>[0]['prompt'],
        options: queryOptions as Parameters<typeof query>[0]['options'],
      })

      // Store the query instance so we can call runtime methods
      session.queryInstance = generator

      for await (const message of generator) {
        // Check abort
        if (session.abortController.signal.aborted) break

        if (message.type === 'system' && message.subtype === 'init') {
          // Capture and persist the SDK session ID
          const initMsg = message as { session_id: string; model?: string; cwd?: string; permissionMode?: string }
          session.sdkSessionId = initMsg.session_id
          sdkSessionIds.set(sessionId, initMsg.session_id)

          // Extract metadata from init message
          session.metadata.model = initMsg.model
          session.metadata.sdkSessionId = initMsg.session_id
          session.metadata.cwd = initMsg.cwd || session.cwd
          this.send('claude:status', sessionId, {
            ...session.metadata,
            permissionMode: initMsg.permissionMode || 'default',
          })

        }

        if (message.type === 'assistant') {
          const content = message.message?.content
          if (Array.isArray(content)) {
            // Collect thinking text from thinking blocks
            const thinkingParts: string[] = []
            for (const block of content) {
              if ('type' in block && block.type === 'thinking' && 'thinking' in block) {
                thinkingParts.push((block as { thinking: string }).thinking)
              }
            }
            const thinkingText = thinkingParts.join('\n') || undefined

            for (const block of content) {
              if ('text' in block && block.text) {
                this.addMessage(sessionId, {
                  id: message.uuid || `asst-${Date.now()}`,
                  sessionId,
                  role: 'assistant',
                  content: block.text,
                  thinking: thinkingText,
                  timestamp: Date.now(),
                })
              }
              if ('type' in block && block.type === 'tool_use') {
                const toolBlock = block as { id: string; name: string; input: Record<string, unknown> }
                this.addToolCall(sessionId, {
                  id: toolBlock.id,
                  sessionId,
                  toolName: toolBlock.name,
                  input: toolBlock.input || {},
                  status: 'running',
                  timestamp: Date.now(),
                })
                // Detect plan mode transitions and notify UI
                if (toolBlock.name === 'EnterPlanMode') {
                  session.permissionMode = 'plan'
                  this.send('claude:modeChange', sessionId, 'plan')
                } else if (toolBlock.name === 'ExitPlanMode') {
                  session.permissionMode = 'default'
                  this.send('claude:modeChange', sessionId, 'default')
                }
              }
              if ('type' in block && block.type === 'tool_result') {
                const resultBlock = block as { tool_use_id: string; content?: string; is_error?: boolean }
                const resultContent = typeof resultBlock.content === 'string'
                  ? resultBlock.content
                  : JSON.stringify(resultBlock.content)
                this.updateToolCall(sessionId, resultBlock.tool_use_id, {
                  status: resultBlock.is_error ? 'error' : 'completed',
                  result: resultContent,
                })
              }
            }
          }
        }

        if (message.type === 'user') {
          // User messages in SDK are tool results
          const content = message.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if ('type' in block && block.type === 'tool_result') {
                const resultBlock = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
                const resultStr = typeof resultBlock.content === 'string'
                  ? resultBlock.content
                  : JSON.stringify(resultBlock.content)
                this.updateToolCall(sessionId, resultBlock.tool_use_id, {
                  status: resultBlock.is_error ? 'error' : 'completed',
                  result: resultStr?.slice(0, 2000), // Truncate long results
                })
              }
            }
          }
        }

        if (message.type === 'stream_event') {
          // Partial streaming content
          const event = message.event as { type?: string; delta?: { text?: string; thinking?: string }; content_block?: { type?: string; id?: string; name?: string; input?: string } }
          if (event.type === 'content_block_delta') {
            if (event.delta?.text) {
              this.send('claude:stream', sessionId, {
                text: event.delta.text,
                parentToolUseId: message.parent_tool_use_id,
              })
            }
            if (event.delta?.thinking) {
              this.send('claude:stream', sessionId, {
                thinking: event.delta.thinking,
                parentToolUseId: message.parent_tool_use_id,
              })
              this.observer?.onStream(sessionId, { thinking: event.delta.thinking })
            }
          }
        }

        if (message.type === 'compact') {
          const compactMsg = message as { displayText?: string }
          // Strip ANSI escape codes from SDK display text
          const rawText = compactMsg.displayText || 'Context compacted'
          const cleanText = rawText.replace(/\x1b\[[0-9;]*m/g, '')
          this.addMessage(sessionId, {
            id: `sys-compact-${Date.now()}`,
            sessionId,
            role: 'system',
            content: cleanText,
            timestamp: Date.now(),
          })
        }

        if (message.type === 'result') {
          const resultMsg = message as {
            subtype: string
            total_cost_usd?: number
            usage?: { input_tokens?: number; output_tokens?: number }
            duration_ms?: number
            num_turns?: number
            result?: string
            errors?: string[]
            modelUsage?: Record<string, { contextWindow?: number; inputTokens?: number; outputTokens?: number }>
          }

          session.state.totalCost = resultMsg.total_cost_usd
          session.state.totalTokens =
            (resultMsg.usage?.input_tokens || 0) + (resultMsg.usage?.output_tokens || 0)

          // Accumulate metadata
          session.metadata.totalCost = resultMsg.total_cost_usd ?? session.metadata.totalCost
          session.metadata.inputTokens += resultMsg.usage?.input_tokens || 0
          session.metadata.outputTokens += resultMsg.usage?.output_tokens || 0
          session.metadata.durationMs += resultMsg.duration_ms || 0
          session.metadata.numTurns += resultMsg.num_turns || 0

          // Extract contextWindow from modelUsage
          if (resultMsg.modelUsage) {
            const firstModel = Object.values(resultMsg.modelUsage)[0]
            if (firstModel?.contextWindow) {
              session.metadata.contextWindow = firstModel.contextWindow
            }
          }

          this.send('claude:status', sessionId, { ...session.metadata })

          this.send('claude:result', sessionId, {
            subtype: resultMsg.subtype,
            totalCost: resultMsg.total_cost_usd,
            totalTokens: session.state.totalTokens,
            result: resultMsg.result,
            errors: resultMsg.errors,
          })
          this.observer?.onResult(sessionId, {
            totalCost: resultMsg.total_cost_usd,
            totalTokens: session.state.totalTokens,
          })
        }
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg !== 'aborted' && errMsg !== 'The operation was aborted') {
        // If we were trying to resume and the process crashed, retry without resume
        if (resumeId && errMsg.includes('exited with code')) {
          console.warn('Claude query failed with resume, retrying without resume:', errMsg)
          if (stderrOutput) console.warn('stderr:', stderrOutput)
          session.sdkSessionId = undefined
          sdkSessionIds.delete(sessionId)
          session.state.isStreaming = false
          this.addMessage(sessionId, {
            id: `sys-retry-${Date.now()}`,
            sessionId,
            role: 'system',
            content: 'Previous session could not be resumed. Starting fresh...',
            timestamp: Date.now(),
          })
          // Retry without resume
          return this.runQuery(sessionId, prompt, images)
        }
        console.error('Claude query error:', error)
        if (stderrOutput) console.error('stderr output:', stderrOutput)
        if (error instanceof Error && error.stack) {
          console.error('Stack:', error.stack)
        }
        // Include stderr hint in error message if available
        const displayMsg = stderrOutput
          ? `${errMsg}\n${stderrOutput.slice(0, 500)}`
          : errMsg
        this.send('claude:error', sessionId, displayMsg)
      }
    } finally {
      if (session) {
        session.state.isStreaming = false
        // Process queued messages
        const next = session.messageQueue.shift()
        if (next) {
          this.runQuery(sessionId, next.prompt, next.images)
        }
      }
    }
  }

  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.abortController.abort()
      session.messageQueue.length = 0
      session.state.isStreaming = false
      // Keep the session alive so the user can continue the conversation
      return true
    }
    return false
  }

  /** Kill all sessions and their subprocesses completely */
  killAll() {
    for (const [id, session] of this.sessions) {
      session.abortController.abort()
      session.messageQueue.length = 0
      session.state.isStreaming = false
      try { session.queryInstance?.close() } catch { /* ignore */ }
    }
    this.sessions.clear()
    sdkSessionIds.clear()
  }

  getSessionState(sessionId: string): ClaudeSessionState | null {
    const session = this.sessions.get(sessionId)
    return session?.state || null
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    // Always track the mode on the session so the next runQuery picks it up
    session.permissionMode = mode
    if (!session.queryInstance) return true
    try {
      await session.queryInstance.setPermissionMode(mode)
      return true
    } catch (e) {
      console.warn('setPermissionMode failed:', e)
      return false
    }
  }

  async setModel(sessionId: string, model: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session?.queryInstance) return false
    try {
      await session.queryInstance.setModel(model)
      return true
    } catch (e) {
      console.warn('setModel failed:', e)
      return false
    }
  }

  async setMaxThinkingTokens(sessionId: string, tokens: number | null): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session?.queryInstance) return false
    try {
      await session.queryInstance.setMaxThinkingTokens(tokens)
      return true
    } catch (e) {
      console.warn('setMaxThinkingTokens failed:', e)
      return false
    }
  }

  async getSupportedModels(sessionId: string): Promise<Array<{ value: string; displayName: string; description: string }>> {
    const session = this.sessions.get(sessionId)
    if (!session?.queryInstance) return []
    try {
      return await session.queryInstance.supportedModels()
    } catch (e) {
      console.warn('getSupportedModels failed:', e)
      return []
    }
  }

  resolvePermission(sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; message?: string }): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const pending = session.pendingPermissions.get(toolUseId)
    if (!pending) return false
    pending.resolve(result)
    session.pendingPermissions.delete(toolUseId)
    return true
  }

  resolveAskUser(sessionId: string, toolUseId: string, answers: Record<string, string>): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const pending = session.pendingAskUser.get(toolUseId)
    if (!pending) return false
    // AskUserQuestion expects a PermissionResult with behavior 'allow' and updatedInput containing answers
    pending.resolve({
      behavior: 'allow',
      updatedInput: { answers },
    })
    session.pendingAskUser.delete(toolUseId)
    return true
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const os = await import('os')
    const readline = await import('readline')

    // Encode CWD to match SDK's project directory naming
    // SDK encodes: colons become dashes, slashes become dashes
    const encoded = cwd.replace(/:/g, '-').replace(/[\\/]/g, '-')
    const projectDir = pathModule.join(os.homedir(), '.claude', 'projects', encoded)

    const results: SessionSummary[] = []

    // Try the exact encoded path and common casing variants
    const candidates = [projectDir]
    // On Windows, drive letter casing may differ
    if (process.platform === 'win32' && encoded.length > 0) {
      const lower = encoded[0].toLowerCase() + encoded.slice(1)
      const upper = encoded[0].toUpperCase() + encoded.slice(1)
      if (lower !== encoded) candidates.push(pathModule.join(os.homedir(), '.claude', 'projects', lower))
      if (upper !== encoded) candidates.push(pathModule.join(os.homedir(), '.claude', 'projects', upper))
    }

    for (const dir of candidates) {
      let files: string[]
      try {
        files = (await fsPromises.readdir(dir)).filter(f => f.endsWith('.jsonl'))
      } catch {
        continue
      }

      for (const file of files) {
        const filePath = pathModule.join(dir, file)
        const sdkSessionId = pathModule.basename(file, '.jsonl')
        try {
          const stat = await fsPromises.stat(filePath)
          let preview = ''
          let messageCount = 0

          // Read first 20 lines to find a user message for preview
          const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' })
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
          let lineCount = 0
          for await (const line of rl) {
            lineCount++
            if (lineCount > 20) break
            try {
              const obj = JSON.parse(line)
              messageCount++
              if (!preview && obj.type === 'user') {
                const content = obj.message?.content
                if (typeof content === 'string') {
                  preview = content.slice(0, 120)
                } else if (Array.isArray(content)) {
                  const textBlock = content.find((b: { type?: string }) => b.type === 'text')
                  if (textBlock?.text) preview = String(textBlock.text).slice(0, 120)
                }
              }
            } catch {
              // skip malformed lines
            }
          }
          stream.destroy()

          results.push({
            sdkSessionId,
            timestamp: stat.mtimeMs,
            preview: preview || '(no preview)',
            messageCount,
          })
        } catch {
          // skip files that can't be read
        }
      }
    }

    // Deduplicate by sdkSessionId and sort by time descending
    const seen = new Set<string>()
    const deduped = results.filter(r => {
      if (seen.has(r.sdkSessionId)) return false
      seen.add(r.sdkSessionId)
      return true
    })
    deduped.sort((a, b) => b.timestamp - a.timestamp)
    return deduped
  }

  private async loadSessionHistory(sessionId: string, sdkSessionId: string, cwd: string): Promise<void> {
    const os = await import('os')
    const readline = await import('readline')

    const encoded = cwd.replace(/:/g, '-').replace(/[\\/]/g, '-')
    const projectDir = pathModule.join(os.homedir(), '.claude', 'projects', encoded)
    const filePath = pathModule.join(projectDir, `${sdkSessionId}.jsonl`)

    try {
      await fsPromises.stat(filePath)
    } catch {
      return // file not found
    }

    const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    // Collect all JSONL entries, dedup by uuid (keep last), filter by sessionId
    const entriesByUuid = new Map<string, unknown>()
    const orderedKeys: string[] = []
    let seqCounter = 0

    for await (const line of rl) {
      try {
        const obj = JSON.parse(line) as {
          type: string; uuid?: string; sessionId?: string;
          message?: { role?: string; content?: unknown };
          timestamp?: string
        }
        // Skip entries from other sessions
        if (obj.sessionId && obj.sessionId !== sdkSessionId) continue
        // Skip non-message types
        if (obj.type !== 'user' && obj.type !== 'assistant') continue

        const key = obj.uuid || `seq-${seqCounter++}`
        if (!entriesByUuid.has(key)) {
          orderedKeys.push(key)
        }
        entriesByUuid.set(key, obj) // last write wins (most complete)
      } catch {
        // skip malformed lines
      }
    }
    stream.destroy()

    // Build message items from deduplicated entries
    type HistoryItem = (ClaudeMessage | ClaudeToolCall)
    const items: HistoryItem[] = []
    // Track tool_use IDs to their index in items for result matching
    const toolIndexMap = new Map<string, number>()

    for (const key of orderedKeys) {
      const obj = entriesByUuid.get(key) as {
        type: string; uuid?: string; message?: { role?: string; content?: unknown }; timestamp?: string
      }
      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()

      if (obj.type === 'user' && obj.message?.role === 'user') {
        const content = obj.message.content
        let text = ''
        if (typeof content === 'string') {
          text = content
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b: { type?: string }) => b.type === 'text')
          if (textBlock?.text) text = String(textBlock.text)
          // Match tool results to their tool calls
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const idx = toolIndexMap.get(block.tool_use_id)
              if (idx !== undefined) {
                const tool = items[idx] as ClaudeToolCall
                const resultStr = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content)
                tool.status = block.is_error ? 'error' : 'completed'
                tool.result = resultStr?.slice(0, 2000)
              }
            }
          }
        }
        // Filter out SDK noise and system caveats
        const isNoise = !text
          || text === '[Request interrupted by user for tool use]'
          || text.startsWith('<local-command-caveat>')
          || text === 'No response requested.'
          || text.startsWith('Unknown skill:')
        if (!isNoise) {
          items.push({
            id: obj.uuid || `hist-user-${items.length}`,
            sessionId,
            role: 'user' as const,
            content: text,
            timestamp: ts,
          })
        }
      }

      if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
        const content = obj.message.content
        if (Array.isArray(content)) {
          // Collect thinking text
          const thinkingBlocks = content.filter((b: { type?: string }) => b.type === 'thinking')
          const thinkingText = thinkingBlocks.map((b: { thinking?: string }) => b.thinking || '').join('\n').trim()

          // Collect assistant text
          const textBlocks = content.filter((b: { type?: string }) => b.type === 'text')
          const assistantText = textBlocks.map((b: { text?: string }) => b.text || '').join('\n').trim()

          // Filter out assistant noise
          const isAssistantNoise = assistantText === 'No response requested.'
          if ((assistantText || thinkingText) && !isAssistantNoise) {
            const item = {
              id: `${obj.uuid || 'hist'}-text-${items.length}`,
              sessionId,
              role: 'assistant' as const,
              content: assistantText || '',
              ...(thinkingText ? { thinking: thinkingText } : {}),
              timestamp: ts,
            }
            items.push(item)
          }

          // Tool uses
          for (const block of content) {
            if (block.type === 'tool_use') {
              const toolItem: ClaudeToolCall = {
                id: block.id,
                sessionId,
                toolName: block.name,
                input: block.input || {},
                status: 'completed',
                timestamp: ts,
              }
              toolIndexMap.set(block.id, items.length)
              items.push(toolItem)
            }
          }
        }
      }
    }

    // Send all history as a single batch
    this.send('claude:history', sessionId, items)
  }

  async resumeSession(sessionId: string, sdkSessionIdToResume: string, cwd: string): Promise<boolean> {
    // Stop current session if running
    const session = this.sessions.get(sessionId)
    if (session) {
      session.abortController.abort()
      this.sessions.delete(sessionId)
    }

    // Store the SDK session ID so startSession will use it for resume
    sdkSessionIds.set(sessionId, sdkSessionIdToResume)
    const result = await this.startSession(sessionId, { cwd })

    // Load and replay historical messages from the JSONL file
    if (result) {
      await this.loadSessionHistory(sessionId, sdkSessionIdToResume, cwd)
    }

    return result
  }

  /** Put a session to rest — kill subprocess but preserve sdkSessionId for resume */
  restSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.messageQueue.length = 0
    session.state.isStreaming = false
    try { session.queryInstance?.close() } catch { /* ignore */ }
    session.queryInstance = undefined
    session.isResting = true
    this.send('claude:message', sessionId, {
      id: `sys-rest-${Date.now()}`,
      sessionId,
      role: 'system',
      content: 'Session is resting. Send a message to wake it up.',
      timestamp: Date.now(),
    } satisfies ClaudeMessage)
    return true
  }

  /** Wake a resting session — will auto-resume on next sendMessage */
  wakeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.isResting = false
    return true
  }

  isResting(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isResting ?? false
  }

  dispose() {
    for (const [id, session] of this.sessions) {
      this.stopSession(id)
      // Forcefully terminate the CLI subprocess
      try {
        session.queryInstance?.close()
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.sessions.clear()
    sdkSessionIds.clear()
  }
}
