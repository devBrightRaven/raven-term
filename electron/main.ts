import { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerMonitor, clipboard, nativeImage } from 'electron'
import path from 'path'
import * as fs from 'fs/promises'
import { PtyManager } from './pty-manager'
import { ClaudeAgentManager } from './claude-agent-manager'
import { HookServer } from './hook-server'
import { SessionTracker } from './session-tracker'
import { checkForUpdates, UpdateCheckResult } from './update-checker'
import { snippetDb, CreateSnippetInput } from './snippet-db'

// Set AppUserModelId for Windows taskbar pinning (must be before app.whenReady)
if (process.platform === 'win32') {
  app.setAppUserModelId('org.tonyq.better-agent-terminal')
}

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let claudeManager: ClaudeAgentManager | null = null
let hookServer: HookServer | null = null
let sessionTracker: SessionTracker | null = null
let updateCheckResult: UpdateCheckResult | null = null

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const GITHUB_REPO_URL = 'https://github.com/tony1223/better-agent-terminal'

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'GitHub Repository',
          click: () => shell.openExternal(GITHUB_REPO_URL)
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal(`${GITHUB_REPO_URL}/issues`)
        },
        {
          label: 'Releases',
          click: () => shell.openExternal(`${GITHUB_REPO_URL}/releases`)
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About Better Agent Terminal',
              message: 'Better Agent Terminal',
              detail: `Version: ${app.getVersion()}\n\nA terminal aggregator with multi-workspace support and Claude Code integration.\n\nAuthor: TonyQ`
            })
          }
        }
      ]
    }
  ]

  // Add Update menu item if update is available
  if (updateCheckResult?.hasUpdate && updateCheckResult.latestRelease) {
    template.push({
      label: '🎉 Update Available!',
      submenu: [
        {
          label: `Download ${updateCheckResult.latestRelease.tagName}`,
          click: () => {
            const url = updateCheckResult!.latestRelease!.downloadUrl || updateCheckResult!.latestRelease!.htmlUrl
            shell.openExternal(url)
          }
        },
        {
          label: 'View Release Notes',
          click: () => shell.openExternal(updateCheckResult!.latestRelease!.htmlUrl)
        }
      ]
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    frame: true,
    titleBarStyle: 'default',
    title: 'Better Agent Terminal',
    icon: path.join(__dirname, '../assets/icon.ico')
  })

  ptyManager = new PtyManager(mainWindow)
  claudeManager = new ClaudeAgentManager(mainWindow)

  hookServer = new HookServer()
  sessionTracker = new SessionTracker(mainWindow)

  hookServer.onEvent((event) => sessionTracker?.handleHookEvent(event))

  claudeManager.setObserver({
    onToolUse: (sessionId, tool) => sessionTracker?.handleSdkToolUse(sessionId, tool),
    onToolResult: (sessionId, result) => sessionTracker?.handleSdkToolResult(sessionId, result),
    onStream: (sessionId, data) => sessionTracker?.handleSdkStream(sessionId, data),
    onResult: (sessionId, meta) => sessionTracker?.handleSdkResult(sessionId, meta),
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function cleanupAllProcesses() {
  try { claudeManager?.killAll() } catch { /* ignore */ }
  try { claudeManager?.dispose() } catch { /* ignore */ }
  try { ptyManager?.dispose() } catch { /* ignore */ }
  try { hookServer?.stop() } catch { /* ignore */ }
  try { sessionTracker?.dispose() } catch { /* ignore */ }
  claudeManager = null
  ptyManager = null
  hookServer = null
  sessionTracker = null
}

app.whenReady().then(async () => {
  buildMenu()
  createWindow()

  hookServer?.start()

  // Listen for system resume from sleep/hibernate
  powerMonitor.on('resume', () => {
    console.log('System resumed from sleep')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:resume')
    }
  })

  // Check for updates after startup
  setTimeout(async () => {
    try {
      updateCheckResult = await checkForUpdates()
      if (updateCheckResult.hasUpdate) {
        // Rebuild menu to show update option
        buildMenu()
      }
    } catch (error) {
      console.error('Failed to check for updates:', error)
    }
  }, 2000)
})

app.on('before-quit', () => {
  cleanupAllProcesses()
})

app.on('window-all-closed', () => {
  cleanupAllProcesses()
  if (process.platform !== 'darwin') {
    app.quit()
    // Force exit after a short delay in case child processes keep the event loop alive
    setTimeout(() => process.exit(0), 1000)
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// IPC Handlers
ipcMain.handle('pty:create', async (_event, options) => {
  return ptyManager?.create(options)
})

ipcMain.handle('pty:write', async (_event, id: string, data: string) => {
  ptyManager?.write(id, data)
})

ipcMain.handle('pty:resize', async (_event, id: string, cols: number, rows: number) => {
  ptyManager?.resize(id, cols, rows)
})

ipcMain.handle('pty:kill', async (_event, id: string) => {
  return ptyManager?.kill(id)
})

ipcMain.handle('pty:restart', async (_event, id: string, cwd: string, shell?: string) => {
  return ptyManager?.restart(id, cwd, shell)
})

ipcMain.handle('pty:get-cwd', async (_event, id: string) => {
  return ptyManager?.getCwd(id)
})

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('workspace:save', async (_event, data: string) => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'workspaces.json')
  await fs.writeFile(configPath, data, 'utf-8')
  return true
})

ipcMain.handle('workspace:load', async () => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'workspaces.json')
  try {
    const data = await fs.readFile(configPath, 'utf-8')
    return data
  } catch {
    return null
  }
})

// Settings handlers
ipcMain.handle('settings:save', async (_event, data: string) => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'settings.json')
  await fs.writeFile(configPath, data, 'utf-8')
  return true
})

