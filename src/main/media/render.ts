import { mkdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { probe, probeWithDecode, runFfmpeg, runFfprobe, type MediaInfo } from './ffmpeg.ts'
import { buildAss, cuesForWindow, type CaptionCue } from './captions.ts'
import { PLATFORMS, type PlatformId } from '../../shared/platforms.ts'
import { FfmpegError } from '../../shared/errors.ts'
import { log } from '../log.ts'

export { probe, probeWithDecode }
export type { MediaInfo }

/** Remux a MediaRecorder .webm to a seekable .mp4 without re-encoding video. */
export async function remuxToMp4(input: string, output: string): Promise<MediaInfo> {
  mkdirSync(dirname(output), { recursive: true })
  const info = await probeWithDecode(input)

  // VP8/VP9 in webm cannot be copied into mp4 reliably, so transcode video to
  // h264 and audio to aac. This is the one unavoidable full pass; everything
  // downstream cuts from the mp4.
  const args = ['-i', input]
  if (info.hasVideo) {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      // Odd dimensions from an odd window size break h264.
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    )
  } else {
    args.push('-vn')
  }
  if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k')
  else args.push('-an')
  args.push('-movflags', '+faststart', output)

  await runFfmpeg(args, { label: 'remux', totalSeconds: info.durationMs / 1000 })
  return probe(output)
}

/** Combine a silent screen track with a separate mic track into one master. */
export async function muxTracks(
  videoPath: string,
  audioPath: string | null,
  output: string
): Promise<MediaInfo> {
  mkdirSync(dirname(output), { recursive: true })
  const args = ['-i', videoPath]
  if (audioPath) args.push('-i', audioPath)

  args.push('-map', '0:v:0')
  if (audioPath) args.push('-map', '1:a:0')

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2'
  )
  if (audioPath) args.push('-c:a', 'aac', '-b:a', '160k')
  // The tracks start together but may drift in length; stop at the shorter.
  args.push('-shortest', '-movflags', '+faststart', output)

  await runFfmpeg(args, { label: 'mux' })
  return probe(output)
}

