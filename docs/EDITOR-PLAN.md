# Showoff — the editor

Plan produced by a self-administered design review on 2026-08-20, read against
the shipped v0.1.3 source. Mockup: `~/.gstack/projects/showoff/designs/` and the
published artifact linked from the session.

The product shape changes here. v1 was **record → transcribe → let a model cut
clips**. v2 is **record → stack → export**, with transcription, clips, notes and
posts demoted to optional buttons that never gate getting your file.

---

## What already exists (reuse, do not rebuild)

- **`docs/DESIGN.md`** — ground `#0B0C0E`, panels `#0F1115`, hairlines `#1D2026`
  / `#262A31`, one amber accent `#F5A524` reserved for record + primary + selection,
  Inter for UI, JetBrains Mono for numerics, 8px grid, 10px radius. Every new
  control below is drawn from this vocabulary. One principle in it is reversed —
  see the bottom of this file.
- **`src/renderer/src/components/ui.tsx`** — Button, Card, Field, Input, Select,
  Modal, Badge, Empty, Spinner. The lane row, fader and corner picker are new
  primitives; everything else already exists.
- **Webcam compositing** — `render.ts:243-250` already overlays the webcam via
  ffmpeg at a hardcoded 24% / bottom-right / 3% margin. Draggable positioning is
  parameters, not architecture.
- **Blurred-backdrop aspect fitting** — `render.ts:224-238`. Reused verbatim for
  the editor's aspect chooser.
- **Homebrew installer plumbing** — `transcribe/install.ts` already downloads,
  unpacks and shells out to `brew` with progress reporting. The macOS
  computer-audio device install reuses it.
- **Job queue + progress** — `jobs/queue.ts` and the `activeJob` banner. Export
  is another job; nothing new needed.
- **Orphan recovery** — already surfaces unfinalized `.part` files. Unchanged.

---

## The model

A recording becomes a **project with lanes**. One lane holds exactly one clip.
Lanes are free, so two clips never need to share one — and that single constraint
is what keeps this an editor rather than an NLE: no splitting, no ripple delete,
no selection model, no undo stack to design.

```
project
  ├── lane  screen     screen1.mp4   at 0:00  trim 0:00–0:56   z=0
  ├── lane  screen     screen2.mp4   at 1:16  trim 0:04–0:40   z=1
  ├── lane  webcam     webcam.mp4    at 0:00  trim 0:00–0:32   z=2  x=96% y=96% size=24%
  ├── lane  mic        mic.m4a       at 0:00  gain 70%
  ├── lane  system     system.m4a    at 0:24  gain 40%
  └── lane  voiceover  vo-1.m4a      at 1:28  gain 100%  ducks=[mic]
```

Every control writes to a lane row. **Nothing re-encodes until export.**

---

## Findings that drove this plan

| # | Severity | Finding | Evidence |
|---|----------|---------|----------|
| 1 | Critical | The voice-over never reaches the video. `renderClip` maps `-map 0:a?` — master audio only. The voice-over is used purely as the transcription source. | `media/render.ts:280`, `pipeline/index.ts:73` |
| 2 | Critical | You cannot download your recording. Export bundle is disabled until clips exist and contains only rendered clips. The only escape is Finder. | `RecordingDetail.tsx:240`, `ipc/index.ts:232` |
| 3 | Critical | One track per kind, enforced in SQL. `getTrack` is `... AND kind=$2 LIMIT 1`; `TrackKind` is a 4-value union. A second screen share is a different data model, not an extra row. | `db/repo.ts:133`, `shared/types.ts:3` |
| 4 | High | Every road runs through transcription. Cut and Generate notes are both disabled without a transcript, which needs Homebrew on macOS or a cloud key. | `RecordingDetail.tsx:210-232` |
| 5 | High | The master is baked at finalize into `master.mp4` and registered as the `screen` track, so per-lane volume is unrecoverable. `screen.mp4` and `mic.m4a` are written but never registered; the mic row points at the raw `.webm`. | `recording.ts:158-192` |
| 6 | Good news | Webcam position is already an ffmpeg overlay, just hardcoded. | `media/render.ts:243-250` |
| 7 | Reversal | `docs/DESIGN.md` explicitly forbids a timeline and a track list. That call is now wrong and is rewritten below rather than quietly ignored. | `docs/DESIGN.md` |

