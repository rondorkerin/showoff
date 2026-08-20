import {
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  shell,
  app,
  systemPreferences
} from 'electron'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as repo from '../db/repo.ts'
import * as pipeline from '../pipeline/index.ts'
import * as recording from '../recording.ts'
import { enqueue, queueDepth } from '../jobs/queue.ts'
import { llmStatuses } from '../llm/index.ts'
import { sttStatuses } from '../transcribe/index.ts'
import { getFfmpegPath, getFfprobePath } from '../media/ffmpeg.ts'
import { defaultSettings, getSettings, saveSettings, resolveKey } from '../settings.ts'
import { NoCaptureSourcesError, serializeError } from '../../shared/errors.ts'
import { PLATFORMS, type PlatformId } from '../../shared/platforms.ts'
import type { AppSettings, Diagnostics, TrackKind } from '../../shared/types.ts'
import { getDb } from '../db/index.ts'
import { log } from '../log.ts'
import { slugify } from '../pipeline/index.ts'

/**
 * Every handler is wrapped so the renderer receives a structured
 * {ok:false, error:{code,message,remedy,detail}} instead of an opaque
 * "Error invoking remote method". Silent failures are the thing we are most
 * trying to avoid.
 */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await fn(...(args as never[]))
      return { ok: true, data }
    } catch (e) {
      const err = serializeError(e)
      log.error('ipc', `${channel} failed`, { code: err.code, message: err.message })
      return { ok: false, error: err }
    }
  })
}