/** 16 kHz mono wav is what every Whisper implementation wants. */
export async function extractAudioWav(input: string, output: string): Promise<string> {
  mkdirSync(dirname(output), { recursive: true })
  await runFfmpeg(
    ['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
    { label: 'extract-audio' }
  )
  return output
}

export async function posterFrame(
  input: string,
  output: string,
  atSeconds: number,
  width = 640
): Promise<string> {
  mkdirSync(dirname(output), { recursive: true })
  await runFfmpeg(
    [
      '-ss',
      String(Math.max(0, atSeconds)),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2`,
      '-q:v',
      '3',
      output
    ],
    { label: 'poster' }
  )
  return output
}

export interface SilenceRange {
  startMs: number
  endMs: number
}

/** Ask ffmpeg where the dead air is. Used for both trimming and cut snapping. */
export async function detectSilence(
  input: string,
  noiseDb = -32,
  minDurationSec = 0.7
): Promise<SilenceRange[]> {
  const out = await runFfprobeSilence(input, noiseDb, minDurationSec)
  const ranges: SilenceRange[] = []
  const startRe = /silence_start:\s*(-?[\d.]+)/g
  const endRe = /silence_end:\s*(-?[\d.]+)/g
  const starts: number[] = []
  const ends: number[] = []
  let m: RegExpExecArray | null
  while ((m = startRe.exec(out))) starts.push(Number(m[1]))
  while ((m = endRe.exec(out))) ends.push(Number(m[1]))
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]
    const e = ends[i]
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      ranges.push({ startMs: Math.round(s * 1000), endMs: Math.round(e * 1000) })
    }
  }
  return ranges
}

async function runFfprobeSilence(
  input: string,
  noiseDb: number,
  minDurationSec: number
): Promise<string> {
  // silencedetect writes to stderr; run it through ffmpeg with a null muxer.
  const { spawn } = await import('node:child_process')
  const { getFfmpegPath } = await import('./ffmpeg.ts')
  const bin = getFfmpegPath()
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        input,
        '-af',
        `silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`,
        '-f',
        'null',
        '-'
      ],
      { windowsHide: true }
    )
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => reject(FfmpegError(`silencedetect could not start: ${e.message}`)))
    child.on('close', (code) =>
      code === 0 ? resolve(stderr) : reject(FfmpegError(`silencedetect exited ${code}`))
    )
  })
}

export interface RenderClipOptions {
  masterPath: string
  webcamPath: string | null
  outputPath: string
  startMs: number
  endMs: number
  platform: PlatformId
  captions: CaptionCue[]
  burnCaptions: boolean
  webcamPip: boolean
  onProgress?: (fraction: number) => void
}

export interface RenderClipResult {
  path: string
  width: number
  height: number
  durationMs: number
  bytes: number
}

/**
 * Cuts one clip and fits it to a platform.
 *
 * Fitting uses a blurred, zoomed copy of the same frame as the background
 * rather than black bars. A 16:9 screen recording padded into 9:16 with black
 * bars looks broken; with a blurred backdrop it looks intentional.
 *
 *   [src] --split--> [bg] scale-up + crop + blur + darken --,
 *                    [fg] scale-to-fit --------------------> overlay centred
 *                                                            |
 *                                             webcam PiP -----+--> subtitles --> out
 */
export async function renderClip(opts: RenderClipOptions): Promise<RenderClipResult> {
  const spec = PLATFORMS[opts.platform]
  const { width: W, height: H } = spec

  const startSec = Math.max(0, opts.startMs / 1000)
  const durationSec = Math.max(0.5, (opts.endMs - opts.startMs) / 1000)
  const outDir = dirname(opts.outputPath)
  mkdirSync(outDir, { recursive: true })

  const filters: string[] = []
  const args: string[] = ['-accurate_seek', '-ss', String(startSec), '-t', String(durationSec), '-i', opts.masterPath]

  const usePip = opts.webcamPip && Boolean(opts.webcamPath) && existsSync(opts.webcamPath ?? '')
  if (usePip && opts.webcamPath) {
    args.push(
      '-accurate_seek',
      '-ss',
      String(startSec),
      '-t',
      String(durationSec),
      '-i',
      opts.webcamPath
    )
  }

  filters.push('[0:v]split=2[bg][fg]')
  filters.push(
    `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `gblur=sigma=${Math.max(8, Math.round(W / 45))},eq=brightness=-0.18:saturation=0.7[bgb]`
  )
  filters.push(`[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fgs]`)
  filters.push(`[bgb][fgs]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[base]`)

  let last = 'base'
  if (usePip) {
    const pipW = Math.round(W * 0.24)
    const margin = Math.round(W * 0.03)
    filters.push(`[1:v]scale=${pipW}:-2,setsar=1[pipraw]`)
    filters.push(
      `[${last}][pipraw]overlay=main_w-overlay_w-${margin}:main_h-overlay_h-${margin}[withpip]`
    )
    last = 'withpip'
  }

  if (opts.burnCaptions && opts.captions.length > 0) {
    const assName = `${basename(opts.outputPath, '.mp4')}.ass`
    const assPath = join(outDir, assName)
    writeFileSync(
      assPath,
      buildAss(opts.captions, { width: W, height: H, vertical: H > W }),
      'utf8'
    )
    // Running with cwd=outDir lets us pass a bare filename, which sidesteps the
    // Windows drive-letter colon that the subtitles filter cannot escape.
    filters.push(`[${last}]subtitles=${assName}[vout]`)
    last = 'vout'
  }

  args.push('-filter_complex', filters.join(';'))
  args.push('-map', `[${last}]`)
  args.push('-map', '0:a?')
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '21',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-r',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    opts.outputPath
  )

  await runFfmpegInDir(args, outDir, {
    label: `clip:${opts.platform}`,
    totalSeconds: durationSec,
    onProgress: opts.onProgress
  })

  const info = await probe(opts.outputPath)
  const bytes = statSync(opts.outputPath).size
  if (bytes === 0) {
    throw FfmpegError(`render produced a zero-byte file at ${opts.outputPath}`)
  }
  log.info('render', 'clip rendered', {
    platform: opts.platform,
    bytes,
    durationMs: info.durationMs
  })

  return {
    path: opts.outputPath,
    width: info.width || W,
    height: info.height || H,
    durationMs: info.durationMs || Math.round(durationSec * 1000),
    bytes
  }
}

/** runFfmpeg, but with a working directory (needed for the subtitles filter). */
async function runFfmpegInDir(
  args: string[],
  cwd: string,
  opts: { label?: string; totalSeconds?: number; onProgress?: (f: number) => void }
): Promise<void> {
  const { spawn } = await import('node:child_process')
  const { getFfmpegPath } = await import('./ffmpeg.ts')
  const bin = getFfmpegPath()
  log.debug('ffmpeg', opts.label ?? 'run', { cwd, argv: args.join(' ') })

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', '-y', ...args], {
      cwd,
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      if (stderr.length > 24000) stderr = stderr.slice(-16000)
      if (opts.onProgress && opts.totalSeconds) {
        const m = chunk.match(/time=(\d+):(\d+):(\d+\.?\d*)/)
        if (m) {
          const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
          opts.onProgress(Math.max(0, Math.min(1, secs / opts.totalSeconds)))
        }
      }
    })
    child.on('error', (e) => reject(FfmpegError(`could not start ffmpeg: ${e.message}`)))
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(FfmpegError(`ffmpeg exited ${code}\n\nargs: ${args.join(' ')}\n\n${stderr.slice(-4000)}`))
    )
  })
}

export { cuesForWindow }
