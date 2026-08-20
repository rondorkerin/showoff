import type { ShowoffApi, IpcError, Result } from '../../../preload/index.ts'

declare global {
  interface Window {
    showoff: ShowoffApi
  }
}

export const api = window.showoff

export type { IpcError, Result }

/** Thrown by `must`. Carries the structured remedy so the UI can show it. */
export class ApiError extends Error {
  code: string
  remedy: string
  detail: string
  constructor(err: IpcError) {
    super(err.message)
    this.code = err.code
    this.remedy = err.remedy
    this.detail = err.detail
  }
}

/**
 * Unwraps a Result, throwing a rich ApiError. Use inside try/catch where the
 * caller wants to react to failure; use `soft` where a failure is survivable.
 */
export async function must<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p
  if (!r.ok) throw new ApiError(r.error)
  return r.data
}

/** Returns the fallback on failure instead of throwing. */
export async function soft<T>(p: Promise<Result<T>>, fallback: T): Promise<T> {
  const r = await p
  return r.ok ? r.data : fallback
}

export function errorOf(e: unknown): { message: string; remedy: string; detail: string } {
  if (e instanceof ApiError) return { message: e.message, remedy: e.remedy, detail: e.detail }
  if (e instanceof Error) return { message: e.message, remedy: '', detail: '' }
  return { message: String(e), remedy: '', detail: '' }
}
