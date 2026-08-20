import { app, BrowserWindow, net, shell } from 'electron'
import { createWriteStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { log } from './log.ts'
import type { InstallResult, UpdateInfo, UpdateRoute, UpdateStatus } from '../shared/types.ts'

const REPO = 'rondorkerin/showoff'

let last: UpdateStatus = {
  current: app.getVersion(),
  packaged: app.isPackaged,
  route: routeFor(),
  available: null,
  checkedAt: null,
  error: null
}

function routeFor(): UpdateRoute {
  // The Windows path relaunches through Squirrel, which needs the
  // app-update.yml that only a packaged build carries. Fetching a disk image
  // and opening it needs nothing, so macOS can do it from a dev run too.
  if (process.platform === 'win32') return app.isPackaged ? 'auto' : 'manual'
  if (process.platform === 'darwin') return 'assist'
  return 'manual'
}

export function updateStatus(): UpdateStatus {
  return last
}

/** Compares dotted versions numerically, so 0.1.10 beats 0.1.9. */
function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/)
  const pb = b.replace(/^v/, '').split(/[.-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0)
    const nb = Number(pb[i] ?? 0)
    if (Number.isNaN(na) || Number.isNaN(nb)) return String(pa[i] ?? '') > String(pb[i] ?? '')
    if (na !== nb) return na > nb
  }
  return false
}

interface GhAsset {
  name: string
  size: number
  browser_download_url: string
}

/** The artifact names come from electron-builder.yml's artifactName templates. */
function wantedAsset(assets: GhAsset[]): GhAsset | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const pick = (re: RegExp): GhAsset | undefined => assets.find((a) => re.test(a.name))
  if (process.platform === 'darwin') {
    return pick(new RegExp(`-${arch}\\.dmg$`)) ?? pick(/\.dmg$/) ?? null
  }
  if (process.platform === 'win32') {
    return pick(/-setup\.exe$/) ?? null
  }
  return pick(/\.AppImage$/) ?? null
}

async function getJson(url: string): Promise<unknown> {
  const res = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Showoff/${app.getVersion()}` }
  })
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`)
  return res.json()
}

/**
 * Asks GitHub what the newest release is.
 *
 * Runs in development too -- knowing the installed copy is behind is the whole
 * point, and it is exactly in a hand-built copy that you cannot tell.
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  try {
    const body = (await getJson(`https://api.github.com/repos/${REPO}/releases/latest`)) as {
      tag_name?: string
      name?: string
      body?: string
      html_url?: string
      assets?: GhAsset[]
    }
    const version = (body.tag_name ?? body.name ?? '').replace(/^v/, '')
    if (!version) throw new Error('the latest release has no version tag')

    const asset = wantedAsset(body.assets ?? [])
    const available: UpdateInfo | null = newer(version, app.getVersion())
      ? {
          version,
          url: body.html_url ?? `https://github.com/${REPO}/releases/tag/v${version}`,
          notes: body.body ?? '',
          assetUrl: asset?.browser_download_url ?? null,
          assetName: asset?.name ?? null,
          bytes: asset?.size ?? 0
        }
      : null

    last = {
      ...last,
      current: app.getVersion(),
      route: routeFor(),
      available,
      checkedAt: new Date().toISOString(),
      error: null
    }
    if (available) {
      log.info('updates', 'newer version available', {
        version,
        current: app.getVersion(),
        asset: available.assetName
      })
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('update:available', available)
      }
    }
    return last
  } catch (e) {
    // Being offline is not an error worth interrupting anybody over, but the
    // Settings pane should still be able to say why it does not know.
    log.debug('updates', 'check failed', { error: String(e) })
    last = { ...last, checkedAt: new Date().toISOString(), error: String(e) }
    return last
  }
}

function progressTo(fraction: number, note: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:progress', { fraction, note })
  }
}

/** Streams a URL to disk, reporting progress as it goes. */
async function download(url: string, to: string, bytes: number): Promise<void> {
  const res = await net.fetch(url, {
    headers: { 'User-Agent': `Showoff/${app.getVersion()}` }
  })
  if (!res.ok || !res.body) throw new Error(`download failed with ${res.status}`)

  const total = Number(res.headers.get('content-length')) || bytes
  let seen = 0
  let announced = 0
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    seen += chunk.length
    const f = total ? seen / total : 0
    // A repaint per 64KB chunk is a lot of IPC for a bar that moves in pixels.
    if (f - announced >= 0.01) {
      announced = f
      progressTo(f, 'Downloading')
    }
  })
  await pipeline(body, createWriteStream(to))
}

/**
 * Gets the new version onto the machine.
 *
 * On macOS the download lands in Downloads and is opened for you. That is not
 * a lesser path than an auto-install: because Showoff wrote the file itself
 * rather than a browser, it carries no quarantine flag, so the copy that comes
 * through here opens without the Gatekeeper argument a manual download starts.
 */
export async function installUpdate(): Promise<InstallResult> {
  const info = last.available
  if (!info) throw new Error('there is no newer version to install')

  if (last.route === 'auto') {
    progressTo(0, 'Preparing')
    const mod = (await import('electron-updater')) as unknown as {
      autoUpdater?: typeof import('electron-updater').autoUpdater
      default?: { autoUpdater?: typeof import('electron-updater').autoUpdater }
    }
    // electron-updater is CommonJS, so a dynamic import hands back the module
    // namespace with everything under `default` once bundled. Reading
    // `autoUpdater` off the namespace directly gets undefined, and the first
    // property set on it throws.
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
    if (!autoUpdater) throw new Error('the updater is not available in this build')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = null
    autoUpdater.on('download-progress', (p: { percent: number }) =>
      progressTo(Math.max(0, Math.min(1, p.percent / 100)), 'Downloading')
    )
    await autoUpdater.checkForUpdates()
    await autoUpdater.downloadUpdate()
    progressTo(1, 'Restarting')
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 400)
    return { action: 'relaunch' }
  }

  if (!info.assetUrl || !info.assetName) {
    await shell.openExternal(info.url)
    return { action: 'handoff' }
  }

  const to = join(app.getPath('downloads'), info.assetName)
  // A half-finished file from a previous attempt would mount as a corrupt dmg.
  await rm(to, { force: true }).catch(() => undefined)
  progressTo(0, 'Downloading')
  await download(info.assetUrl, to, info.bytes)
  const size = (await stat(to)).size
  log.info('updates', 'downloaded', { version: info.version, path: to, bytes: size })
  progressTo(1, 'Opening')
  await shell.openPath(to)
  return { action: 'handoff', path: to }
}
