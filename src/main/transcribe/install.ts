import { spawn } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { TranscriptionFailedError, TranscriptionUnavailableError } from '../../shared/errors.ts'
import { log } from '../log.ts'

/**
 * Getting whisper.cpp onto the machine.
 *
 * Upstream publishes ready-to-run archives for Windows and Linux but not for
 * macOS -- the only mac artifact is an xcframework, which is a library, not a
 * command-line tool. So the platforms genuinely differ: Windows and Linux
 * download a pinned release the first time a transcription needs it, and macOS
 * shells out to Homebrew, which is the route upstream itself documents.
 */

/** Pinned so a surprise upstream change can never break transcription silently. */
const WHISPER_TAG = 'b4938'
const RELEASES = 'https://github.com/ggml-org/whisper.cpp/releases/download'

export type InstallProgress = (fraction: number, note: string) => void

interface PlatformBuild {
  url: string
  archive: string
  /** Where whisper-cli sits inside the extracted archive. */
  binRelPath: string
}

function platformBuild(): PlatformBuild | null {
  const { platform, arch } = process
  if (platform === 'win32' && arch === 'x64') {
    return {
      url: `${RELEASES}/${WHISPER_TAG}/whisper-bin-x64.zip`,
      archive: 'whisper-bin-x64.zip',
      binRelPath: join('Release', 'whisper-cli.exe')
    }
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    const name = `whisper-bin-ubuntu-${arch === 'x64' ? 'x64' : 'arm64'}`
    return {
      url: `${RELEASES}/${WHISPER_TAG}/${name}.tar.gz`,
      archive: `${name}.tar.gz`,
      binRelPath: join(name, 'whisper-cli')
    }
  }
  return null
}

/** Where a downloaded whisper.cpp lives: beside the cached model. */
export function whisperInstallDir(modelDir: string): string {
  return join(modelDir, 'whisper')
}

function downloadedBin(modelDir: string): string | null {
  const build = platformBuild()
  if (!build) return null
  const p = join(whisperInstallDir(modelDir), build.binRelPath)
  return existsSync(p) ? p : null
}

function findBrew(): string | null {
  if (process.platform !== 'darwin') return null
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) if (existsSync(p)) return p
  return null
}

/**
 * Resolves whisper-cli: an explicit setting first, then one we downloaded
 * ourselves, then the usual places a package manager would have put it.
 */
export function findWhisperBin(configured: string, modelDir: string): string | null {
  const own = downloadedBin(modelDir)
  const candidates = [
    configured,
    process.env.WHISPER_CLI_PATH,
    own,
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    '/opt/homebrew/bin/whisper',
    '/usr/local/bin/whisper'
  ].filter(Boolean) as string[]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/** How installWhisper() would get a binary here, if it can at all. */
export function whisperInstallRoute(): 'download' | 'homebrew' | null {
  if (platformBuild()) return 'download'
  if (findBrew()) return 'homebrew'
  return null
}

/**
 * The Linux archive ships its shared objects next to the executable, and
 * nothing on the system knows to look there.
 */
export function whisperSpawnEnv(bin: string): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return process.env
  const dir = dirname(bin)
  const existing = process.env.LD_LIBRARY_PATH
  return { ...process.env, LD_LIBRARY_PATH: existing ? `${dir}:${existing}` : dir }
}

function run(
  cmd: string,
  args: string[],
  onLine?: (line: string) => void,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: env ?? process.env })
    let err = ''
    const watch = (d: Buffer): void => {
      const s = d.toString()
      err += s
      if (err.length > 20000) err = err.slice(-12000)
      const last = s.trim().split('\n').filter(Boolean).pop()
      if (last && onLine) onLine(last.slice(0, 160))
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('error', (e) => reject(TranscriptionFailedError(`${cmd} failed to start: ${e.message}`)))
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(TranscriptionFailedError(`${cmd} exited ${code}: ${err.slice(-800)}`))
    )
  })
}

