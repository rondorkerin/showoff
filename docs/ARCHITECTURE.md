# Showoff — Architecture

Output of the autonomous engineering plan review (2026-08-20). Self-administered.

## Process model

```
┌──────────────────────── Electron Main (Node 22) ────────────────────────┐
│ db/         PGlite (Postgres/WASM) + pgvector, numbered SQL migrations   │
│ media/      ffmpeg-static / ffprobe-static: probe, remux, cut, caption,  │
│             PiP compose, silence detect, poster frames                   │
│ transcribe/ registry: whisper-cpp | transformers.js | openai | groq      │
│ llm/        registry: claude-cli | anthropic | openai | ollama | custom  │
│ pipeline/   ingest → transcribe → questions → plan → render → index      │
│ jobs/       single in-process queue, persisted to `jobs` table           │
│ ipc/        one typed channel per operation, zod-validated both ways     │
└─────────────────────────────────────────────────────────────────────────┘
                   ▲  contextBridge only (no nodeIntegration,
                   │   contextIsolation: true, sandbox where possible)
┌──────────────────────── Renderer (React 19 + Vite) ─────────────────────┐
│ Studio · Library · Recording detail · Notebook · Clips · Settings        │
│ MediaRecorder x3 (screen / mic / webcam) → chunks streamed over IPC      │
└─────────────────────────────────────────────────────────────────────────┘
```

Only the renderer may touch `getUserMedia`. Only main may touch the disk, the DB,
ffmpeg, or the network. That boundary is the whole security model.

## Recording data flow, with shadow paths

```
 source pick ──► getUserMedia ──► MediaRecorder(timeslice=2s)
                                        │
                    ondataavailable ────┼──► IPC recording:chunk ──► fs.appendFile
                                        │                              (per track)
                                     onstop ──► IPC recording:finalize
                                                     │
                                        ffprobe each track ──► remux webm→mp4
                                                     │
                                            INSERT recordings + tracks
                                                     │
                                                  job: transcribe

 SHADOW 1  no sources / permission denied → named error TRANSCRIBE-free path,
           renderer shows the OS permission remedy, no partial row is written.
 SHADOW 2  zero-length chunk stream (user stops in <1s) → finalize rejects with
           EmptyRecordingError, temp files removed, no orphan DB row.
 SHADOW 3  main crashes mid-record → chunks are already on disk; on next launch
           the orphan-scan finds `.part` files and offers recovery.
```

## Cut pipeline

```
recording ──► ffprobe (duration, w/h, fps)
          ──► ffmpeg -ar 16000 -ac 1 audio.wav
          ──► transcribe ──► segments[{start,end,text}] ──► transcripts + segments
          ──► LLM #1 clarifying questions  (2–5, skippable)
          ──► LLM #2 clip plan  ──► zod parse ──► clamp to duration
                                              ──► snap to segment boundaries
                                              ──► drop len<3s or start>=end
                                              ──► rank by hook score, cap N
          ──► per clip, per platform: ffmpeg cut → scale/crop → [captions]
                                     → [webcam PiP] → [silence trim] → mp4
          ──► poster frame  ──► clip_renders
          ──► embed transcript chunks + clip text ──► embeddings (pgvector)
```

Every LLM boundary is zod-validated. There is no `catch (e) {}` anywhere in the
pipeline: each stage records `jobs.error` with a named error class and the stage
that produced it, and the UI surfaces it.

## Named errors

| Error | Trigger | User sees | Recovery |
|---|---|---|---|
| `NoCaptureSourcesError` | desktopCapturer returns [] | "Screen recording permission needed" + OS settings deep link | Grant + retry |
| `EmptyRecordingError` | finalize with 0 bytes | "That recording was too short to save" | Discard |
| `FfmpegError` | non-zero exit | stderr tail, copyable | Retry / report |
| `TranscriptionUnavailableError` | no provider usable | "Pick a transcription provider" → Settings | Configure |
| `LlmUnavailableError` | no provider usable | "Pick an LLM" → Settings; recording still saved | Configure |
| `LlmSchemaError` | response fails zod | raw model output shown | Retry (temp 0) |
| `MediaTooShortError` | duration < 5s | "Too short to cut" | n/a |
| `DbMigrationError` | migration fails | blocking dialog, DB left untouched | Report |

## Schema (Postgres via PGlite)

`projects, recordings, tracks, transcripts, transcript_segments, notes, clips,
clip_renders, tags, recording_tags, embeddings(vector(768)), jobs, settings,
schema_migrations`

Indexes on `recordings(project_id, created_at desc)`, `transcript_segments(transcript_id, start_ms)`,
`clips(recording_id)`, `embeddings` HNSW on the vector column, plus a GIN index on
`to_tsvector` of transcript text for lexical search alongside semantic.

## Provider abstractions

```ts
interface LlmProvider  { id; label; available(): Promise<boolean>; complete(req): Promise<string> }
interface SttProvider  { id; label; available(): Promise<boolean>; transcribe(wav): Promise<Segment[]> }
```

Resolution order is "cheapest thing that already works on this machine":
`claude` CLI (uses existing Claude Code auth, no key) → ANTHROPIC_API_KEY →
OPENAI_API_KEY → Ollama at localhost:11434 → user-supplied OpenAI-compatible base URL.
STT: local `whisper-cli` if on PATH → bundled transformers.js Whisper → Groq → OpenAI.

## Observability

Structured JSONL log at `userData/logs/showoff.jsonl` (level, stage, recordingId,
durationMs, error). Every ffmpeg invocation logs its full argv. A Settings →
Diagnostics pane runs a live check of every provider and binary and prints the
result, so a bug report is one screenshot.

## Packaging

electron-builder → mac dmg+zip (arm64, x64), win nsis+portable (x64).
Publish target: GitHub Releases on tag. `electron-updater` checks on launch.
Unsigned for v1 (documented Gatekeeper/SmartScreen bypass in the README) — code
signing certs are a purchasing decision, not an engineering one.
