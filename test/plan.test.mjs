import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseClipPlan,
  snapToSegments,
  overlapFraction,
  formatTranscript,
  fillTemplate,
  MIN_CLIP_MS
} from '../src/main/pipeline/plan.ts'
import { extractJson } from '../src/shared/schemas.ts'

const segments = [
  { startMs: 0, endMs: 5000, text: 'intro rambling' },
  { startMs: 5000, endMs: 20000, text: 'the good part where the thing works' },
  { startMs: 20000, endMs: 40000, text: 'explaining how it works' },
  { startMs: 40000, endMs: 60000, text: 'wrap up' }
]
const base = {
  durationMs: 60000,
  segments,
  allowedPlatforms: ['x', 'linkedin', 'youtube_short', 'youtube'],
  maxClips: 6
}

const clip = (o = {}) => ({
  platform: 'x',
  title: 'A clip',
  hook: 'the hook',
  description: 'what happened',
  hashtags: ['#build'],
  reason: 'good moment',
  score: 7,
  start_seconds: 5,
  end_seconds: 20,
  ...o
})

test('extracts JSON from fenced, prefixed and bare model output', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('Sure! Here you go:\n\n{"a":1}\n\nHope that helps.'), { a: 1 })
  assert.deepEqual(extractJson('{"a":"has } brace"}'), { a: 'has } brace' })
  assert.equal(extractJson('no json at all'), null)
})

test('a well formed plan survives intact', () => {
  const clips = parseClipPlan(JSON.stringify({ clips: [clip()] }), base)
  assert.equal(clips.length, 1)
  assert.equal(clips[0].startMs, 5000)
  assert.equal(clips[0].endMs, 20000)
  assert.deepEqual(clips[0].hashtags, ['build'], 'leading # is stripped for reuse')
})

test('clips running past the end of the video are clamped, not rendered broken', () => {
  const clips = parseClipPlan(
    JSON.stringify({ clips: [clip({ start_seconds: 40, end_seconds: 900 })] }),
    base
  )
  assert.equal(clips.length, 1)
  assert.ok(clips[0].endMs <= 60000, `end was ${clips[0].endMs}`)
})

test('reversed start and end are repaired', () => {
  const clips = parseClipPlan(
    JSON.stringify({ clips: [clip({ start_seconds: 40, end_seconds: 20 })] }),
    base
  )
  assert.equal(clips.length, 1)
  assert.ok(clips[0].startMs < clips[0].endMs)
})

test('degenerate clips are dropped rather than rendered', () => {
  const clips = parseClipPlan(
    JSON.stringify({
      clips: [
        clip({ start_seconds: 10, end_seconds: 10 }),
        clip({ start_seconds: 10, end_seconds: 11 }),
        clip({ start_seconds: -50, end_seconds: -10 })
      ]
    }),
    base
  )
  assert.equal(clips.length, 0)
})

test('one malformed clip loses that clip, not the whole plan', () => {
  const clips = parseClipPlan(
    JSON.stringify({
      clips: [
        clip({ start_seconds: 5, end_seconds: 20 }),
        { platform: 'x', nonsense: true },
        clip({ platform: 'linkedin', start_seconds: 20, end_seconds: 40 })
      ]
    }),
    base
  )
  assert.equal(clips.length, 2, 'the two good clips must survive the one bad one')
})

test('a response where nothing is structurally a clip is a schema error', () => {
  assert.throws(
    () => parseClipPlan(JSON.stringify({ clips: [{ nope: 1 }, { also: 'no' }] }), base),
    (e) => e.code === 'LlmSchemaError'
  )
})

test('a clip longer than the platform ceiling is trimmed to it', () => {
  const clips = parseClipPlan(
    JSON.stringify({
      clips: [clip({ platform: 'youtube_short', start_seconds: 0, end_seconds: 60 })]
    }),
    { ...base, durationMs: 600000 }
  )
  assert.equal(clips.length, 1)
  assert.ok(clips[0].endMs - clips[0].startMs <= 60000, 'youtube_short caps at 60s')
})

test('platforms the user turned off are ignored', () => {
  const clips = parseClipPlan(
    JSON.stringify({ clips: [clip({ platform: 'linkedin' }), clip({ platform: 'x' })] }),
    { ...base, allowedPlatforms: ['x'] }
  )
  assert.equal(clips.length, 1)
  assert.equal(clips[0].platform, 'x')
})