async function downloadArchive(url: string, target: string, onProgress: InstallProgress): Promise<void> {
  const partial = `${target}.part`
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw TranscriptionFailedError(`whisper.cpp download failed with HTTP ${res.status}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastPct = -1

  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total <= 0) return
    const pct = Math.floor((received / total) * 100)
    if (pct === lastPct) return
    lastPct = pct
    onProgress((received / total) * 0.8, 'Downloading Whisper')
  })

  try {
    await pipeline(body, createWriteStream(partial))
    renameSync(partial, target)
  } catch (e) {
    try {
      rmSync(partial, { force: true })
    } catch {
      // best effort
    }
    throw TranscriptionFailedError(`whisper.cpp download failed: ${String(e)}`)
  }
}

/**
 * Fetches and unpacks the pinned upstream build for this platform. Throws on
 * any platform upstream does not publish one for.
 */
export async function downloadWhisperBuild(
  modelDir: string,
  onProgress: InstallProgress = () => {}
): Promise<string> {
  const build = platformBuild()
  if (!build) {
    throw TranscriptionUnavailableError(
      `whisper.cpp publishes no prebuilt binary for ${process.platform}/${process.arch}`
    )
  }

  const dir = whisperInstallDir(modelDir)
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, build.archive)
  log.info('stt', 'installing whisper.cpp', { url: build.url, dir })

  if (!existsSync(archive) || statSync(archive).size < 100_000) {
    await downloadArchive(build.url, archive, onProgress)
  }

  onProgress(0.85, 'Unpacking Whisper')
  if (build.archive.endsWith('.zip')) {
    // Expand-Archive ships with every supported Windows, so unpacking costs
    // no extra dependency.
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`
    ])
  } else {
    await run('tar', ['-xzf', archive, '-C', dir])
  }

  const bin = join(dir, build.binRelPath)
  if (!existsSync(bin)) {
    throw TranscriptionFailedError(`whisper.cpp unpacked but ${build.binRelPath} is missing`)
  }
  if (process.platform !== 'win32') chmodSync(bin, 0o755)
  // The archive is a few MB and only useful once.
  rmSync(archive, { force: true })

  onProgress(1, 'Whisper ready')
  log.info('stt', 'whisper.cpp installed', { bin })
  return bin
}

/**
 * Puts whisper-cli on the machine and returns its path. Safe to call when one
 * is already present -- it short-circuits.
 */
export async function installWhisper(
  configured: string,
  modelDir: string,
  onProgress: InstallProgress = () => {}
): Promise<string> {
  const already = findWhisperBin(configured, modelDir)
  if (already) return already

  if (platformBuild()) return await downloadWhisperBuild(modelDir, onProgress)

  const brew = findBrew()
  if (brew) {
    log.info('stt', 'installing whisper.cpp via homebrew', { brew })
    onProgress(0.05, 'Installing Whisper with Homebrew')
    // No fraction to report -- brew tells us what it is doing, so pass its
    // last line through instead of inventing a percentage.
    //
    // The env matters more than it looks. Left alone, `brew install
    // whisper-cpp` also upgrades every installed formula that depends on
    // anything it touches -- on a real machine that meant dragging ffmpeg,
    // glib and pango along for the ride. Nobody clicking "install Whisper"
    // is asking for that.
    await run(brew, ['install', 'whisper-cpp'], (line) => onProgress(0.5, line), {
      ...process.env,
      HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1',
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_ENV_HINTS: '1'
    })
    const bin = findWhisperBin(configured, modelDir)
    if (!bin) throw TranscriptionFailedError('brew install whisper-cpp finished but whisper-cli is still missing')
    onProgress(1, 'Whisper ready')
    log.info('stt', 'whisper.cpp installed via homebrew', { bin })
    return bin
  }

  throw TranscriptionUnavailableError(
    process.platform === 'darwin'
      ? 'Local transcription needs whisper.cpp, and installing it automatically needs Homebrew. Install Homebrew from brew.sh and try again, run `brew install whisper-cpp` yourself, or add an OpenAI or Groq API key in Settings to transcribe in the cloud.'
      : `There is no prebuilt whisper.cpp for ${process.platform}/${process.arch}. Build it yourself and point Settings at the binary, or add an OpenAI or Groq API key to transcribe in the cloud.`
  )
}
