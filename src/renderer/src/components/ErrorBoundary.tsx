import React from 'react'

interface State {
  error: Error | null
}

/**
 * A React error anywhere in the tree would otherwise leave a black window with
 * no explanation, which is indistinguishable from the app being broken at the
 * OS level. Show what happened and how to get out of it.
 */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Showoff render error', error, info.componentStack)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full items-center justify-center p-10">
        <div className="max-w-xl rounded-[10px] border border-[#f0616d]/40 bg-[#15181d] p-6">
          <h1 className="text-[16px] font-semibold text-[#f0616d]">Showoff hit a rendering error</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-[#9aa1ab]">
            Your recordings and clips are safe — they live in the database and on disk, not in
            this window. Reloading usually clears it.
          </p>
          <pre className="mono mt-3 max-h-[220px] overflow-auto rounded-[8px] border border-[#262a31] bg-[#0f1115] p-3 text-[11px] leading-relaxed text-[#9aa1ab]">
            {error.stack ?? error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-[10px] border border-[#F5A524] bg-[#F5A524] px-3.5 py-2 text-[13px] font-medium text-[#1A1206]"
            >
              Reload
            </button>
            <button
              onClick={() => void navigator.clipboard.writeText(error.stack ?? error.message)}
              className="rounded-[10px] border border-[#262a31] bg-[#191c21] px-3.5 py-2 text-[13px]"
            >
              Copy error
            </button>
          </div>
        </div>
      </div>
    )
  }
}
