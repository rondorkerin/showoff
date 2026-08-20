import React, { useEffect, useState } from 'react'
import { api, must } from '../lib/api.ts'
import { cls } from '../lib/format.ts'
import { Button, Field, Input, Modal, Select, Spinner, Textarea } from './ui.tsx'
import { useToast } from './Toasts.tsx'
import { PLATFORMS, PLATFORM_IDS, type PlatformId } from '../../../shared/platforms.ts'
import type { ClarifyingQuestion } from '../../../shared/types.ts'

export default function CutDialog({
  open,
  onClose,
  recordingId,
  defaultPlatforms,
  defaultMaxClips,
  onStarted
}: {
  open: boolean
  onClose: () => void
  recordingId: string
  defaultPlatforms: PlatformId[]
  defaultMaxClips: number
  onStarted: () => void
}): React.ReactElement {
  const toast = useToast()
  const [questions, setQuestions] = useState<ClarifyingQuestion[] | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [platforms, setPlatforms] = useState<PlatformId[]>(defaultPlatforms)
  const [maxClips, setMaxClips] = useState(defaultMaxClips)
  const [loading, setLoading] = useState(false)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!open) return
    setQuestions(null)
    setAnswers({})
    setPlatforms(defaultPlatforms)
    setMaxClips(defaultMaxClips)
    setLoading(true)
    void (async () => {
      try {
        setQuestions(await must(api.pipeline.questions(recordingId)))
      } catch (e) {
        // Questions are a nicety, not a gate. If the model is unreachable the
        // cut still runs — you just lose the extra context.
        setQuestions([])
        toast.push({
          tone: 'info',
          title: 'Skipping the questions',
          body: 'Could not reach the model for clarifying questions. You can still cut.'
        })
      } finally {
        setLoading(false)
      }
    })()
  }, [open, recordingId, defaultPlatforms, defaultMaxClips, toast])

  const start = async (): Promise<void> => {
    setStarting(true)
    try {
      await must(
        api.pipeline.cut({
          recordingId,
          answers: (questions ?? [])
            .filter((q) => (answers[q.id] ?? '').trim())
            .map((q) => ({ question: q.question, answer: answers[q.id].trim() })),
          platforms,
          maxClips
        })
      )
      onStarted()
      onClose()
    } catch (e) {
      toast.fail('Could not start the cut', e)
    } finally {
      setStarting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Cut this into content"
      subtitle="A few questions first. Answer what you care about, skip the rest — every answer goes straight into the prompt that picks the clips."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void start()}
            loading={starting}
            disabled={platforms.length === 0}
          >
            Cut {maxClips} clip{maxClips === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-[13px] text-[#9aa1ab]">
          <Spinner /> Reading the transcript…
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {(questions ?? []).length > 0 && (
            <div className="flex flex-col gap-4">
              {questions!.map((q) => (
                <div key={q.id}>
                  <div className="text-[13px] text-[#e9eaec]">{q.question}</div>
                  {q.why && <div className="mt-0.5 text-[11.5px] text-[#6b727d]">{q.why}</div>}
                  <Input
                    className="mt-1.5"
                    placeholder={q.suggestion || 'Optional'}
                    value={answers[q.id] ?? ''}
                    onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}

          <div>
            <div className="mb-2 text-[12px] font-medium text-[#9aa1ab]">Where is this going?</div>
            <div className="grid grid-cols-2 gap-2">
              {PLATFORM_IDS.map((id) => {
                const on = platforms.includes(id)
                const spec = PLATFORMS[id]
                return (
                  <button
                    key={id}
                    onClick={() =>
                      setPlatforms((p) => (on ? p.filter((x) => x !== id) : [...p, id]))
                    }
                    className={cls(
                      'rounded-[10px] border px-3 py-2.5 text-left transition-colors',
                      on
                        ? 'border-[#F5A524] bg-[#F5A524]/8'
                        : 'border-[#262a31] bg-[#0f1115] hover:border-[#3a4048]'
                    )}
                  >
                    <div className="text-[13px]">{spec.label}</div>
                    <div className="mono mt-0.5 text-[11px] text-[#6b727d]">
                      {spec.width}×{spec.height} · up to {Math.round(spec.maxSeconds / 60)}m
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <Field
            label="How many clips?"
            hint="The model may return fewer if the recording genuinely only holds one good moment."
          >
            <Select value={maxClips} onChange={(e) => setMaxClips(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Modal>
  )
}
