import React from 'react'
import { useRecording } from '../lib/recording.tsx'
import { cls, fmtClock } from '../lib/format.ts'
import { Button } from './ui.tsx'

const PHASE_LABEL: Record<string, string> = {
  arming: 'Getting ready',
  countdown: 'Starting',
  recording: 'Recording',
  paused: 'Paused',
  finalizing: 'Saving'
}

/**
 * The proof that leaving Studio did not stop the take.
 *
 * Shown on every screen except Studio itself, which has the full capture UI.
 * It carries the controls that matter away from that screen -- stop and pause
 * -- because the alternative is navigating back just to end a recording.
 */
export default function RecordingBar({
  onOpenStudio
}: {
  onOpenStudio: () => void
}): React.ReactElement | null {
  const rec = useRecording()
  const { phase } = rec.state
  if (phase === 'idle') return null

  const live = phase === 'recording'
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[#F5A524]/25 bg-[#F5A524]/[0.07] px-4 py-2">
      <span
        className={cls(
          'inline-block h-[8px] w-[8px] shrink-0 rounded-full bg-[#F5A524]',
          live && 'rec-dot'
        )}
      />
      <span className="text-[12px] text-[#F5A524]">{PHASE_LABEL[phase] ?? phase}</span>
      <span className="mono text-[13px] text-[#e9eaec]">{fmtClock(rec.state.elapsedMs)}</span>

      <button
        onClick={onOpenStudio}
        className="text-[12px] text-[#9aa1ab] underline underline-offset-2 hover:text-[#e9eaec]"
      >
        Back to Studio
      </button>

      <span className="flex-1" />

      {live && (
        <Button size="sm" variant="ghost" onClick={rec.pause}>
          Pause
        </Button>
      )}
      {phase === 'paused' && (
        <Button size="sm" variant="ghost" onClick={rec.resume}>
          Resume
        </Button>
      )}
      <Button
        size="sm"
        variant="primary"
        onClick={() => void rec.stop()}
        disabled={phase === 'finalizing' || phase === 'arming'}
      >
        Stop &amp; save
      </Button>
    </div>
  )
}
