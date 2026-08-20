# Showoff — Design

Output of the autonomous design plan review (2026-08-20). Self-administered.

## Principle

The product is the 45 minutes it removes. Every screen answers one question:
**"what is the fastest path to a clip I would actually post?"** If an element does
not serve that, it is cut (Rams: as little design as possible).

## Information hierarchy

1. **Record** — one button, always reachable, keyboard shortcut. This is the daily habit.
2. **The editor** — your footage playing, the lanes it is made of, and Export.
3. Everything else (clips, notebook, library, projects, settings) is second-tier.

Revised 2026-08-20. The earlier version of this file said: *"Deliberately not
first-tier: a timeline, a track list, an effects panel. Those are the video-editor
affordances the product exists to avoid."* That was wrong. Recording a session you
cannot mix, reframe or export is not a simpler product, it is an unfinished one.

The line now sits here instead: Showoff is a recorder with exactly as much editor as
one person needs to make one session postable — which sources are in it, where they
sit in time and on screen, and how loud each voice is. **Lanes, not tracks**: one clip
per lane, no splitting, no ripple delete, no keyframes. The test for any new control
is whether it changes what you would publish, not whether a video editor is expected
to have it. Everything downstream of the export — transcript, clips, subtitles,
posts — is a button, never a gate. See `docs/EDITOR-PLAN.md`.

## Aesthetic

Dark by default (you are recording a screen; a bright app blows out your own footage
and your own eyes at 11pm). Near-black `#0B0C0E` ground, one accent — a warm amber
`#F5A524` used only for the record state and primary actions, so "recording" is never
ambiguous. Inter for UI, JetBrains Mono for timecodes and transcript. 8px spacing
grid. Radius 10px. No gradients-as-decoration, no glass, no drop shadows below 8px
blur — the AI-slop tells.

## Screens

**Studio.** Source picker as a grid of live thumbnails (screen, window, webcam),
mic level meter that actually moves, a 3-2-1 countdown, then a minimal recording HUD
with elapsed time and a stop button. Recording state is unmistakable: amber border on
the window chrome, amber dot in the title.

Track toggles never lie about what they will do. Computer audio is a plain switch
wherever it works without setup — Windows loopback, or ScreenCaptureKit on macOS 13+
— and only becomes a disabled row with an install affordance where a virtual audio
device is genuinely required. A toggle that flips on and then silently records
nothing is worse than one that says it cannot.

**Editor.** The default screen for any recording. A preview canvas with an aspect
chooser above it (16:9 / 9:16 / 1:1 / 4:5) and the webcam as a draggable overlay
inside it; a lane inspector on the right showing whichever lane is selected; and
below, one row per lane — drag a bar to place it in time, drag its edges to trim.
Video lanes carry position, size and z-order; audio lanes carry gain, mute and
ducking. `Export mp4` is the primary action and is never disabled. Transcript,
Clips and Notes are tabs beside it, and each is optional.

Two semantic hues join the palette here, and they are not a second accent: video
lanes read `#4C8DFF` at 22%, audio lanes `#3FB98A` at 18%, so a lane's kind is
legible without reading its label. Amber remains the only accent and marks
selection — a 1.5px inset outline on the selected lane, never a fill, so the
waveform underneath stays readable.

**Clips.** Cards, ranked. Each card: poster frame, duration, platform badge, hook
line, the editable description in a textarea, and one primary button — Copy share
text. Secondary: Open file, Re-render, Delete. The whole point is that a good clip is
two clicks from posted.

**Library.** One search box that does lexical + semantic at once. Filter chips for
project and tag. Grid of recordings with poster frames.

## Edge cases treated as features, not afterthoughts

- **Empty library** — not a shrug. Shows the one-line pitch and a big Record button.
- **No LLM configured** — banner explaining the app still records and transcribes,
  with a one-click "Use the Claude CLI I already have" if detected.
- **Long titles / 47-char project names** — truncate with ellipsis + title attribute, never reflow the card grid.
- **Zero clips returned** — explains why (too short? no speech detected?) and offers to re-run with different answers.
- **Slow pipeline** — per-stage progress with the actual stage name ("Transcribing 4:31 of audio…"), never an indeterminate spinner.
- **Navigate away mid-render** — jobs live in main and persist to the `jobs` table; leaving the screen never cancels work.
- **Double-click Record** — button disables on first press; the recorder is a state machine, not a toggle.
- **First run** — no modal wall. The app opens on Studio, ready to record. Configuration is discovered when needed, not demanded up front.

## Keyboard and focus

The app is pointer-first but never pointer-only. `Space` plays and pauses. `←/→`
nudge the selected lane a frame, `⇧` with them a second. `[` and `]` set in and out
at the playhead. `M` mutes the selected lane, `V` hides it, `⌘E` exports. Every lane
bar is a focusable control with a label naming its lane; every fader is a real range
input with a visible label. Focus is always visible — a 2px amber ring at 2px offset.
Colour is never the only signal: lane kind is carried by icon and by
waveform-vs-thumbnails as well as hue.

## Trust

The app records your screen and your voice. Trust is the whole relationship:
- Recording state is visible at all times and impossible to confuse.
- Settings states plainly, in prose, exactly what leaves the machine for each
  provider choice — and that the local defaults send nothing.
- Files live in your Videos folder, in plain mp4, named legibly. Nothing is locked
  in an app-private blob store. If the user uninstalls Showoff tomorrow, their
  footage is still theirs and still playable.