---

## Pass 1 — Information architecture (3/10 → 9/10)

Today `RecordingDetail` lands on the **clips** tab, which for a fresh recording is
an empty state telling you to transcribe. The first thing you see after recording
is a wall telling you to do more work.

```
Studio ──record──▶ Editor ──────────────▶ Library
                     │
                     ├── Canvas + lanes      ◀── default, always
                     ├── Transcript          ◀── tab, optional
                     ├── Clips               ◀── tab, optional
                     └── Notes               ◀── tab, optional

  ┌─ Editor ─────────────────────────────────────────┐
  │ [16:9] [9:16] [1:1] [4:5]        │  LANE          │  ← 2. what you can change
  │ ┌─────────────────────┐          │  Webcam        │
  │ │      canvas    ┌──┐ │          │  size  ━━●──   │  ← 1. your footage, playing
  │ └────────────────┴──┴─┘          │  pos   ⊙       │
  │ ▶ 0:47 / 3:20      [+ Add]       │                │
  ├──────────────────────────────────┴────────────────┤
  │ ▣ webcam   ┃████┃                                 │  ← 3. what is in it, when
  │ ▣ screen2        ┃██████┃                         │
  │ ▣ screen1  ┃█████████┃                            │
  │ ♪ mic      ┃▁▃▅▇▅▃▁▃▅┃  ─◀))  70%                 │
  │ ♪ system     ┃▁▁▃▅▃▁┃  ─◀))  40%                  │
  │ ♪ v/o            ┃▅▇▅▃▅┃ ─◀))  100%               │
  ├───────────────────────────────────────────────────┤
  │ [Export mp4] · Chop · Transcribe · Post           │  ← 4. one primary, three optional
  └───────────────────────────────────────────────────┘
```

**Constraint worship — if only three things:** the canvas, the lane list, Export mp4.
Everything else earns its place after those.

---

## Pass 2 — Interaction states (2/10 → 9/10)

The current plan specifies almost no states; `activeJob` renders one amber banner
for everything. Each row below describes **what the user sees**, not backend state.

| Surface | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| **Editor canvas** | Poster frame + "Preparing preview…" with the proxy's progress | Never empty — a project always has ≥1 lane | "This lane's file is missing. It was at `<path>`." + Remove lane | Frame renders, playhead moves | Proxy still encoding → canvas plays the raw source, marked "preview quality" |
| **Lane list** | Skeleton rows at real lane count, no spinner | 1 lane = still a list, not a special case | Lane bar turns red-outlined with the reason inline | Bars drawn at offsets | A lane still finalizing shows a striped bar + "writing…" |
| **Webcam lane** | — | No webcam recorded → lane absent, `+ Add source` offers it | Camera file unreadable → lane greyed, hover explains | Draggable overlay with amber outline | Trimmed shorter than screen → bar visibly shorter; canvas shows screen only outside it |
| **Mic / voice-over lane** | Waveform greys in as ffmpeg reads peaks | Silent take → flat line + "no speech detected in this lane" | — | Waveform + fader | Voice-over covering part of the take → mic ducks only under it, visible as a dip |
| **Computer audio lane** | — | macOS 12 or no helper → lane present, greyed, primary "Install audio device" | screen recording denied → "Allow it under Privacy & Security"; brew install failed → the actual brew stderr | Waveform + fader | macOS 13+ and Windows: works immediately, no state |
| **Export** | Per-stage name + real percentage ("Composing 6 lanes · 41%") — never an indeterminate spinner | — | ffmpeg stderr tail + "Show files" so nothing is lost | Save dialog opens at the finished file; toast with Reveal | Cancel mid-export leaves the partial file and says so |
| **Add source** | Countdown, then the recording HUD | — | Permission denied → the existing per-permission copy | New lane appears at the playhead, selected | Recording longer than the project extends the timeline, does not truncate |
| **Transcribe / Chop / Post** | Existing job banner | Existing empty states | Existing errors | Existing | Unchanged — these already work |