ipcMain.handle('settings:load', async () => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'settings.json')
  try {
    const data = await fs.readFile(configPath, 'utf-8')
    return data
  } catch {
    return null
  }
})

ipcMain.handle('settings:get-shell-path', async (_event, shellType: string) => {
  const fs = await import('fs')

  // macOS and Linux support
  if (process.platform === 'darwin' || process.platform === 'linux') {
    if (shellType === 'auto') {
      return process.env.SHELL || '/bin/zsh'
    }
    // Handle specific shell types
    if (shellType === 'zsh') {
      return '/bin/zsh'
    }
    if (shellType === 'bash') {
      if (fs.existsSync('/opt/homebrew/bin/bash')) return '/opt/homebrew/bin/bash'
      if (fs.existsSync('/usr/local/bin/bash')) return '/usr/local/bin/bash'
      return '/bin/bash'
    }
    if (shellType === 'sh') {
      return '/bin/sh'
    }
    // Windows shells requested on Unix - fall back to default
    if (shellType === 'pwsh' || shellType === 'powershell' || shellType === 'cmd') {
      return process.env.SHELL || '/bin/zsh'
    }
    return shellType // custom path
  }

  // Windows support
  if (shellType === 'auto' || shellType === 'pwsh') {
    const pwshPaths = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
      process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\pwsh.exe'
    ]
    for (const p of pwshPaths) {
      if (fs.existsSync(p)) {
        return p
      }
    }
    if (shellType === 'pwsh') return 'pwsh.exe'
  }

  if (shellType === 'auto' || shellType === 'powershell') {
    return 'powershell.exe'
  }

  if (shellType === 'cmd') {
    return 'cmd.exe'
  }

  return shellType // custom path
})

ipcMain.handle('shell:open-external', async (_event, url: string) => {
  await shell.openExternal(url)
})

ipcMain.handle('shell:open-path', async (_event, folderPath: string) => {
  await shell.openPath(folderPath)
})