export function registerIpc(): void {
  /* ------------------------------------------------------------- capture */

  handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: false
    })
    if (sources.length === 0) throw NoCaptureSourcesError('desktopCapturer returned no sources')
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL()
    }))
  })

  /**
   * macOS gates screen capture behind TCC and gives no prompt of its own once
   * it has been denied — the source list simply comes back empty forever. Say
   * which permission is missing and open the exact settings pane.
   */
  handle('permissions:status', () => {
    if (process.platform !== 'darwin') {
      return { screen: 'granted', microphone: 'granted', camera: 'granted' }
    }
    return {
      screen: systemPreferences.getMediaAccessStatus('screen'),
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      camera: systemPreferences.getMediaAccessStatus('camera')
    }
  })

  handle('permissions:open', async (kind: 'screen' | 'microphone' | 'camera') => {
    if (process.platform !== 'darwin') return false
    const pane = {
      screen: 'Privacy_ScreenCapture',
      microphone: 'Privacy_Microphone',
      camera: 'Privacy_Camera'
    }[kind]
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
    return true
  })

  handle('permissions:ask', async (kind: 'microphone' | 'camera') => {
    if (process.platform !== 'darwin') return true
    return await systemPreferences.askForMediaAccess(kind)
  })

  handle('recording:start', (input: { title: string; projectId: string | null; kinds: TrackKind[] }) =>
    recording.startRecording(input)
  )

  // Chunks are sent with `send`, not `invoke`: they arrive continuously during a
  // recording and must not round-trip.
  ipcMain.on(
    'recording:chunk',
    (_e, payload: { recordingId: string; kind: TrackKind; chunk: ArrayBuffer }) => {
      try {
        recording.writeChunk(payload.recordingId, payload.kind, new Uint8Array(payload.chunk))
      } catch (e) {
        log.error('ipc', 'chunk write failed', { error: serializeError(e).message })
      }
    }
  )

  handle('recording:finalize', async (recordingId: string) => {
    const handleRef = await enqueue('finalize', recordingId, (onProgress) =>
      recording.finalizeRecording(recordingId, onProgress)
    )
    return handleRef
  })

  handle('recording:cancel', (recordingId: string) => recording.cancelRecording(recordingId))
  handle('voiceover:start', (recordingId: string) => recording.startVoiceover(recordingId))
  handle('voiceover:finalize', (recordingId: string) => recording.finalizeVoiceover(recordingId))
  handle('recording:orphans', () => recording.findOrphans())

  /* -------------------------------------------------------------- library */

  handle('projects:list', () => repo.listProjects())
  handle('projects:create', (p: { name: string; context: string }) =>
    repo.createProject(p.name, p.context)
  )
  handle('projects:update', (p: { id: string; name?: string; context?: string }) =>
    repo.updateProject(p.id, p)
  )
  handle('projects:delete', (id: string) => repo.deleteProject(id))

  handle('recordings:list', (projectId: string | null) => repo.listRecordings(projectId))
  handle('recordings:get', async (id: string) => {
    const rec = await repo.getRecording(id)
    if (!rec) return null
    const [tracks, transcript, clips, renders, note, tags, job] = await Promise.all([
      repo.listTracks(id),
      repo.getTranscript(id),
      repo.listClips(id),
      repo.listRenders(id),
      repo.getRecordingNote(id),
      repo.getRecordingTags(id),
      repo.latestJob(id)
    ])
    return { recording: rec, tracks, transcript, clips, renders, note, tags, job }
  })
  handle('recordings:update', (p: { id: string; title?: string; projectId?: string | null }) =>
    repo.updateRecording(p.id, p)
  )
  handle('recordings:delete', (id: string) => repo.deleteRecording(id))
  handle('recordings:tags', (p: { id: string; tags: string[] }) =>
    repo.setRecordingTags(p.id, p.tags)
  )
  handle('tags:list', () => repo.listAllTags())
  handle('stats', () => repo.recordingStats())

  /* ------------------------------------------------------------- pipeline */

  handle('pipeline:transcribe', (recordingId: string) =>
    enqueue('transcribe', recordingId, (onProgress) =>
      pipeline.runTranscription(recordingId, onProgress)
    )
  )

  handle('pipeline:questions', (recordingId: string) =>
    pipeline.askClarifyingQuestions(recordingId)
  )

  handle(
    'pipeline:cut',
    (opts: {
      recordingId: string
      answers: Array<{ question: string; answer: string }>
      platforms?: PlatformId[]
      maxClips?: number
    }) => enqueue('cut', opts.recordingId, (onProgress) => pipeline.runCut(opts, onProgress))
  )

  handle('pipeline:notes', (recordingId: string) =>
    enqueue('notes', recordingId, () => pipeline.generateNotes(recordingId))
  )

  handle('pipeline:reindex', (recordingId: string) => pipeline.indexRecording(recordingId))
  handle('search', (q: string) => pipeline.search(q))
  handle('jobs:depth', () => queueDepth())

  /* ---------------------------------------------------------------- clips */

  handle('clips:update', (p: { id: string; title?: string; description?: string; hashtags?: string[] }) =>
    repo.updateClip(p.id, p)
  )
  handle('clips:delete', (id: string) => repo.deleteClip(id))
  handle('clips:rerender', (clipId: string) =>
    enqueue('rerender', null, (onProgress) => pipeline.reRenderClip(clipId, onProgress))
  )

  handle('notes:save', (p: { recordingId: string; title: string; body: string }) =>
    repo.upsertRecordingNote(p.recordingId, p.title, p.body)
  )

  /* --------------------------------------------------------------- export */

  handle('clips:shareText', async (clipId: string) => {
    const clip = await repo.getClip(clipId)
    if (!clip) return ''
    return buildShareText(clip.description, clip.hashtags as unknown as string[])
  })

  // `parentDir` is optional: without it the user picks a folder. With it the
  // caller has already chosen, which is what makes this path testable.
  handle('export:bundle', async (recordingId: string, parentDir?: string) => {
    const rec = await repo.getRecording(recordingId)
    if (!rec) throw new Error('Recording not found')
    const clips = await repo.listClips(recordingId)

    let parent = parentDir
    if (!parent) {
      const picked = await dialog.showOpenDialog({
        title: 'Where should the bundle go?',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: app.getPath('downloads')
      })
      if (picked.canceled || picked.filePaths.length === 0) return { cancelled: true, dir: '' }
      parent = picked.filePaths[0]
    }

    const outDir = join(parent, `showoff-${slugify(rec.title) || 'recording'}`)
    mkdirSync(outDir, { recursive: true })

    let written = 0
    for (const clip of clips) {
      const render = await repo.getRender(clip.id)
      if (!render || !existsSync(render.path)) continue
      const stem = `${String(clip.rank + 1).padStart(2, '0')}-${clip.platform}-${slugify(clip.title) || 'clip'}`
      copyFileSync(render.path, join(outDir, `${stem}.mp4`))
      if (render.poster_path && existsSync(render.poster_path)) {
        copyFileSync(render.poster_path, join(outDir, `${stem}.jpg`))
      }
      writeFileSync(
        join(outDir, `${stem}.txt`),
        buildShareText(clip.description, clip.hashtags as unknown as string[]),
        'utf8'
      )
      written++
    }

    const note = await repo.getRecordingNote(recordingId)
    if (note) {
      writeFileSync(join(outDir, 'notes.md'), `# ${note.title}\n\n${note.body}\n`, 'utf8')
    }
    const transcript = await repo.getTranscript(recordingId)
    if (transcript) {
      writeFileSync(join(outDir, 'transcript.txt'), transcript.text, 'utf8')
    }

    log.info('export', 'bundle written', { outDir, clips: written })
    return { cancelled: false, dir: outDir, clips: written }
  })

  handle('shell:showItem', (path: string) => {
    if (existsSync(path)) shell.showItemInFolder(path)
    return existsSync(path)
  })
  handle('shell:openPath', async (path: string) => {
    if (!existsSync(path)) return false
    await shell.openPath(path)
    return true
  })
  handle('shell:openExternal', async (url: string) => {
    if (!/^https?:\/\//.test(url)) return false
    await shell.openExternal(url)
    return true
  })

  /* ------------------------------------------------------------- settings */

  handle('settings:get', () => getSettings())
  handle('settings:save', (patch: Partial<AppSettings>) => saveSettings(patch))
  handle('settings:defaults', () => defaultSettings())
  handle('settings:pickStorageDir', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Where should Showoff keep recordings?',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getSettings().storageDir
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return saveSettings({ storageDir: picked.filePaths[0] })
  })

  handle('platforms', () => PLATFORMS)

  handle('diagnostics', async (): Promise<Diagnostics> => {
    const s = getSettings()
    const [llm, stt] = await Promise.all([
      llmStatuses({
        anthropicApiKey: resolveKey('anthropic'),
        openaiApiKey: resolveKey('openai'),
        ollamaBaseUrl: s.ollamaBaseUrl,
        ollamaModel: s.ollamaModel,
        customBaseUrl: s.customBaseUrl,
        customApiKey: s.customApiKey,
        customModel: s.customModel,
        model: s.llmModel
      }),
      sttStatuses({
        whisperBin: s.whisperBin,
        whisperModel: s.whisperModel,
        modelDir: join(app.getPath('userData'), 'models'),
        openaiApiKey: resolveKey('openai'),
        groqApiKey: resolveKey('groq')
      })
    ])

    const ffmpeg = getFfmpegPath()
    const ffprobe = getFfprobePath()

    let db = { id: 'pglite', label: 'Postgres (embedded)', available: false, detail: '' }
    try {
      const instance = await getDb()
      const v = await instance.query<{ v: string }>('SELECT version() AS v')
      db = {
        id: 'pglite',
        label: 'Postgres (embedded)',
        available: true,
        detail: (v.rows[0]?.v ?? '').split(' on ')[0]
      }
    } catch (e) {
      db.detail = serializeError(e).message
    }

    return {
      llm,
      stt,
      binaries: [
        {
          id: 'ffmpeg',
          label: 'ffmpeg',
          available: existsSync(ffmpeg) || ffmpeg === 'ffmpeg',
          detail: ffmpeg
        },
        {
          id: 'ffprobe',
          label: 'ffprobe',
          available: existsSync(ffprobe) || ffprobe === 'ffprobe',
          detail: ffprobe
        },
        { id: 'logs', label: 'Log file', available: true, detail: log.path() }
      ],
      db,
      storageDir: s.storageDir
    }
  })

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    logPath: log.path(),
    userData: app.getPath('userData')
  }))

  handle('window:minimizeToHud', (on: boolean) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) return false
    w.setAlwaysOnTop(on)
    return true
  })
}

/** The exact text a user copies and pastes into the platform. */
export function buildShareText(description: string, hashtags: string[]): string {
  const tags = (hashtags ?? []).map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
  return tags ? `${description}\n\n${tags}` : description
}

export { basename }
