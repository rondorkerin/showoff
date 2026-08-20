import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFfmpeg, probe } from '../src/main/media/ffmpeg.ts'
import {
  remuxToMp4,
  muxTracks,
  extractAudioWav,
  posterFrame,
  detectSilence,
  renderClip
} from '../src/main/media/render.ts'
import { buildAss, cuesForWindow, splitCue } from '../src/main/media/captions.ts'
import { PLATFORMS } from '../src/shared/platforms.ts'

process.env.SHOWOFF_QUIET = '1'

let dir
let sourceWebm
let camWebm

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'showoff-media-'))

  // A 12s 1280x720 "screen recording": moving test pattern + tone with a gap of
  // silence in the middle so silence detection has something real to find.
  sourceWebm = join(dir, 'screen.webm')
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-af', 'volume=enable=\'between(t,4,7)\':volume=0',
    '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus',
    '-t', '12', sourceWebm
  ])

  // A 12s "webcam" track at a different aspect ratio.
  camWebm = join(dir, 'cam.webm')
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=12',
    '-c:v', 'libvpx-vp9', '-b:v', '500k', '-an', '-t', '12', camWebm
  ])
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test('probe reads real media properties', async () => {
  const info = await probe(sourceWebm)
  assert.equal(info.width, 1280)
  assert.equal(info.height, 720)
  assert.ok(info.hasVideo && info.hasAudio)
  assert.ok(Math.abs(info.durationMs - 12000) < 600, `duration was ${info.durationMs}`)
})

test('remux webm to a seekable mp4', async () => {
  const out = join(dir, 'master.mp4')
  const info = await remuxToMp4(sourceWebm, out)
  assert.ok(existsSync(out))
  assert.ok(statSync(out).size > 10000)
  assert.equal(info.width, 1280)
  assert.ok(info.hasAudio)
})

test('mux a silent video track with a separate audio track', async () => {
  const silent = join(dir, 'silent.mp4')
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=5',
    '-c:v', 'libx264', '-an', '-t', '5', silent
  ])
  const audio = join(dir, 'mic.m4a')
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=5', '-c:a', 'aac', '-t', '5', audio
  ])

  const out = join(dir, 'muxed.mp4')
  const info = await muxTracks(silent, audio, out)
  assert.ok(info.hasVideo, 'muxed file must keep video')
  assert.ok(info.hasAudio, 'muxed file must gain the mic audio')
})

test('extract 16k mono wav for whisper', async () => {
  const wav = join(dir, 'audio.wav')
  await extractAudioWav(join(dir, 'master.mp4'), wav)
  const info = await probe(wav)
  assert.ok(info.hasAudio)
  assert.ok(statSync(wav).size > 1000)
})

test('poster frame is a real image', async () => {
  const png = join(dir, 'poster.jpg')
  await posterFrame(join(dir, 'master.mp4'), png, 2)
  assert.ok(statSync(png).size > 1000)
})

test('silence detection finds the gap we deliberately inserted', async () => {
  const ranges = await detectSilence(join(dir, 'master.mp4'), -35, 0.5)
  assert.ok(ranges.length >= 1, 'should find at least one silent range')
  const hit = ranges.find((r) => r.startMs < 5500 && r.endMs > 5500)
  assert.ok(hit, `expected a silence covering 5.5s, got ${JSON.stringify(ranges)}`)
})

test('ass captions are well formed and rebased to the clip window', () => {
  const segments = [
    { start_ms: 0, end_ms: 2000, text: 'before the clip' },
    { start_ms: 4000, end_ms: 6000, text: 'this is the hook line' },
    { start_ms: 6000, end_ms: 8000, text: 'and the payoff, with a {brace} and a, comma' },
    { start_ms: 20000, end_ms: 22000, text: 'after the clip' }
  ]
  const cues = cuesForWindow(segments, 4000, 8000)
  assert.equal(cues.length, 2)
  assert.equal(cues[0].startMs, 0, 'first cue rebases to zero')
  assert.equal(cues[1].endMs, 4000)

  const ass = buildAss(cues, { width: 1080, height: 1920, vertical: true })
  assert.match(ass, /\[Script Info\]/)
  assert.match(ass, /PlayResX: 1080/)
  assert.match(ass, /Dialogue: 0,0:00:00\.00,/)
  assert.match(ass, /\\\{brace\\\}/, 'braces must be escaped or ASS eats them')
  assert.match(ass, /WrapStyle: 0/, 'libass must be allowed to wrap as a safety net')
  assert.equal(ass.includes('after the clip'), false)
})

