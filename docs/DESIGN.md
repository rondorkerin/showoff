# Showoff — Design

Output of the autonomous design plan review (2026-08-20). Self-administered.

## Principle

The product is the 45 minutes it removes. Every screen answers one question:
**"what is the fastest path to a clip I would actually post?"** If an element does
not serve that, it is cut (Rams: as little design as possible).

## Information hierarchy

1. **Record** — one button, always reachable, keyboard shortcut. This is the daily habit.
2. **The clips** — ranked, best first, each with a copy-to-clipboard share text.
3. Everything else (notebook, library, projects, settings) is second-tier navigation.

Deliberately *not* first-tier: a timeline, a track list, an effects panel. Those are
the video-editor affordances the product exists to avoid.

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

**Recording detail.** Video player on the left; on the right, three tabs: Transcript
(clickable segments that seek the player), Notebook (markdown editor), Clips.

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

## Trust

The app records your screen and your voice. Trust is the whole relationship:
- Recording state is visible at all times and impossible to confuse.
- Settings states plainly, in prose, exactly what leaves the machine for each
  provider choice — and that the local defaults send nothing.
- Files live in your Videos folder, in plain mp4, named legibly. Nothing is locked
  in an app-private blob store. If the user uninstalls Showoff tomorrow, their
  footage is still theirs and still playable.
