import { mkdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { probe, probeWithDecode, runFfmpeg, runFfprobe, type MediaInfo } from './ffmpeg.ts'
import { buildAss, cuesForWindow, type CaptionCue } from './captions.ts'
import { FfmpegError } from '../../shared/errors.ts'
import { isVideoLane, type LaneFrame, type LaneKind } from '../../shared/types.ts'
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

/* ------------------------------------------------------------- compositing */

/** One lane, flattened for the renderer: the frame is already resolved for the
 * target aspect and the gain is already a multiplier. */
export interface CompositeLane {
  kind: LaneKind
  path: string
  offsetMs: number
  inMs: number
  outMs: number | null
  sourceMs: number | null
  gain: number
  ducks: boolean
  frame: LaneFrame
}

export interface RenderCompositeOptions {
  lanes: CompositeLane[]
  width: number
  height: number
  /** The window to render, measured on the project timeline. */
  startMs: number
  endMs: number
  outputPath: string
  captions?: CaptionCue[]
  burnCaptions?: boolean
  label?: string
  onProgress?: (fraction: number) => void
}

export interface RenderResult {
  path: string
  width: number
  height: number
  durationMs: number
  bytes: number
}

/** Where a lane lands inside the requested window, or null if it misses it. */
function placement(
  lane: CompositeLane,
  startMs: number,
  endMs: number
): { seekSec: number; durSec: number; atSec: number } | null {
  const length = (lane.outMs ?? lane.sourceMs ?? endMs) - lane.inMs
  if (length <= 0) return null
  const laneStart = lane.offsetMs
  const laneEnd = lane.offsetMs + length
  const from = Math.max(laneStart, startMs)
  const to = Math.min(laneEnd, endMs)
  // Under a couple of frames it contributes nothing but an ffmpeg edge case.
  if (to - from < 60) return null
  return {
    seekSec: (lane.inMs + (from - laneStart)) / 1000,
    durSec: (to - from) / 1000,
    atSec: (from - startMs) / 1000
  }
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/**
 * Renders any set of lanes into one file.
 *
 * This is the only compositor in the app: export, clip render and re-render all
 * come through here, so what you arranged in the editor is by construction what
 * comes out of every one of them.
 *
 *   color W*H ---> overlay blurred backdrop ---> overlay each video lane in z
 *                  (from the bottom lane)        order, positioned by its frame
 *                                                          |
 *   each audio lane -> atrim -> volume -> adelay -,        +--> subtitles --> out
 *                                                 +-> duck -> amix ----------^
 */
export async function renderComposite(opts: RenderCompositeOptions): Promise<RenderResult> {
  const W = even(opts.width)
  const H = even(opts.height)
  const totalSec = Math.max(0.2, (opts.endMs - opts.startMs) / 1000)
  const outDir = dirname(opts.outputPath)
  mkdirSync(outDir, { recursive: true })

  const args: string[] = []
  const filters: string[] = []
  const videos: Array<{ lane: CompositeLane; at: { seekSec: number; durSec: number; atSec: number }; input: number }> = []
  const audios: Array<{ lane: CompositeLane; at: { seekSec: number; durSec: number; atSec: number }; input: number }> = []

  for (const lane of opts.lanes) {
    if (!existsSync(lane.path)) {
      log.warn('render', 'lane file is missing, skipping', { path: lane.path })
      continue
    }
    const at = placement(lane, opts.startMs, opts.endMs)
    if (!at) continue
    const input = args.filter((a) => a === '-i').length
    args.push('-accurate_seek', '-ss', String(at.seekSec), '-t', String(at.durSec), '-i', lane.path)
    const bucket = isVideoLane(lane.kind) ? videos : audios
    bucket.push({ lane, at, input })
  }

  if (videos.length === 0 && audios.length === 0) {
    throw FfmpegError('nothing to render: every lane is empty, muted or outside the range')
  }

  /* ----- video ----- */

  filters.push(`color=c=black:s=${W}x${H}:r=30:d=${totalSec},format=yuv420p[base]`)
  let last = 'base'
  let step = 0
  const next = (): string => `v${step++}`

  videos.forEach((v, i) => {
    const src = next()
    filters.push(`[${v.input}:v]setpts=PTS-STARTPTS+${v.at.atSec}/TB,setsar=1[${src}]`)

    // The bottom lane paints a blurred, darkened copy of itself behind the
    // whole frame. Black bars around a 16:9 recording in a 9:16 output look
    // broken; this looks deliberate. Blur at a quarter size and scale back up
    // -- gblur is O(area) and this is the most expensive filter in the graph.
    const isBackdrop = i === 0 && v.lane.frame.scale >= 0.999
    let fg = src
    if (isBackdrop) {
      const bgW = even(W / 4)
      const bgH = even(H / 4)
      const bg = next()
      fg = next()
      const blurred = next()
      const merged = next()
      filters.push(`[${src}]split=2[${bg}][${fg}]`)
      filters.push(
        `[${bg}]scale=${bgW}:${bgH}:force_original_aspect_ratio=increase,crop=${bgW}:${bgH},` +
          `gblur=sigma=${Math.max(2, Math.round(bgW / 45))},eq=brightness=-0.18:saturation=0.7,` +
          `scale=${W}:${H},setsar=1[${blurred}]`
      )
      filters.push(
        `[${last}][${blurred}]overlay=0:0:eof_action=pass:repeatlast=0` +
          `:enable='between(t,${v.at.atSec},${v.at.atSec + v.at.durSec})'[${merged}]`
      )
      last = merged
    }

    const boxW = even(W * v.lane.frame.scale)
    const boxH = even(H * v.lane.frame.scale)
    const scaled = next()
    filters.push(
      `[${fg}]scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease,setsar=1[${scaled}]`
    )
    const onto = next()
    filters.push(
      `[${last}][${scaled}]overlay=x='${Math.round(v.lane.frame.x * W)}-overlay_w/2'` +
        `:y='${Math.round(v.lane.frame.y * H)}-overlay_h/2':eof_action=pass:repeatlast=0` +
        `:enable='between(t,${v.at.atSec},${v.at.atSec + v.at.durSec})'[${onto}]`
    )
    last = onto
  })

  if (opts.burnCaptions && opts.captions && opts.captions.length > 0) {
    const assName = `${basename(opts.outputPath, '.mp4')}.ass`
    writeFileSync(
      join(outDir, assName),
      buildAss(opts.captions, { width: W, height: H, vertical: H > W }),
      'utf8'
    )
    // Running with cwd=outDir lets us pass a bare filename, which sidesteps the
    // Windows drive-letter colon that the subtitles filter cannot escape.
    const burnt = next()
    filters.push(`[${last}]subtitles=${assName}[${burnt}]`)
    last = burnt
  }

  /* ----- audio ----- */

  let audioOut: string | null = null
  if (audios.length > 0) {
    let astep = 0
    const anext = (): string => `a${astep++}`
    const ducking: string[] = []
    const plain: string[] = []

    for (const a of audios) {
      const label = anext()
      const chain = [`asetpts=PTS-STARTPTS`, `volume=${a.lane.gain.toFixed(3)}`]
      if (a.at.atSec > 0.001) chain.push(`adelay=${Math.round(a.at.atSec * 1000)}:all=1`)
      filters.push(`[${a.input}:a]${chain.join(',')}[${label}]`)
      ;(a.lane.ducks ? ducking : plain).push(label)
    }

    const mix = (labels: string[], out: string): void => {
      if (labels.length === 1) filters.push(`[${labels[0]}]anull[${out}]`)
      else filters.push(`[${labels.join('][')}]amix=inputs=${labels.length}:normalize=0[${out}]`)
    }

    if (ducking.length > 0 && plain.length > 0) {
      // A voice-over that fights the original narration is unusable, so the
      // lane marked ducks pushes everything else down while it has speech --
      // and only while it has speech, which is what a manual gain cannot do.
      const duck = anext()
      const rest = anext()
      mix(ducking, duck)
      mix(plain, rest)
      const key = anext()
      const keep = anext()
      filters.push(`[${duck}]asplit=2[${key}][${keep}]`)
      const ducked = anext()
      filters.push(
        `[${rest}][${key}]sidechaincompress=threshold=0.03:ratio=9:attack=25:release=350[${ducked}]`
      )
      audioOut = anext()
      filters.push(`[${ducked}][${keep}]amix=inputs=2:normalize=0:duration=longest[${audioOut}]`)
    } else {
      audioOut = anext()
      mix([...ducking, ...plain], audioOut)
    }
  }

  args.push('-filter_complex', filters.join(';'))
  args.push('-map', `[${last}]`)
  if (audioOut) args.push('-map', `[${audioOut}]`)
  args.push(
    '-t',
    String(totalSec),
    '-c:v',
    'libx264',
    '-preset',
    'faster',
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
    '-movflags',
    '+faststart'
  )
  if (audioOut) args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2')
  else args.push('-an')
  args.push(opts.outputPath)

  await runFfmpegInDir(args, outDir, {
    label: opts.label ?? 'composite',
    totalSeconds: totalSec,
    onProgress: opts.onProgress
  })

  const info = await probe(opts.outputPath)
  const bytes = statSync(opts.outputPath).size
  if (bytes === 0) throw FfmpegError(`render produced a zero-byte file at ${opts.outputPath}`)
  log.info('render', 'composed', {
    label: opts.label,
    lanes: videos.length + audios.length,
    bytes,
    durationMs: info.durationMs
  })

  return {
    path: opts.outputPath,
    width: info.width || W,
    height: info.height || H,
    durationMs: info.durationMs || Math.round(totalSec * 1000),
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