test('a long segment splits into sequential cards, never truncated', () => {
  const text =
    'so this is the render pipeline actually cutting a vertical clip with burned captions and it keeps every single word'
  const cards = splitCue({ startMs: 0, endMs: 8000, text }, 20, 2)

  assert.ok(cards.length > 1, 'a long line must become several cards')
  assert.equal(cards[0].startMs, 0)
  assert.equal(cards[cards.length - 1].endMs, 8000, 'last card lands exactly on the segment end')

  for (let i = 1; i < cards.length; i++) {
    assert.equal(cards[i].startMs, cards[i - 1].endMs, 'cards must be contiguous')
    assert.ok(cards[i].endMs > cards[i].startMs)
  }

  // Every spoken word survives the split. This is the regression: the first
  // implementation kept 3 lines and silently dropped the rest.
  const recovered = cards.map((c) => c.text).join(' ').replace(/\n/g, ' ')
  assert.equal(recovered.split(/\s+/).join(' '), text)

  for (const c of cards) {
    for (const line of c.text.split('\n')) {
      assert.ok(line.length <= 20, `line too wide for the frame: "${line}"`)
    }
    assert.ok(c.text.split('\n').length <= 2, 'at most two lines on screen')
  }
})

test('a short segment stays a single card', () => {
  const cards = splitCue({ startMs: 100, endMs: 900, text: 'ship it' }, 20, 2)
  assert.deepEqual(cards, [{ startMs: 100, endMs: 900, text: 'ship it' }])
})

test('renders a real clip for every platform at the right dimensions', async () => {
  const master = join(dir, 'master.mp4')
  const cues = cuesForWindow(
    [{ start_ms: 2000, end_ms: 6000, text: 'shipping the render pipeline today' }],
    2000,
    8000
  )

  for (const spec of Object.values(PLATFORMS)) {
    const out = join(dir, `clip-${spec.id}.mp4`)
    const res = await renderClip({
      masterPath: master,
      webcamPath: null,
      outputPath: out,
      startMs: 2000,
      endMs: 8000,
      platform: spec.id,
      captions: cues,
      burnCaptions: true,
      webcamPip: false
    })
    assert.equal(res.width, spec.width, `${spec.id} width`)
    assert.equal(res.height, spec.height, `${spec.id} height`)
    assert.ok(res.bytes > 5000, `${spec.id} produced ${res.bytes} bytes`)
    assert.ok(
      Math.abs(res.durationMs - 6000) < 700,
      `${spec.id} duration was ${res.durationMs}`
    )
    const info = await probe(out)
    assert.ok(info.hasAudio, `${spec.id} must keep audio`)
  }
})

test('renders a vertical clip with webcam picture-in-picture', async () => {
  const master = join(dir, 'master.mp4')
  const cam = join(dir, 'cam.mp4')
  await remuxToMp4(camWebm, cam)

  const out = join(dir, 'clip-pip.mp4')
  const res = await renderClip({
    masterPath: master,
    webcamPath: cam,
    outputPath: out,
    startMs: 1000,
    endMs: 5000,
    platform: 'youtube_short',
    captions: [],
    burnCaptions: false,
    webcamPip: true
  })
  assert.equal(res.width, 1080)
  assert.equal(res.height, 1920)
  assert.ok(res.bytes > 5000)
})

test('a missing webcam file degrades to no-pip instead of failing the render', async () => {
  const out = join(dir, 'clip-nopip.mp4')
  const res = await renderClip({
    masterPath: join(dir, 'master.mp4'),
    webcamPath: join(dir, 'does-not-exist.mp4'),
    outputPath: out,
    startMs: 0,
    endMs: 3000,
    platform: 'x',
    captions: [],
    burnCaptions: false,
    webcamPip: true
  })
  assert.ok(res.bytes > 5000, 'clip should still render without the webcam')
})

test('ffmpeg failure raises a named error carrying stderr, never silent success', async () => {
  await assert.rejects(
    () => runFfmpeg(['-i', join(dir, 'nope.mp4'), join(dir, 'out.mp4')]),
    (e) => {
      assert.equal(e.code, 'FfmpegError')
      assert.ok(e.detail.length > 10, 'error must carry the ffmpeg detail')
      return true
    }
  )
})
