import { app, BrowserWindow, Menu, protocol, net, shell, session } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc/index.ts'
import { closeDb, getDb } from './db/index.ts'
import { getSettings } from './settings.ts'
import { log } from './log.ts'

const isDev = !app.isPackaged

// Media playback of local mp4s goes through a custom scheme rather than
// file://, so the renderer keeps webSecurity on.
protocol.registerSchemesAsPrivileged([
  { scheme: 'showoff', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } }
])

// Opt-in remote debugging so the app can be driven and screenshotted headlessly
// during development. Never on unless the env var is explicitly set.
if (process.env.SHOWOFF_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.SHOWOFF_DEBUG_PORT)
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0B0C0E',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Anything that wants a new window is an external link; hand it to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Serves recordings and clips to the renderer. Scoped to the storage directory
 * so a compromised renderer cannot read arbitrary files off the disk.
 */
function registerMediaProtocol(): void {
  protocol.handle('showoff', async (request) => {
    try {
      const url = new URL(request.url)
      const target = decodeURIComponent(url.searchParams.get('p') ?? '')
      if (!target) return new Response('missing path', { status: 400 })

      const root = getSettings().storageDir
      const normalized = join(target)
      if (!normalized.startsWith(root)) {
        log.warn('protocol', 'blocked read outside the storage directory', { target })
        return new Response('forbidden', { status: 403 })
      }
      return await net.fetch(pathToFileURL(normalized).toString())
    } catch (e) {
      log.error('protocol', 'media fetch failed', { error: String(e) })
      return new Response('not found', { status: 404 })
    }
  })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open log file',
          click: () => void shell.showItemInFolder(log.path())
        },
        {
          label: 'Showoff on GitHub',
          click: () => void shell.openExternal('https://github.com/rondorkerin/showoff')
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  log.info('app', 'starting', { version: app.getVersion(), platform: process.platform })

  // Screen and mic capture: grant to our own renderer, deny everything else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission))
  })

  registerMediaProtocol()
  registerIpc()
  buildMenu()

  try {
    await getDb()
  } catch (e) {
    // A dead database is worth saying out loud rather than showing an empty
    // library that looks like data loss.
    log.error('app', 'database failed to open', { error: String(e) })
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void closeDb()
})

process.on('uncaughtException', (e) => {
  log.error('app', 'uncaught exception', { error: e.message, stack: e.stack })
})
process.on('unhandledRejection', (e) => {
  log.error('app', 'unhandled rejection', { error: String(e) })
})