**Empty states are features.** A one-lane project is not an error state and gets no
special copy; a silent mic lane says *why* it looks flat.

---

## Pass 3 — User journey (4/10 → 9/10)

| Step | User does | Feels | What the plan specifies |
|---|---|---|---|
| 1 | Hits Record | Slight dread — is it capturing the right thing? | Live preview before countdown; the camera-instead-of-screen guard already added in v0.1.3 |
| 2 | Talks over their screen | Focused, forgets the app | Recording HUD stays minimal; amber is unmistakable |
| 3 | Hits Stop | **Relief, then the fear of editing** | Lands directly in the editor with the footage already playing. No wall, no "transcribe first" |
| 4 | Sees the webcam in a bad spot | Mild annoyance | Drag it. One gesture, no dialog |
| 5 | Fluffed a sentence | Frustration — the classic re-record trigger | `+ Add source → Voice-over`, narrate over that section, it lands as a lane at the playhead and ducks the mic |
| 6 | Wants the file | Impatience | **Export mp4** is the primary button, always enabled |
| 7 | Wants it posted | Optional ambition | Chop / Post are there, greyed with a reason if no key is configured, never blocking step 6 |

**Time horizons.** *5 seconds:* the footage is already playing and it is obviously
theirs. *5 minutes:* they moved the webcam, ducked the mic, exported — and never
opened a manual. *5 years:* their footage is plain mp4 in `~/Movies/Showoff`, and
the lane rows are a small table they could read with any SQLite-ish tool. Nothing
is locked in.

---

## Pass 4 — AI slop risk (7/10 → 9/10)

Classifier: **APP UI**. Landing-page rules do not apply.

Hard rejections — none triggered. No card mosaic (the lane list is rows in a
single container, not cards), no gradients as decoration, no ornamental icons, no
centered everything, no emoji.

Litmus checks: product unmistakable in the first screen ✓ · one visual anchor,
the canvas ✓ · scannable by labels alone ✓ · one job per region ✓ · cards genuinely
avoided ✓ · motion limited to the playhead and drag feedback ✓ · premium with all
shadows removed ✓ (there is exactly one, on the window frame).

Two deliberate deviations, recorded rather than hidden:

- **Inter is on the "default font stack" blacklist.** `docs/DESIGN.md` already
  specifies it, and the project's existing system outranks the generic rule. Not
  changing a shipped app's typeface for a lint.
- **The findings list uses a coloured left stripe**, which the blacklist flags. Here
  it encodes severity (critical / high / note) rather than decorating, which is the
  legitimate use. Kept.

Specificity check on the new controls — no "clean modern panel" hand-waving:
the fader is a 3px `#2A2F37` rail with an 11px amber thumb; the lane bar is
`rgba(76,141,255,.22)` for video and `rgba(63,185,138,.18)` for audio so kind is
readable without reading; the selected lane gets a 1.5px inset amber outline, not
a fill, so the waveform stays legible.

---

## Pass 5 — Design system alignment (5/10 → 9/10)

New primitives, all drawn from the existing vocabulary:

| Component | Tokens | Notes |
|---|---|---|
| Lane row | `#0E1116` track on `--ground`, `#1D2026` hairline, 5px radius | Radius drops from 10 to 5 for the 26px-tall bar; 10px on a 26px element reads as a pill |
| Clip bar | video `--video #4C8DFF` @ 22%, audio `--audio #3FB98A` @ 18% | **Two new hues.** They are semantic (kind), not a second accent — amber stays the only accent and marks selection |
| Fader | 3px rail `#2A2F37`, 11px amber thumb | Same treatment as the existing mic meter's amber |
| Corner picker | 3×3 of 16×12px cells, amber when pressed | New; no existing equivalent |
| Aspect chooser | Mono 10.5px, amber when pressed | Reuses the badge treatment from ClipCard |
| Draggable overlay | 2px amber outline + 6px corner handles | Amber = selection, consistent with the lane outline |

The only real system change is admitting two semantic hues. `docs/DESIGN.md` says
"one accent"; that stays true — amber is still the only accent, and blue/green are
type indicators, the way `Badge tone="good"` already is.

---

## Pass 6 — Responsive & accessibility (1/10 → 8/10)

