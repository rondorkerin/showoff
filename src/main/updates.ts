import { app, BrowserWindow } from 'electron'
import { log } from './log.ts'

export interface UpdateInfo {
  version: string
  url: string
  notes: string
}

/**
 * Checks GitHub Releases for a newer version and tells the renderer about it.
 *
 * Deliberately does NOT download or install. The v1 builds are unsigned, and
 * Squirrel.Mac refuses to apply an unsigned update — an auto-updater that
 * silently fails every time is worse than a link that works.
 */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  if (!app.isPackaged) return null

  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = null

    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    if (!version || version === app.getVersion()) return null

    const info: UpdateInfo = {
      version,
      url: `https://github.com/rondorkerin/showoff/releases/tag/v${version}`,
      notes: typeof result.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : ''
    }
    log.info('updates', 'newer version available', { version, current: app.getVersion() })

    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update:available', info)
    }
    return info
  } catch (e) {
    // Being offline is not an error worth showing anybody.
    log.debug('updates', 'check failed', { error: String(e) })
    return null
  }
}
