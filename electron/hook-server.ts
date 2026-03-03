import * as http from 'http'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type { AgentEvent } from '../src/types/session'

const DEFAULT_PORT = 27182
const FALLBACK_PORTS = [27183, 27184, 27185]
const BODY_LIMIT = 1024 * 1024 // 1MB

export type HookEventCallback = (event: AgentEvent) => void

export class HookServer {
  private server: http.Server | null = null
  private port: number = DEFAULT_PORT
  private callback: HookEventCallback | null = null

  onEvent(callback: HookEventCallback): void {
    this.callback = callback
  }

  getPort(): number {
    return this.port
  }

  async start(): Promise<void> {
    const ports = [DEFAULT_PORT, ...FALLBACK_PORTS]
    for (const port of ports) {
      try {
        await this.tryBind(port)
        this.port = port
        console.log(`[HookServer] Listening on http://127.0.0.1:${port}`)
        return
      } catch {
        console.warn(`[HookServer] Port ${port} in use, trying next...`)
      }
    }
    console.error('[HookServer] All ports exhausted, hook server disabled')
  }

  private tryBind(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res))
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        resolve()
      })
    })
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404)
      res.end()
      return
    }

    let body = ''
    let size = 0

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        res.writeHead(413)
        res.end()
        req.destroy()
        return
      }
      body += chunk.toString()
    })

    req.on('end', () => {
      try {
        const data = JSON.parse(body) as Record<string, unknown>
        const event = this.parseHookPayload(data)
        if (event && this.callback) {
          this.callback(event)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch {
        res.writeHead(400)
        res.end()
      }
    })
  }

  private parseHookPayload(data: Record<string, unknown>): AgentEvent | null {
    const event = data['event'] as string | undefined
    const toolName = data['toolName'] as string | undefined
    const agentId = (data['agentId'] as string | undefined) ?? 'main'
    const sessionId = data['sessionId'] as string | undefined

    if (!event || !sessionId) return null

    const type = event === 'PreToolUse' ? 'tool_start'
      : event === 'PostToolUse' ? 'tool_end'
      : null

    if (!type) return null

    return {
      agentId,
      type,
      toolName,
      input: data['input'] as Record<string, unknown> | undefined,
      timestamp: Date.now(),
      source: 'hook',
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  static async generateHookScripts(port: number = DEFAULT_PORT): Promise<void> {
    const hooksDir = path.join(os.homedir(), '.claude', 'hooks')
    await fs.mkdir(hooksDir, { recursive: true })

    const isWindows = process.platform === 'win32'

    if (isWindows) {
      await HookServer.writeWindowsHooks(hooksDir, port)
    } else {
      await HookServer.writeUnixHooks(hooksDir, port)
    }
  }

  private static async writeWindowsHooks(hooksDir: string, port: number): Promise<void> {
    const preToolPath = path.join(hooksDir, 'raven-pre-tool.ps1')
    const postToolPath = path.join(hooksDir, 'raven-post-tool.ps1')

    const preContent = `# raven-term PreToolUse hook — auto-generated
$body = @{
  event = "PreToolUse"
  toolName = $env:CLAUDE_TOOL_NAME
  sessionId = $env:CLAUDE_SESSION_ID
  agentId = "main"
} | ConvertTo-Json
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:${port}/hook" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 1 | Out-Null
} catch {}
`

    const postContent = `# raven-term PostToolUse hook — auto-generated
$body = @{
  event = "PostToolUse"
  toolName = $env:CLAUDE_TOOL_NAME
  sessionId = $env:CLAUDE_SESSION_ID
  agentId = "main"
} | ConvertTo-Json
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:${port}/hook" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 1 | Out-Null
} catch {}
`

    await HookServer.safeWriteHook(preToolPath, preContent)
    await HookServer.safeWriteHook(postToolPath, postContent)
  }

  private static async writeUnixHooks(hooksDir: string, port: number): Promise<void> {
    const preToolPath = path.join(hooksDir, 'raven-pre-tool.sh')
    const postToolPath = path.join(hooksDir, 'raven-post-tool.sh')

    const preContent = `#!/bin/sh
# raven-term PreToolUse hook — auto-generated
curl -s -X POST http://127.0.0.1:${port}/hook \\
  -H "Content-Type: application/json" \\
  --max-time 1 \\
  -d "{\\"event\\":\\"PreToolUse\\",\\"toolName\\":\\"$CLAUDE_TOOL_NAME\\",\\"sessionId\\":\\"$CLAUDE_SESSION_ID\\",\\"agentId\\":\\"main\\"}" >/dev/null 2>&1 || true
`

    const postContent = `#!/bin/sh
# raven-term PostToolUse hook — auto-generated
curl -s -X POST http://127.0.0.1:${port}/hook \\
  -H "Content-Type: application/json" \\
  --max-time 1 \\
  -d "{\\"event\\":\\"PostToolUse\\",\\"toolName\\":\\"$CLAUDE_TOOL_NAME\\",\\"sessionId\\":\\"$CLAUDE_SESSION_ID\\",\\"agentId\\":\\"main\\"}" >/dev/null 2>&1 || true
`

    await HookServer.safeWriteHook(preToolPath, preContent)
    await HookServer.safeWriteHook(postToolPath, postContent)

    // Make executable on Unix
    await fs.chmod(preToolPath, 0o755).catch(() => {})
    await fs.chmod(postToolPath, 0o755).catch(() => {})
  }

  private static async safeWriteHook(filePath: string, content: string): Promise<void> {
    try {
      await fs.access(filePath)
      console.warn(`[HookServer] Hook file already exists, skipping: ${filePath}`)
    } catch {
      await fs.writeFile(filePath, content, 'utf-8')
      console.log(`[HookServer] Wrote hook script: ${filePath}`)
    }
  }
}
