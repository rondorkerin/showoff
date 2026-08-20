import React, { useCallback, useEffect, useState } from 'react'
import { api, must, soft } from '../lib/api.ts'
import { cls, fmtAgo, fmtBytes, fmtClock, fmtDuration } from '../lib/format.ts'
import { Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, Textarea } from '../components/ui.tsx'
import { useToast } from '../components/Toasts.tsx'
import type { Shell } from '../App.tsx'
import type { SearchHit } from '../../../preload/index.ts'
import type { Interrupted, Recording } from '../../../shared/types.ts'

export default function Library({ shell }: { shell: Shell }): React.ReactElement {
  const toast = useToast()
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [stats, setStats] = useState({ recordings: 0, clips: 0, minutes: 0 })
  const [newProject, setNewProject] = useState(false)
  const [pName, setPName] = useState('')
  const [pContext, setPContext] = useState('')
  const [interrupted, setInterrupted] = useState<Interrupted[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setRecordings(await soft(api.recordings.list(projectId), []))
    setStats(await soft(api.stats(), { recordings: 0, clips: 0, minutes: 0 }))
    setInterrupted(await soft(api.recordings.interrupted(), []))
    setLoading(false)
  }, [projectId])

  /**
   * A take whose app went away mid-recording still has every chunk on disk --
   * recovery is just the finalize step that never got to run.
   */
  const recover = useCallback(
    async (id: string) => {
      try {
        await must(api.recordings.recover(id))
        toast.ok('Recording recovered', 'The footage that was on disk has been stitched together.')
      } catch (e) {
        toast.fail('Could not recover that recording', e)
      }
      await load()
    },
    [load, toast]
  )

  const discard = useCallback(
    async (id: string) => {
      await soft(api.recordings.discard(id), undefined)
      await load()
    },
    [load]
  )

  /**
   * Everything the right-click menu can do. The menu itself is native (see
   * main/menus.ts) and only reports which item was chosen, so the work of
   * actually doing it lives here beside the list it mutates.
   */
  const onCardMenu = useCallback(
    async (rec: Recording, at: { x: number; y: number }) => {
      const action = await soft(
        api.menu.recording({ status: rec.status, hasFiles: Boolean(rec.dir), ...at }),
        null
      )
      if (!action) return

      if (action === 'open') return shell.go({ name: 'recording', id: rec.id })
      if (action === 'reveal') {
        await soft(api.shell.showItem(rec.dir), false)
        return
      }
      if (action === 'rename') return setRenaming(rec.id)
      if (action === 'recover') return recover(rec.id)
      if (action === 'remove') {
        await soft(api.recordings.remove(rec.id), undefined)
        toast.ok('Removed from Library', 'The files are still in ' + rec.dir)
        return load()
      }
      if (action === 'trash') {
        const ok = await soft(api.menu.confirmTrash({ title: rec.title, dir: rec.dir }), false)
        if (!ok) return
        await soft(api.recordings.trash(rec.id), undefined)
        toast.ok('Moved to Trash')
        return load()
      }
    },
    [load, recover, shell, toast]
  )

  const rename = useCallback(
    async (id: string, title: string) => {
      setRenaming(null)
      if (!title.trim()) return
      await soft(api.recordings.update({ id, title: title.trim() }), undefined)
      await load()
    },
    [load]
  )

  useEffect(() => {
    void load()
  }, [load, shell.jobTick])

  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    setSearching(true)
    try {
      setHits(await must(api.search(q)))
    } catch (e) {
      toast.fail('Search failed', e)
    } finally {
      setSearching(false)
    }
  }, [query, toast])

  const createProject = async (): Promise<void> => {
    if (!pName.trim()) return
    try {
      await must(api.projects.create({ name: pName.trim(), context: pContext.trim() }))
      await shell.reloadProjects()
      setNewProject(false)
      setPName('')
      setPContext('')
      toast.ok('Project created')
    } catch (e) {
      toast.fail('Could not create the project', e)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="drag-region px-8 pb-4 pt-[34px]">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight">Library</h1>
            <p className="mt-0.5 text-[12.5px] text-[#9aa1ab]">
              {stats.recordings} recording{stats.recordings === 1 ? '' : 's'} · {stats.clips} clip
              {stats.clips === 1 ? '' : 's'} · {stats.minutes} minutes captured
            </p>
          </div>
          <div className="no-drag flex items-center gap-2">
            <Select
              value={projectId ?? ''}
              onChange={(e) => setProjectId(e.target.value || null)}
              className="w-[180px] shrink-0 py-1.5 text-[12px]"
            >
              <option value="">All projects</option>
              {shell.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Button size="sm" onClick={() => setNewProject(true)}>
              New project
            </Button>
          </div>
        </div>

        <div className="no-drag mt-4 flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
            placeholder="Search everything you have ever said on camera…"
          />
          <Button size="sm" onClick={() => void runSearch()} loading={searching}>
            Search
          </Button>
          {hits && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setHits(null)
                setQuery('')
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
        {interrupted.length > 0 && (
          <div className="mb-4 flex flex-col gap-2">
            {interrupted.map((it) => (
              <div
                key={it.recordingId}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-[#F5A524]/35 bg-[#F5A524]/5 px-4 py-3"
              >
                <span className="text-[12.5px] font-medium text-[#F5A524]">
                  “{it.title}” did not finish
                </span>
                <span className="text-[12px] text-[#9aa1ab]">
                  {fmtBytes(it.bytes)} of {it.kinds.join(', ')} is still on disk from{' '}
                  {fmtAgo(String(it.startedAt))}.
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="primary" onClick={() => void recover(it.recordingId)}>
                  Recover
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void discard(it.recordingId)}>
                  Discard
                </Button>
              </div>
            ))}
          </div>
        )}
        {hits ? (
          hits.length === 0 ? (
            <Empty
              title="Nothing matched"
              body="Search covers transcripts and notebooks. If a recording has not been transcribed yet, its words are not in here."
            />
          ) : (
            <div className="flex flex-col gap-2">
              <div className="mb-1 text-[12px] text-[#6b727d]">
                {hits.length} match{hits.length === 1 ? '' : 'es'}
              </div>
              {hits.map((h, i) => (
                <button
                  key={`${h.recording_id}-${i}`}
                  onClick={() => shell.go({ name: 'recording', id: h.recording_id })}
                  className="rounded-[10px] border border-[#262a31] bg-[#121418] px-4 py-3 text-left hover:border-[#3a4048]"
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[12.5px] font-medium">{h.recording_title}</span>
                    <Badge tone={h.source === 'semantic' ? 'accent' : 'neutral'}>
                      {h.source === 'semantic' ? 'meaning' : 'exact'}
                    </Badge>
                    {h.start_ms != null && (
                      <span className="mono text-[11px] text-[#6b727d]">{fmtClock(h.start_ms)}</span>
                    )}
                  </div>
                  <div className="text-[12.5px] leading-relaxed text-[#9aa1ab]">{h.text}</div>
                </button>
              ))}
            </div>
          )
        ) : loading ? (
          <div className="flex items-center gap-2 py-16 text-[13px] text-[#9aa1ab]">
            <Spinner /> Loading…
          </div>
        ) : recordings.length === 0 ? (
          <Empty
            title="Nothing recorded yet"
            body="Head to the Studio, pick a screen, and talk through what you built. Showoff handles the rest."
            action={<Button variant="primary" onClick={() => shell.go({ name: 'studio' })}>Open Studio</Button>}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {recordings.map((r) => (
              <RecordingCard
                key={r.id}
                rec={r}
                renaming={renaming === r.id}
                onRename={(title) => void rename(r.id, title)}
                onMenu={(at) => void onCardMenu(r, at)}
                onOpen={() => shell.go({ name: 'recording', id: r.id })}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={newProject}
        onClose={() => setNewProject(false)}
        title="New project"
        subtitle="Projects group recordings and give the model standing context — what you are building, who it is for, how you talk about it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewProject(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void createProject()} disabled={!pName.trim()}>
              Create
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <Input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Showoff" />
          </Field>
          <Field
            label="Context"
            hint="Pasted into every prompt for this project. Product, audience, tone, things to never say."
          >
            <Textarea
              rows={5}
              value={pContext}
              onChange={(e) => setPContext(e.target.value)}
              placeholder="A desktop studio for builders who want to ship one screen share a day. Audience: indie devs on X and LinkedIn. Tone: direct, concrete, no hype."
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}

function RecordingCard({
  rec,
  renaming,
  onOpen,
  onMenu,
  onRename
}: {
  rec: Recording
  renaming: boolean
  onOpen: () => void
  onMenu: (at: { x: number; y: number }) => void
  onRename: (title: string) => void
}): React.ReactElement {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu({ x: e.clientX, y: e.clientY })
      }}
      className="group cursor-pointer overflow-hidden rounded-[10px] border border-[#262a31] bg-[#121418] text-left transition-colors hover:border-[#3a4048]"
    >
      <div className="relative aspect-video bg-black">
        {rec.poster_path ? (
          <img src={api.mediaUrl(rec.poster_path)} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-[#6b727d]">
            {rec.status === 'failed' ? 'failed' : 'no thumbnail'}
          </div>
        )}
        {rec.duration_ms != null && (
          <span className="mono absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[11px]">
            {fmtDuration(rec.duration_ms)}
          </span>
        )}
      </div>
      <div className="px-3 py-2.5">
        {renaming ? (
          <input
            autoFocus
            defaultValue={rec.title}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => onRename(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') onRename((e.target as HTMLInputElement).value)
              if (e.key === 'Escape') onRename(rec.title)
            }}
            className="w-full rounded-[6px] border border-[#F5A524]/50 bg-[#0e0f12] px-1.5 py-0.5 text-[13px] font-medium outline-none"
          />
        ) : (
          <div className="truncate text-[13px] font-medium">{rec.title}</div>
        )}
        <div className="mt-1 flex items-center gap-2 text-[11.5px] text-[#6b727d]">
          <span>{fmtAgo(rec.created_at)}</span>
          {rec.status === 'failed' && <Badge tone="bad">failed</Badge>}
          {rec.status === 'recording' && <Badge tone="accent">unfinished</Badge>}
        </div>
      </div>
    </div>
  )
}
