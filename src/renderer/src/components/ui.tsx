import React, { useEffect, useRef } from 'react'
import { cls } from '../lib/format.ts'

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'default' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps): React.ReactElement {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-[10px] border transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed no-drag whitespace-nowrap'
  const sizes = size === 'sm' ? 'px-2.5 py-1.5 text-[12px]' : 'px-3.5 py-2 text-[13px]'
  const variants = {
    primary:
      'bg-[#F5A524] border-[#F5A524] text-[#1A1206] font-medium hover:bg-[#ffb43f] hover:border-[#ffb43f]',
    default:
      'bg-[#191c21] border-[#262a31] text-[#e9eaec] hover:bg-[#22262d] hover:border-[#333944]',
    ghost: 'bg-transparent border-transparent text-[#9aa1ab] hover:text-[#e9eaec] hover:bg-[#191c21]',
    danger: 'bg-transparent border-[#3a2429] text-[#f0616d] hover:bg-[#2a1a1e]'
  }[variant]
  return (
    <button className={cls(base, sizes, variants, className)} disabled={disabled || loading} {...rest}>
      {loading && <Spinner />}
      {children}
    </button>
  )
}

export function Spinner({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={cls('spin', className)} width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function Card({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cls('rounded-[10px] border border-[#262a31] bg-[#121418]', className)}
      {...rest}
    >
      {children}
    </div>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label className="block">
      <div className="mb-1.5 text-[12px] font-medium text-[#9aa1ab]">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[11px] leading-relaxed text-[#6b727d]">{hint}</div>}
    </label>
  )
}

const inputBase =
  'w-full rounded-[10px] border border-[#262a31] bg-[#0f1115] px-3 py-2 text-[13px] text-[#e9eaec] placeholder:text-[#565d68] outline-none focus:border-[#F5A524]/60 no-drag'

/**
 * Tailwind decides between two width utilities by stylesheet order, not by the
 * order they appear in the attribute, so a caller's `w-[160px]` silently loses
 * to the base `w-full`. Drop the default when the caller names a width.
 */
function base(className?: string): string {
  return className && /(^|\s)w-/.test(className) ? inputBase.replace('w-full ', '') : inputBase
}

export function Input(
  props: React.InputHTMLAttributes<HTMLInputElement>
): React.ReactElement {
  return <input {...props} className={cls(base(props.className), props.className)} />
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>
): React.ReactElement {
  return (
    <textarea
      {...props}
      className={cls(base(props.className), 'resize-y leading-relaxed', props.className)}
    />
  )
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement>
): React.ReactElement {
  return (
    <select {...props} className={cls(base(props.className), 'appearance-none pr-8', props.className)}>
      {props.children}
    </select>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cls(
        'flex w-full items-start gap-3 rounded-[10px] px-1 py-1.5 text-left no-drag',
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-[#171a1f]'
      )}
    >
      <span
        className={cls(
          'mt-0.5 flex h-[18px] w-[30px] shrink-0 items-center rounded-full border p-[2px] transition-colors',
          checked ? 'border-[#F5A524] bg-[#F5A524]/25' : 'border-[#333944] bg-[#191c21]'
        )}
      >
        <span
          className={cls(
            'h-[12px] w-[12px] rounded-full transition-transform',
            checked ? 'translate-x-[12px] bg-[#F5A524]' : 'translate-x-0 bg-[#6b727d]'
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-[#e9eaec]">{label}</span>
        {hint && <span className="block text-[11px] leading-relaxed text-[#6b727d]">{hint}</span>}
      </span>
    </button>
  )
}

export function Badge({
  children,
  tone = 'neutral'
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'accent' | 'good' | 'bad'
}): React.ReactElement {
  const tones = {
    neutral: 'border-[#262a31] bg-[#191c21] text-[#9aa1ab]',
    accent: 'border-[#F5A524]/35 bg-[#F5A524]/10 text-[#F5A524]',
    good: 'border-[#4ade80]/30 bg-[#4ade80]/10 text-[#4ade80]',
    bad: 'border-[#f0616d]/30 bg-[#f0616d]/10 text-[#f0616d]'
  }[tone]
  return (
    <span
      className={cls(
        'inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11px] leading-[16px]',
        tones
      )}
    >
      {children}
    </span>
  )
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={cls(
          'flex max-h-[85vh] w-full flex-col overflow-hidden rounded-[10px] border border-[#262a31] bg-[#121418] shadow-2xl outline-none',
          wide ? 'max-w-3xl' : 'max-w-lg'
        )}
      >
        <div className="border-b border-[#1d2026] px-5 py-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {subtitle && <p className="mt-1 text-[12px] leading-relaxed text-[#9aa1ab]">{subtitle}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-[#1d2026] px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export function Empty({
  title,
  body,
  action
}: {
  title: string
  body: string
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center rounded-[10px] border border-dashed border-[#262a31] px-8 py-14 text-center">
      <div className="text-[14px] font-medium text-[#e9eaec]">{title}</div>
      <p className="mt-2 max-w-md text-[12.5px] leading-relaxed text-[#9aa1ab]">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** A progress bar that reads as a bar even at 0%, so "queued" is visible. */
export function Bar({ value }: { value: number }): React.ReactElement {
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#22262d]">
      <div
        className="h-full rounded-full bg-[#F5A524] transition-[width] duration-300"
        style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }}
      />
    </div>
  )
}