This is a desktop app, so "responsive" means window resize, not phones.

- **Minimum window 1000×640.** Below 1120px the inspector collapses into a
  bottom sheet under the canvas; below 1000px the window simply does not go.
- **Canvas is height-driven**, letterboxed inside its holder, so 9:16 does not
  blow up the layout when the aspect changes.
- **Lane list scrolls vertically past 8 lanes**, head column stays pinned.

Accessibility, none of which exists today:

- **Keyboard**: `Space` play/pause · `←/→` nudge the selected lane by 1 frame,
  `⇧←/→` by 1s · `[` / `]` set in/out at the playhead · `M` mute the selected lane
  · `V` toggle visibility · `⌘E` export · `Tab` walks lane heads then bars.
- Every lane bar is a real focusable `role="button"` with an `aria-label` naming
  the lane; every fader is an `<input type=range>` with a visible label, never a
  bare div.
- **Focus is visible** — 2px amber ring at 2px offset, on every interactive
  element. The app currently has no focus styling at all.
- Toggles are `<button aria-pressed>`, not styled checkboxes.
- Hit targets ≥ 24px in the lane list, ≥ 32px for canvas handles. (44px is a touch
  figure; this is a pointer-only desktop surface, so 24px is the honest bar.)
- Contrast: body `#C8CCD2` on `#0B0C0E` is 12.4:1. Secondary `#6B727D` on
  `#0F1115` is 4.6:1 — above 4.5, and used only for hints, never body copy.
- Colour is never the only signal: audio and video lanes differ by icon and by
  waveform-vs-thumbnails, not just hue.
- `prefers-reduced-motion` stops the playhead animation and drag easing.

---

## Decisions locked in this review

| Question | Call | Consequence |
|---|---|---|
| Editor shape | Canvas + lane list | Not a split-pane bolt-on; replaces the left half of the detail view |
| Time model | One clip per lane | Lanes carry offset + in/out. No splitting, ripple delete, or undo stack |
| Voice-over vs mic | **Duck the mic** | `sidechaincompress` drops the mic to ~20% under voice-over speech; faders override. Handles the partial-voice-over case, which "replace" does not |
| Aspect ratio | **Chooser in the editor** | Webcam x/y is stored **per aspect**, so 9:16 keeps its own framing. This roughly doubles the position fields on a video lane |
| Computer audio | **Native on both** | Electron 43 `loopback` is Windows-only (`electron.d.ts:23743`). macOS 13+ goes through the ScreenCaptureKit helper in `native/audiocap`, the same API OBS 29 moved to; BlackHole stays as the macOS 12 fallback |

---

## NOT in scope

- **Two clips on one lane, splitting, ripple delete.** Lanes are free; adding one is
  cheaper than teaching a selection model. The moment you can split you need undo,
  snapping and multi-select — the whole NLE arrives in one piece.
- **Transitions, filters, colour grading, keyframes.** None of them change what you
  would publish.
- **Text and title overlays.** Genuinely tempting, genuinely deferred: needs a font
  picker, on-canvas text editing and per-lane timing UI. Revisit once lanes are
  real — it is just another lane kind.
- **Realtime preview of the composed mix.** The canvas previews the top video lane
  plus overlays; the exact ducked mix is only correct at export. A true WebAudio
  preview graph is its own build.
- **Publishing APIs.** Unchanged from `TODOS.md` — still not worth the OAuth.

---

## Implementation Tasks

Synthesized from the findings above. Each derives from a specific finding.
P1 blocks ship; P2 lands the same branch; P3 is a follow-up.

- [x] **T1 (P1, human: ~1d / CC: ~45min)** — db — Replace `tracks` with `lanes`
  - Surfaced by: Finding 3 — `getTrack(recordingId, kind) … LIMIT 1` forbids a second screen share
  - Files: `src/main/db/migrations.ts`, `src/main/db/repo.ts`, `src/shared/types.ts`
  - Verify: migrate the existing 4-recording library; every recording still opens and plays

