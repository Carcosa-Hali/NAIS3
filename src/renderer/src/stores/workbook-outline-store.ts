import { create } from 'zustand'
import type { WorkbookOutline } from '@shared/types'

/**
 * The workbook's sheets, keys and columns for the prompt editor's completion. Fetched on first use and again
 * when older than a few seconds, so keys added in Excel show up after saving the file.
 */
const MAX_AGE_MS = 15_000

interface OutlineState {
  outline: WorkbookOutline
  fetchedAt: number
  pending: Promise<void> | null
  /** Fetches the outline when it is stale; resolves immediately otherwise. */
  ensure: () => Promise<void>
}

export const useWorkbookOutlineStore = create<OutlineState>((set, get) => ({
  outline: { sheets: [] },
  fetchedAt: 0,
  pending: null,
  ensure: () => {
    const { fetchedAt, pending } = get()
    if (pending) return pending
    if (Date.now() - fetchedAt < MAX_AGE_MS) return Promise.resolve()
    const next = window.nais
      .invoke('workbook:outline', undefined)
      .then((outline) => set({ outline, fetchedAt: Date.now() }))
      .catch(() => set({ fetchedAt: Date.now() }))
      .finally(() => set({ pending: null }))
    set({ pending: next })
    return next
  }
}))

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** A sheet of the outline by name (case and spacing ignored; `File:Sheet` or bare). */
export function outlineSheet(name: string): WorkbookOutline['sheets'][number] | undefined {
  const sheets = useWorkbookOutlineStore.getState().outline.sheets
  const wanted = norm(name)
  return (
    sheets.find((s) => norm(s.name) === wanted) ??
    sheets.find((s) => norm(s.name).split(':').pop() === wanted)
  )
}