test('descriptions are truncated to the platform character limit', () => {
  const clips = parseClipPlan(
    JSON.stringify({ clips: [clip({ description: 'x'.repeat(5000) })] }),
    base
  )
  assert.ok(clips[0].description.length <= 270, 'X caps at 270 chars')
})

test('near-duplicate clips on the same platform collapse to the best one', () => {
  const clips = parseClipPlan(
    JSON.stringify({
      clips: [
        clip({ start_seconds: 5, end_seconds: 20, score: 4, title: 'worse' }),
        clip({ start_seconds: 5.2, end_seconds: 19.8, score: 9, title: 'better' })
      ]
    }),
    base
  )
  assert.equal(clips.length, 1)
  assert.equal(clips[0].title, 'better')
})

test('the same window on different platforms is kept — that is the product', () => {
  const clips = parseClipPlan(
    JSON.stringify({
      clips: [
        clip({ platform: 'x', start_seconds: 5, end_seconds: 20 }),
        clip({ platform: 'linkedin', start_seconds: 5, end_seconds: 20 })
      ]
    }),
    base
  )
  assert.equal(clips.length, 2)
})

test('clips come back ranked best first and capped', () => {
  const clips = parseClipPlan(
    JSON.stringify({
      clips: [
        clip({ start_seconds: 5, end_seconds: 20, score: 3 }),
        clip({ platform: 'linkedin', start_seconds: 20, end_seconds: 40, score: 9 }),
        clip({ platform: 'youtube', start_seconds: 40, end_seconds: 60, score: 6 })
      ]
    }),
    { ...base, maxClips: 2 }
  )
  assert.equal(clips.length, 2)
  assert.equal(clips[0].score, 9)
  assert.ok(clips[0].score >= clips[1].score)
})

test('garbage from the model raises a named error carrying the raw text', () => {
  assert.throws(
    () => parseClipPlan('I cannot help with that request.', base),
    (e) => {
      assert.equal(e.code, 'LlmSchemaError')
      assert.match(e.detail, /I cannot help/)
      return true
    }
  )
  assert.throws(
    () => parseClipPlan('{"clips":"not an array"}', base),
    (e) => e.code === 'LlmSchemaError'
  )
})

test('an empty plan is an empty list, not a crash', () => {
  assert.deepEqual(parseClipPlan('{"clips":[]}', base), [])
})

test('boundaries snap to transcript edges only when close', () => {
  const close = snapToSegments(5300, 19600, segments)
  assert.equal(close.startMs, 5000, 'a 300ms miss snaps')
  assert.equal(close.endMs, 20000)

  const far = snapToSegments(9000, 33000, segments)
  assert.equal(far.startMs, 9000, 'a 4s miss must not drag the cut')
  assert.equal(far.endMs, 33000)
})

test('overlap fraction is measured against the shorter clip', () => {
  assert.equal(overlapFraction(0, 100, 0, 100), 1)
  assert.equal(overlapFraction(0, 100, 200, 300), 0)
  assert.equal(overlapFraction(0, 100, 50, 150), 0.5)
})

test('transcript formatting is timestamped and truncates from the middle', () => {
  const out = formatTranscript(segments)
  assert.match(out, /^\[0\.0-5\.0\] intro rambling$/m)

  const many = Array.from({ length: 5000 }, (_, i) => ({
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    text: `line number ${i}`
  }))
  const truncated = formatTranscript(many, 2000)
  assert.ok(truncated.includes('transcript truncated'))
  assert.ok(truncated.includes('line number 0'), 'keeps the opening')
  assert.ok(truncated.includes('line number 4999'), 'keeps the ending')
})

test('prompt templates substitute and leave unknown placeholders empty', () => {
  assert.equal(fillTemplate('a {{x}} c', { x: 'b' }), 'a b c')
  assert.equal(fillTemplate('a {{missing}} c', {}), 'a  c')
})

test('MIN_CLIP_MS is enforced after snapping, not before', () => {
  // Snapping can shrink a window; the length check has to happen afterwards.
  const clips = parseClipPlan(
    JSON.stringify({ clips: [clip({ start_seconds: 19.5, end_seconds: 20.4 })] }),
    base
  )
  assert.equal(clips.length, 0, `a ${MIN_CLIP_MS}ms floor should reject this`)
})
