import { contextBridge, ipcRenderer } from 'electron'
import type { CreatePtyOptions } from '../src/types'

const electronAPI = {
  platform: process.platform as 'win32' | 'darwin' | 'linux',
  pty: {
    create: (options: CreatePtyOptions) => ipcRenderer.invoke('pty:create', options),
    write: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('pty:kill', id),
    restart: (id: string, cwd: string, shell?: string) => ipcRenderer.invoke('pty:restart', id, cwd, shell),
    getCwd: (id: string) => ipcRenderer.invoke('pty:get-cwd', id),
    onOutput: (callback: (id: string, data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: string, data: string) => callback(id, data)
      ipcRenderer.on('pty:output', handler)
      return () => ipcRenderer.removeListener('pty:output', handler)
    },
    onExit: (callback: (id: string, exitCode: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: string, exitCode: number) => callback(id, exitCode)
      ipcRenderer.on('pty:exit', handler)
      return () => ipcRenderer.removeListener('pty:exit', handler)
    }
  },
  workspace: {
    save: (data: string) => ipcRenderer.invoke('workspace:save', data),
    load: () => ipcRenderer.invoke('workspace:load')
  },
  settings: {
    save: (data: string) => ipcRenderer.invoke('settings:save', data),
    load: () => ipcRenderer.invoke('settings:load'),
    getShellPath: (shell: string) => ipcRenderer.invoke('settings:get-shell-path', shell)
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
    selectImages: () => ipcRenderer.invoke('dialog:select-images') as Promise<string[]>,
  },
  image: {
    readAsDataUrl: (filePath: string) => ipcRenderer.invoke('image:read-as-data-url', filePath) as Promise<string>,
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    openPath: (folderPath: string) => ipcRenderer.invoke('shell:open-path', folderPath),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    getVersion: () => ipcRenderer.invoke('update:get-version')
  },
  clipboard: {
    saveImage: () => ipcRenderer.invoke('clipboard:saveImage'),
    writeImage: (filePath: string) => ipcRenderer.invoke('clipboard:writeImage', filePath),
  },
  claude: {
    startSession: (sessionId: string, options: { cwd: string; prompt?: string }) =>
      ipcRenderer.invoke('claude:start-session', sessionId, options),
    sendMessage: (sessionId: string, prompt: string, images?: string[]) =>
      ipcRenderer.invoke('claude:send-message', sessionId, prompt, images),
    stopSession: (sessionId: string) =>
      ipcRenderer.invoke('claude:stop-session', sessionId),
    onMessage: (callback: (sessionId: string, message: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, message: unknown) => callback(sessionId, message)
      ipcRenderer.on('claude:message', handler)
      return () => ipcRenderer.removeListener('claude:message', handler)
    },
    onToolUse: (callback: (sessionId: string, toolCall: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, toolCall: unknown) => callback(sessionId, toolCall)
      ipcRenderer.on('claude:tool-use', handler)
      return () => ipcRenderer.removeListener('claude:tool-use', handler)
    },
    onToolResult: (callback: (sessionId: string, result: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, result: unknown) => callback(sessionId, result)
      ipcRenderer.on('claude:tool-result', handler)
      return () => ipcRenderer.removeListener('claude:tool-result', handler)
    },
    onResult: (callback: (sessionId: string, result: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, result: unknown) => callback(sessionId, result)
      ipcRenderer.on('claude:result', handler)
      return () => ipcRenderer.removeListener('claude:result', handler)
    },
    onError: (callback: (sessionId: string, error: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, error: string) => callback(sessionId, error)
      ipcRenderer.on('claude:error', handler)
      return () => ipcRenderer.removeListener('claude:error', handler)
    },
    onStream: (callback: (sessionId: string, data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: unknown) => callback(sessionId, data)
      ipcRenderer.on('claude:stream', handler)
      return () => ipcRenderer.removeListener('claude:stream', handler)
    },
    onStatus: (callback: (sessionId: string, meta: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, meta: unknown) => callback(sessionId, meta)
      ipcRenderer.on('claude:status', handler)
      return () => ipcRenderer.removeListener('claude:status', handler)
    },
    onModeChange: (callback: (sessionId: string, mode: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, mode: string) => callback(sessionId, mode)
      ipcRenderer.on('claude:modeChange', handler)
      return () => ipcRenderer.removeListener('claude:modeChange', handler)
    },
    setPermissionMode: (sessionId: string, mode: string) =>
      ipcRenderer.invoke('claude:set-permission-mode', sessionId, mode),
    setModel: (sessionId: string, model: string) =>
      ipcRenderer.invoke('claude:set-model', sessionId, model),
    setMaxThinkingTokens: (sessionId: string, tokens: number | null) =>
      ipcRenderer.invoke('claude:set-max-thinking-tokens', sessionId, tokens),
    getSupportedModels: (sessionId: string) =>
      ipcRenderer.invoke('claude:get-supported-models', sessionId),
    resolvePermission: (sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; message?: string }) =>
      ipcRenderer.invoke('claude:resolve-permission', sessionId, toolUseId, result),
    resolveAskUser: (sessionId: string, toolUseId: string, answers: Record<string, string>) =>
      ipcRenderer.invoke('claude:resolve-ask-user', sessionId, toolUseId, answers),
    listSessions: (cwd: string) =>
      ipcRenderer.invoke('claude:list-sessions', cwd),
    resumeSession: (sessionId: string, sdkSessionId: string, cwd: string) =>
      ipcRenderer.invoke('claude:resume-session', sessionId, sdkSessionId, cwd),
    restSession: (sessionId: string) =>
      ipcRenderer.invoke('claude:rest-session', sessionId) as Promise<boolean>,
    wakeSession: (sessionId: string) =>
      ipcRenderer.invoke('claude:wake-session', sessionId) as Promise<boolean>,
    isResting: (sessionId: string) =>
      ipcRenderer.invoke('claude:is-resting', sessionId) as Promise<boolean>,
    archiveMessages: (sessionId: string, messages: unknown[]) =>
      ipcRenderer.invoke('claude:archive-messages', sessionId, messages) as Promise<boolean>,
    loadArchived: (sessionId: string, offset: number, limit: number) =>
      ipcRenderer.invoke('claude:load-archived', sessionId, offset, limit) as Promise<{ messages: unknown[]; total: number; hasMore: boolean }>,
    clearArchive: (sessionId: string) =>
      ipcRenderer.invoke('claude:clear-archive', sessionId) as Promise<boolean>,
    onHistory: (callback: (sessionId: string, items: unknown[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, items: unknown[]) => callback(sessionId, items)
      ipcRenderer.on('claude:history', handler)
      return () => ipcRenderer.removeListener('claude:history', handler)
    },
    onPermissionRequest: (callback: (sessionId: string, data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: unknown) => callback(sessionId, data)
      ipcRenderer.on('claude:permission-request', handler)
      return () => ipcRenderer.removeListener('claude:permission-request', handler)
    },
    onAskUser: (callback: (sessionId: string, data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: unknown) => callback(sessionId, data)
      ipcRenderer.on('claude:ask-user', handler)
      return () => ipcRenderer.removeListener('claude:ask-user', handler)
    },
  },
  git: {
    getGithubUrl: (folderPath: string) => ipcRenderer.invoke('git:get-github-url', folderPath) as Promise<string | null>,
    getBranch: (cwd: string) => ipcRenderer.invoke('git:branch', cwd) as Promise<string | null>,
    getLog: (cwd: string, count?: number) => ipcRenderer.invoke('git:log', cwd, count) as Promise<{ hash: string; author: string; date: string; message: string }[]>,
    getDiff: (cwd: string, commitHash?: string, filePath?: string) => ipcRenderer.invoke('git:diff', cwd, commitHash, filePath) as Promise<string>,
    getDiffFiles: (cwd: string, commitHash?: string) => ipcRenderer.invoke('git:diff-files', cwd, commitHash) as Promise<{ status: string; file: string }[]>,
    getStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd) as Promise<{ status: string; file: string }[]>,
  },
  fs: {
    readdir: (dirPath: string) => ipcRenderer.invoke('fs:readdir', dirPath) as Promise<{ name: string; path: string; isDirectory: boolean }[]>,
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath) as Promise<{ content?: string; error?: string; size?: number }>,
    search: (dirPath: string, query: string) => ipcRenderer.invoke('fs:search', dirPath, query) as Promise<{ name: string; path: string; isDirectory: boolean }[]>,
  },
  session: {
    list: (workspaceId: string) => ipcRenderer.invoke('session:list', workspaceId) as Promise<unknown[]>,
    rename: (sessionId: string, label: string) => ipcRenderer.invoke('session:rename', sessionId, label),
    generateHooks: () => ipcRenderer.invoke('session:generate-hooks'),
    onEvent: (callback: (sessionId: string, event: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, sessionId: string, event: unknown) => callback(sessionId, event)
      ipcRenderer.on('session:event', handler)
      return () => ipcRenderer.removeListener('session:event', handler)
    },
    onUpdate: (callback: (sessionId: string, state: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, sessionId: string, state: unknown) => callback(sessionId, state)
      ipcRenderer.on('session:update', handler)
      return () => ipcRenderer.removeListener('session:update', handler)
    },
  },
  snippet: {
    getAll: () => ipcRenderer.invoke('snippet:getAll'),
    getById: (id: number) => ipcRenderer.invoke('snippet:getById', id),
    create: (input: { title: string; content: string; format?: string; category?: string; tags?: string; isFavorite?: boolean }) =>
      ipcRenderer.invoke('snippet:create', input),
    update: (id: number, updates: { title?: string; content?: string; format?: string; category?: string; tags?: string; isFavorite?: boolean }) =>
      ipcRenderer.invoke('snippet:update', id, updates),
    delete: (id: number) => ipcRenderer.invoke('snippet:delete', id),
    toggleFavorite: (id: number) => ipcRenderer.invoke('snippet:toggleFavorite', id),
    search: (query: string) => ipcRenderer.invoke('snippet:search', query),
    getCategories: () => ipcRenderer.invoke('snippet:getCategories'),
    getFavorites: () => ipcRenderer.invoke('snippet:getFavorites')
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

declare global {
  interface Window {
    electronAPI: typeof electronAPI
  }
}
