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

**~~System audio capture.~~** *Reversed 2026-08-20, with the platform split
intact.* Verified against Electron 43.4.1: `Streams.audio: 'loopback'` is
documented as "currently only supported on Windows" (`electron.d.ts:23743`), so
Windows is close to free. macOS still has no supported path in Electron itself,
and rather than bundle a ScreenCaptureKit native addon — which would force the
code-signing and notarization question this project has been deferring — the
computer-audio lane on macOS offers a one-click `brew install blackhole-2ch`,
reusing the installer plumbing already built for whisper.cpp. See T7 in
`docs/EDITOR-PLAN.md`.

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
