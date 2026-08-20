import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { log } from '../log.ts'
import { sidecarSupported } from './capture.ts'
import type { LoopbackStatus } from '../../shared/types.ts'

export type { LoopbackStatus }

/**
 * Recording what the machine is playing.
 *
 * Electron can do this on its own on Windows: `setDisplayMediaRequestHandler`
 * accepts `audio: 'loopback'`, and the docs are explicit that the option is
 * "currently only supported on Windows" (electron.d.ts).
 *
 * macOS has no such hook in Chromium, but the OS does expose the system mix
 * through ScreenCaptureKit -- which is how OBS stopped needing a virtual audio
 * device in version 29. We reach it the same way, through a small Swift helper
 * (see audio/capture.ts). A virtual device stays as the fallback for macOS 12
 * and for anyone who already has one wired up, since it also captures from apps
 * on a second display and survives a denied screen-recording prompt.
 */
export const DEVICE_PATTERN = 'blackhole|loopback|soundflower|virtual audio|vb-audio|voicemeeter'

function findBrew(): string | null {
  if (process.platform !== 'darwin') return null
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) if (existsSync(p)) return p
  return null
}

function blackholeInstalled(): boolean {
  return existsSync('/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver')
}

export function loopbackStatus(): LoopbackStatus {
  if (process.platform === 'win32') {
    return {
      available: true,
      route: 'native',
      detail: 'Windows captures what the machine is playing without anything extra.',
      remedy: '',
      devicePattern: DEVICE_PATTERN,
      installable: false
    }
  }
  if (process.platform === 'darwin') {
    const installed = blackholeInstalled()
    if (sidecarSupported()) {
      return {
        available: true,
        route: 'sidecar',
        detail: installed
          ? 'Captured directly from macOS, the same way OBS does it. Your BlackHole device still works if you would rather route audio yourself.'
          : 'Captured directly from macOS, the same way OBS does it. Nothing to install -- it uses the screen recording permission you have already granted.',
        remedy: '',
        devicePattern: DEVICE_PATTERN,
        installable: false
      }
    }

    return {
      available: installed,
      route: installed ? 'device' : 'none',
      detail: installed
        ? 'BlackHole is installed. Send the audio you want to record into it -- a Multi-Output Device in Audio MIDI Setup lets you keep hearing it too.'
        : 'macOS gives no app the system mix directly. A virtual audio device is how every screen recorder on the platform does this.',
      remedy: installed
        ? ''
        : findBrew()
          ? 'Showoff can install BlackHole for you (2-channel virtual audio device, open source). macOS will ask for your password, because audio drivers install system-wide.'
          : 'Install Homebrew from brew.sh and Showoff can install BlackHole for you, or download it directly from existential.audio.',
      devicePattern: DEVICE_PATTERN,
      installable: !installed && Boolean(findBrew())
    }
  }
  return {
    available: false,
    route: 'none',
    detail: 'Computer audio capture is not wired up on this platform yet.',
    remedy: '',
    devicePattern: DEVICE_PATTERN,
    installable: false
  }
}

/** Installs BlackHole through Homebrew. macOS only; a no-op anywhere else. */
export async function installLoopback(
  onProgress: (fraction: number, note: string) => void
): Promise<LoopbackStatus> {
  if (process.platform !== 'darwin') return loopbackStatus()
  const brew = findBrew()
  if (!brew) {
    throw new Error(
      'Homebrew is not installed. Install it from brew.sh, or install BlackHole by hand from existential.audio.'
    )
  }

  onProgress(0.1, 'Installing BlackHole through Homebrew…')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(brew, ['install', '--cask', 'blackhole-2ch'], { windowsHide: true })
    let out = ''
    const take = (d: Buffer): void => {
      out += d.toString()
      if (out.length > 8000) out = out.slice(-4000)
      const line = d.toString().trim().split('\n').pop()
      if (line) onProgress(0.5, line.slice(0, 120))
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (e) => reject(new Error(`Could not run brew: ${e.message}`)))
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `brew install blackhole-2ch exited ${code}. It usually needs your password for the driver.\n\n${out.slice(-800)}`
            )
          )
    )
  })

  onProgress(1, 'Installed')
  const status = loopbackStatus()
  log.info('audio', 'loopback install finished', { available: status.available })
  return status
}
