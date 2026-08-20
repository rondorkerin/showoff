# Deferred

Decisions from the CEO plan review (`~/.gstack/projects/showoff/ceo-plans/2026-08-20-showoff.md`)
that were consciously not built for v1, and why.

## Deferred — worth building, wrong to build first

**Publishing APIs (X / LinkedIn / YouTube OAuth).** Each platform needs its own
OAuth app, review process, and token refresh. That is days of integration work
that only saves a paste. Download-the-bundle-and-paste ships today and works on
every platform including the ones without an API worth using.
*Unblocks when:* someone is posting daily and the paste is the bottleneck.

**~~Timeline scrubber with manual clip trimming.~~** *Reversed 2026-08-20.* Not
having one turned out to be the complaint, and it arrived before the model's clip
boundaries ever did. Superseded by `docs/EDITOR-PLAN.md`: lanes with drag-to-place
and edge-trim. Still deferred inside that plan: splitting a clip, ripple delete,
and an undo stack — those are what make it an NLE, and lanes being free means you
never need them.

**~~System audio capture.~~** *Shipped 2026-08-20, natively on both platforms.*
Electron 43.4.1 documents `Streams.audio: 'loopback'` as "currently only
supported on Windows" (`electron.d.ts:23743`), so Windows was close to free.
macOS has no path through Chromium at all — but it does through
ScreenCaptureKit, which is how OBS 29 stopped requiring a virtual audio device.
`native/audiocap/AudioCap.swift` is a ~200-line helper that runs an `SCStream`
with `capturesAudio` and writes 48 kHz stereo f32 to stdout; the main process
pipes it to disk and ffmpeg turns it into a lane at finalize. It rides on the
screen-recording permission the app already asks for, so there is nothing to
install. BlackHole via `brew install blackhole-2ch` remains the fallback for
macOS 12 and for anyone who prefers to route audio themselves.

The code-signing question this deferred is still deferred — the helper is
unsigned along with the rest of the app, and inherits its TCC attribution from
the parent bundle. Notarization will need to cover it when that day comes.

## Skipped — not the product

**Multi-camera and live scene switching.** Switching *while recording* is OBS, and
Showoff is still not that. But `docs/EDITOR-PLAN.md` does allow several screen or
webcam lanes in one project, placed after the fact — you record the takes and
arrange them, rather than cutting live.

**Team sync / shared library.** Requires a backend, auth, and a billing story.
Showoff is local-first on purpose; the whole knowledgebase is a file on your
disk.

## Known rough edges

- Builds are unsigned, so both operating systems warn on first launch. Signing
  needs a paid developer account.
- Local transcription on macOS needs Homebrew. whisper.cpp publishes ready-to-run
  binaries for Windows and Linux, which Showoff downloads on first use, but the
  only macOS artifact upstream is an xcframework -- a library, not a CLI. So a
  Mac without Homebrew has to build whisper.cpp itself or use Groq or OpenAI.
  *Unblocks when:* upstream ships a macOS CLI build, or bundling one is worth
  the installer size.
- Finalizing a recording re-encodes VP8 → H.264, which takes roughly as long as
  the recording itself on an M-series laptop. It runs in the background queue.
- Clarifying questions and clip planning need a working LLM provider. Without
  one, recording, transcription and the notebook still work.