- [x] **T2 (P1, human: ~4h / CC: ~20min)** — recording — Stop baking the master
  - Surfaced by: Finding 5 — mic is muxed into `master.mp4`, so per-lane gain is unrecoverable
  - Files: `src/main/recording.ts`
  - Verify: record with mic on; confirm `screen.mp4` + `mic.m4a` both register as lanes and the master is marked proxy-only

- [x] **T3 (P1, human: ~2d / CC: ~1.5h)** — render — Compose from lanes
  - Surfaced by: Findings 1, 5 — the voice-over never reaches the output
  - Files: `src/main/media/render.ts`
  - Verify: export a project with mic + voice-over; listen — the voice-over is audible and the mic ducks under it

- [x] **T4 (P1, human: ~3h / CC: ~20min)** — ipc — Export mp4 to a save dialog
  - Surfaced by: Finding 2 — there is no way to get your video out
  - Files: `src/main/ipc/index.ts`, `src/preload/index.ts`
  - Verify: record, export, open the file in QuickTime

- [x] **T5 (P1, human: ~3d / CC: ~2h)** — renderer — The editor screen
  - Surfaced by: Passes 1, 2, 6 — no IA, no states, no keyboard
  - Files: `src/renderer/src/views/Editor.tsx`, `src/renderer/src/components/Lane.tsx`
  - Verify: drag the webcam, trim a lane, mute a lane, export — all by hand in the packaged app

- [x] **T6 (P2, human: ~1d / CC: ~40min)** — recording — Add a source to an existing project
  - Surfaced by: the lane model — "keep adding more screenshares"
  - Files: `src/main/recording.ts`, `src/renderer/src/views/Studio.tsx`
  - Verify: record a second screen share into an existing project; it lands as a lane at the playhead

- [x] **T7 (P2, human: ~1d / CC: ~40min)** — capture — Computer audio
  - Surfaced by: the source list; verified Windows-only in `electron.d.ts:23743`
  - Files: `src/renderer/src/lib/recorder.ts`, `src/main/index.ts`, `src/main/transcribe/install.ts`
  - Verify: on Windows, play music and record — it is in the export. On macOS, click Install audio device and confirm the lane goes live

- [x] **T8 (P2, human: ~2h / CC: ~10min)** — renderer — Demote transcribe / chop / notes
  - Surfaced by: Finding 4 — optional work sits on the critical path
  - Files: `src/renderer/src/views/RecordingDetail.tsx`
  - Verify: with no API key and no whisper installed, record → export succeeds end to end

- [ ] **T9 (P3, human: ~3h / CC: ~15min)** — docs — Rewrite the reversed principle
  - Surfaced by: Finding 7
  - Files: `docs/DESIGN.md`, `TODOS.md`, `README.md`
  - Verify: DESIGN.md no longer forbids what the app does

---

## The principle, rewritten

> **Was:** "Deliberately not first-tier: a timeline, a track list, an effects panel.
> Those are the video-editor affordances the product exists to avoid."

> **Now:** Showoff is a recorder with exactly as much editor as one person needs to
> make one session postable: which sources are in it, where they sit in time and on
> screen, and how loud each voice is. Lanes, not tracks — one clip per lane, no
> splitting, no ripple delete, no keyframes. The test for any new control is whether
> it changes what you would publish, not whether a video editor is expected to have
> it. Everything downstream of the export — transcript, clips, subtitles, posts — is
> a button, never a gate.

---

## GSTACK REVIEW REPORT

| Review | Runs | Status | Findings |
|---|---|---|---|
| Design (plan-design-review, FULL) | 1 | ISSUES_FOUND → addressed in plan | 7 (3 critical, 2 high, 2 note) |
| Outside voice | 0 | Not run — Codex account out of credits (standing user directive 2026-08-02) | — |

Pass scores: IA 3→9 · States 2→9 · Journey 4→9 · AI slop 7→9 · Design system 5→9 ·
Responsive/a11y 1→8 · Decisions 5 resolved, 0 deferred.
Overall design score: **3/10 → 9/10**.

Mockup: interactive lane-model editor, published as a Claude artifact and approved
in-session. Self-administered review — no second model consulted, by user directive.

VERDICT: CLEARED — plan is design-complete. Run /design-review after implementation
for visual QA.

NO UNRESOLVED DECISIONS
