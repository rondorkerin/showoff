# Deferred

Decisions from the CEO plan review (`~/.gstack/projects/showoff/ceo-plans/2026-08-20-showoff.md`)
that were consciously not built for v1, and why.

## Deferred — worth building, wrong to build first

**Publishing APIs (X / LinkedIn / YouTube OAuth).** Each platform needs its own
OAuth app, review process, and token refresh. That is days of integration work
that only saves a paste. Download-the-bundle-and-paste ships today and works on
every platform including the ones without an API worth using.
*Unblocks when:* someone is posting daily and the paste is the bottleneck.

**Timeline scrubber with manual clip trimming.** Right now clip boundaries come
from the model, snapped to transcript segments, and you can re-render. A real
frame-accurate trim UI is a genuine sub-project (waveform rendering, keyboard
scrubbing, undo). Worth doing when the model's boundaries are the most common
complaint — not before.

**System audio capture.** macOS has no supported system-audio path without a
kernel extension or the ScreenCaptureKit audio API; on Windows it is
`loopback` via WASAPI. Two entirely separate implementations for a feature most
builder screencasts do not need — you are talking over your work, not playing
audio into it.

## Skipped — not the product

**Multi-camera and scene switching.** That is OBS. Showoff is aimed at the
person who wants one take and no production.

**Team sync / shared library.** Requires a backend, auth, and a billing story.
Showoff is local-first on purpose; the whole knowledgebase is a file on your
disk.

## Known rough edges

- Builds are unsigned, so both operating systems warn on first launch. Signing
  needs a paid developer account.
- Finalizing a recording re-encodes VP8 → H.264, which takes roughly as long as
  the recording itself on an M-series laptop. It runs in the background queue.
- Clarifying questions and clip planning need a working LLM provider. Without
  one, recording, transcription and the notebook still work.