ipcMain.handle('git:get-github-url', async (_event, folderPath: string): Promise<string | null> => {
  try {
    const { execSync } = await import('child_process')
    const remote = execSync('git remote get-url origin', { cwd: folderPath, encoding: 'utf-8', timeout: 3000 }).trim()
    // SSH: git@github.com:user/repo.git
    const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/)
    if (sshMatch) return `https://github.com/${sshMatch[1]}`
    // HTTPS: https://github.com/user/repo.git
    const httpsMatch = remote.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/)
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}`
    return null
  } catch {
    return null
  }
})

// Update checker handlers
ipcMain.handle('update:check', async () => {
  try {
    return await checkForUpdates()
  } catch (error) {
    console.error('Failed to check for updates:', error)
    return {
      hasUpdate: false,
      currentVersion: app.getVersion(),
      latestRelease: null
    }
  }
})

ipcMain.handle('update:get-version', () => {
  return app.getVersion()
})

// Snippet handlers
ipcMain.handle('snippet:getAll', () => {
  return snippetDb.getAll()
})

ipcMain.handle('snippet:getById', (_event, id: number) => {
  return snippetDb.getById(id)
})

ipcMain.handle('snippet:create', (_event, input: CreateSnippetInput) => {
  return snippetDb.create(input)
})

ipcMain.handle('snippet:update', (_event, id: number, updates: Partial<CreateSnippetInput>) => {
  return snippetDb.update(id, updates)
})

ipcMain.handle('snippet:delete', (_event, id: number) => {
  return snippetDb.delete(id)
})

ipcMain.handle('snippet:toggleFavorite', (_event, id: number) => {
  return snippetDb.toggleFavorite(id)
})

ipcMain.handle('snippet:search', (_event, query: string) => {
  return snippetDb.search(query)
})

ipcMain.handle('snippet:getCategories', () => {
  return snippetDb.getCategories()
})

ipcMain.handle('snippet:getFavorites', () => {
  return snippetDb.getFavorites()
})

// Claude Agent SDK handlers
ipcMain.handle('claude:start-session', async (_event, sessionId: string, options: { cwd: string; prompt?: string; workspaceId?: string }) => {
  sessionTracker?.initSession(sessionId, options.workspaceId ?? '')
  return claudeManager?.startSession(sessionId, options)
})

ipcMain.handle('claude:send-message', async (_event, sessionId: string, prompt: string, images?: string[]) => {
  return claudeManager?.sendMessage(sessionId, prompt, images)
})

ipcMain.handle('claude:stop-session', async (_event, sessionId: string) => {
  return claudeManager?.stopSession(sessionId)
})

ipcMain.handle('claude:set-permission-mode', async (_event, sessionId: string, mode: string) => {
  return claudeManager?.setPermissionMode(sessionId, mode as import('@anthropic-ai/claude-agent-sdk').PermissionMode)
})

ipcMain.handle('claude:set-model', async (_event, sessionId: string, model: string) => {
  return claudeManager?.setModel(sessionId, model)
})

ipcMain.handle('claude:set-max-thinking-tokens', async (_event, sessionId: string, tokens: number | null) => {
  return claudeManager?.setMaxThinkingTokens(sessionId, tokens)
})

ipcMain.handle('claude:get-supported-models', async (_event, sessionId: string) => {
  return claudeManager?.getSupportedModels(sessionId)
})

ipcMain.handle('claude:resolve-permission', async (_event, sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; message?: string }) => {
  return claudeManager?.resolvePermission(sessionId, toolUseId, result)
})

ipcMain.handle('claude:resolve-ask-user', async (_event, sessionId: string, toolUseId: string, answers: Record<string, string>) => {
  return claudeManager?.resolveAskUser(sessionId, toolUseId, answers)
})

ipcMain.handle('claude:list-sessions', async (_event, cwd: string) => {
  return claudeManager?.listSessions(cwd)
})

ipcMain.handle('claude:resume-session', async (_event, sessionId: string, sdkSessionId: string, cwd: string) => {
  return claudeManager?.resumeSession(sessionId, sdkSessionId, cwd)
})

ipcMain.handle('claude:rest-session', async (_event, sessionId: string) => {
  return claudeManager?.restSession(sessionId)
})

ipcMain.handle('claude:wake-session', async (_event, sessionId: string) => {
  return claudeManager?.wakeSession(sessionId)
})

ipcMain.handle('claude:is-resting', async (_event, sessionId: string) => {
  return claudeManager?.isResting(sessionId) ?? false
})

// Message archiving — serialize old messages to disk to free renderer memory
const MESSAGE_ARCHIVE_DIR = path.join(app.getPath('userData'), 'message-archives')

ipcMain.handle('claude:archive-messages', async (_event, sessionId: string, messages: unknown[]) => {
  await fs.mkdir(MESSAGE_ARCHIVE_DIR, { recursive: true })
  const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
  await fs.appendFile(filePath, lines, 'utf-8')
  return true
})

ipcMain.handle('claude:load-archived', async (_event, sessionId: string, offset: number, limit: number) => {
  const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const total = lines.length
    // Load from the end: offset = how many we've already loaded back
    const end = total - offset
    const start = Math.max(0, end - limit)
    if (end <= 0) return { messages: [], total, hasMore: false }
    const slice = lines.slice(start, end)
    return {
      messages: slice.map(l => JSON.parse(l)),
      total,
      hasMore: start > 0,
    }
  } catch {
    return { messages: [], total: 0, hasMore: false }
  }
})

ipcMain.handle('claude:clear-archive', async (_event, sessionId: string) => {
  const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
  try { await fs.unlink(filePath) } catch { /* ignore */ }
  return true
})

// Git branch detection
ipcMain.handle('git:branch', async (_event, cwd: string) => {
  try {
    const { execSync } = await import('child_process')
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 3000 }).trim()
    return branch || null
  } catch {
    return null // not a git repo or git not available
  }
})

// Git log
ipcMain.handle('git:log', async (_event, cwd: string, count: number = 50) => {
  try {
    const { execSync } = await import('child_process')
    const raw = execSync(
      `git log --pretty=format:"%H||%an||%ai||%s" -n ${count}`,
      { cwd, encoding: 'utf-8', timeout: 5000 }
    ).trim()
    if (!raw) return []
    return raw.split('\n').map(line => {
      const parts = line.split('||')
      return { hash: parts[0], author: parts[1], date: parts[2], message: parts.slice(3).join('||') }
    })
  } catch { return [] }
})

// Git diff (full or single file)
ipcMain.handle('git:diff', async (_event, cwd: string, commitHash?: string, filePath?: string) => {
  try {
    const { execSync } = await import('child_process')
    let cmd: string
    if (commitHash && commitHash !== 'working') {
      cmd = `git diff ${commitHash}~1..${commitHash}`
    } else {
      cmd = 'git diff HEAD'
    }
    if (filePath) cmd += ` -- "${filePath}"`
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 * 5 })
  } catch { return '' }
})

// Git changed files for a commit
ipcMain.handle('git:diff-files', async (_event, cwd: string, commitHash?: string) => {
  try {
    const { execSync } = await import('child_process')
    let cmd: string
    if (commitHash && commitHash !== 'working') {
      cmd = `git diff --name-status ${commitHash}~1..${commitHash}`
    } else {
      cmd = 'git diff --name-status HEAD'
    }
    const raw = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000 })
    if (!raw.trim()) return []
    return raw.trim().split('\n').map(line => {
      const tab = line.indexOf('\t')
      return {
        status: tab > 0 ? line.substring(0, tab).trim() : line.charAt(0),
        file: tab > 0 ? line.substring(tab + 1) : line.substring(2),
      }
    })
  } catch { return [] }
})

// Git status
ipcMain.handle('git:status', async (_event, cwd: string) => {
  try {
    const { execSync } = await import('child_process')
    const raw = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000 })
    if (!raw.trim()) return []
    return raw.trim().split('\n').map(line => ({
      status: line.substring(0, 2).trim(),
      file: line.substring(3),
    }))
  } catch { return [] }
})

// File system: read directory
ipcMain.handle('fs:readdir', async (_event, dirPath: string) => {
  const fs = await import('fs/promises')
  const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.cache', '__pycache__', '.DS_Store'])
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter(e => !IGNORED.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map(e => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }))
  } catch { return [] }
})

// File system: read file (text, max 500KB)
ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
  const fs = await import('fs/promises')
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > 512 * 1024) return { error: 'File too large', size: stat.size }
    const content = await fs.readFile(filePath, 'utf-8')
    return { content }
  } catch {
    return { error: 'Failed to read file' }
  }
})

// File system: recursive search by filename
ipcMain.handle('fs:search', async (_event, dirPath: string, query: string) => {
  const fs = await import('fs/promises')
  const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.cache', '__pycache__', '.DS_Store', 'release'])
  const results: { name: string; path: string; isDirectory: boolean }[] = []
  const lowerQuery = query.toLowerCase()

  async function walk(dir: string, depth: number) {
    if (depth > 8 || results.length >= 100) return
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (results.length >= 100) return
        if (IGNORED.has(e.name)) continue
        const fullPath = path.join(dir, e.name)
        if (e.name.toLowerCase().includes(lowerQuery)) {
          results.push({ name: e.name, path: fullPath, isDirectory: e.isDirectory() })
        }
        if (e.isDirectory()) await walk(fullPath, depth + 1)
      }
    } catch { /* skip unreadable dirs */ }
  }

  await walk(dirPath, 0)
  return results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
})

// Clipboard image handlers
ipcMain.handle('clipboard:saveImage', async () => {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const fs = await import('fs/promises')
  const os = await import('os')
  const tempDir = os.tmpdir()
  const filePath = path.join(tempDir, `bat-clipboard-${Date.now()}.png`)
  await fs.writeFile(filePath, image.toPNG())
  return filePath
})

ipcMain.handle('clipboard:writeImage', async (_event, filePath: string) => {
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return false
  clipboard.writeImage(image)
  return true
})

// Image handlers for Claude Agent Panel
ipcMain.handle('image:read-as-data-url', async (_event, filePath: string) => {
  const fs = await import('fs/promises')
  const ext = path.extname(filePath).toLowerCase()
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  }
  const mime = mimeMap[ext] || 'image/png'
  const data = await fs.readFile(filePath)
  return `data:${mime};base64,${data.toString('base64')}`
})

ipcMain.handle('dialog:select-images', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile', 'multiSelections'],
  })
  return result.canceled ? [] : result.filePaths
})
