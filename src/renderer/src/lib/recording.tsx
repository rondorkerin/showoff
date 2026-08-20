import React, { createContext, useContext, useEffect } from 'react'
import { useRecorder, type RecorderState } from './recorder.ts'

type Recorder = ReturnType<typeof useRecorder>

const Ctx = createContext<Recorder | null>(null)

/**
 * A recording outlives the screen you started it from.
 *
 * The recorder used to live inside Studio, which meant opening the Library or
 * Settings unmounted it -- and unmounting tore down the MediaRecorders and
 * abandoned the take, leaving a recording row on disk with no tracks under it.
 * Holding it above the router is the whole fix: navigation is now just
 * navigation, and the capture keeps running behind whatever you are looking at.
 */
export function RecordingProvider({
  onFinalized,
  children
}: {
  onFinalized: (recordingId: string) => void
  children: React.ReactNode
}): React.ReactElement {
  const recorder = useRecorder(onFinalized)
  return <Ctx.Provider value={recorder}>{children}</Ctx.Provider>
}

export function useRecording(): Recorder {
  const value = useContext(Ctx)
  if (!value) throw new Error('useRecording must be used inside a RecordingProvider')
  return value
}

/** Lets the shell paint the recording chrome without subscribing to every tick. */
export function RecordingSync({
  onChange
}: {
  onChange: (live: boolean) => void
}): null {
  const { state } = useRecording()
  const live = state.phase === 'recording' || state.phase === 'countdown'
  useEffect(() => onChange(live), [live, onChange])
  return null
}

export type { RecorderState }
