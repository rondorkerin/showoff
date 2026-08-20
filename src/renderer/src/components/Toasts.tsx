import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { cls } from '../lib/format.ts'
import { errorOf } from '../lib/api.ts'

export interface Toast {
  id: number
  tone: 'info' | 'good' | 'bad'
  title: string
  body?: string
  detail?: string
}

interface ToastApi {
  push: (t: Omit<Toast, 'id'>) => void
  ok: (title: string, body?: string) => void
  fail: (title: string, e: unknown) => void
}

const Ctx = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useToast used outside ToastProvider')
  return v
}

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++seq.current
    setToasts((list) => [...list, { ...t, id }])
    // Failures stay until dismissed: an error that vanishes before you finish
    // reading it is the same as no error at all.
    if (t.tone !== 'bad') setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), 4200)
  }, [])

  const value = useMemo<ToastApi>(
    () => ({
      push,
      ok: (title, body) => push({ tone: 'good', title, body }),
      fail: (title, e) => {
        const err = errorOf(e)
        push({ tone: 'bad', title, body: err.message, detail: err.remedy })
      }
    }),
    [push]
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[380px] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cls(
              'pointer-events-auto rounded-[10px] border bg-[#15181d] px-4 py-3 shadow-xl',
              t.tone === 'bad'
                ? 'border-[#f0616d]/40'
                : t.tone === 'good'
                  ? 'border-[#4ade80]/30'
                  : 'border-[#262a31]'
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div
                  className={cls(
                    'text-[13px] font-medium',
                    t.tone === 'bad' ? 'text-[#f0616d]' : 'text-[#e9eaec]'
                  )}
                >
                  {t.title}
                </div>
                {t.body && (
                  <div className="mt-1 text-[12px] leading-relaxed break-words text-[#9aa1ab]">
                    {t.body}
                  </div>
                )}
                {t.detail && (
                  <div className="mt-1.5 text-[11.5px] leading-relaxed text-[#F5A524]">{t.detail}</div>
                )}
              </div>
              <button
                onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}
                className="shrink-0 text-[#6b727d] hover:text-[#e9eaec]"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
