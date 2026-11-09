import { create } from 'zustand'
import type { DoujinPanels, PanelImage, PanelTarget, PromptMode } from '@shared/types'
import { usePinsStore } from './pins-store'
import { t } from '../lib/i18n'
import { toast } from './toast-store'

/**
 * Doujin panel stepper. The `panels` sheet of each doujin's workbook lists its panels in reading order (same
 * columns as modes). Going to a panel fills the prompt panel from its row, like applying a mode, and while a
 * panel is active every generated image is tagged with it, saved into that panel's own folder.
 * Pins are kept per doujin (the pin store's "mode" is `doujin:<name>`).
 */
const STATE_KEY = 'doujin_stepper'

interface Saved {
  doujin: string | null
  /** Last panel per doujin (1-based). */
  positions: Record<string, number>
  active: boolean
}

function loadSaved(): Saved {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as Partial<Saved> | null
    return {
      doujin: typeof parsed?.doujin === 'string' ? parsed.doujin : null,
      positions: parsed?.positions && typeof parsed.positions === 'object' ? parsed.positions : {},
      active: parsed?.active === true
    }
  } catch {
    return { doujin: null, positions: {}, active: false }
  }
}

interface PanelsState extends Saved {
  books: DoujinPanels[]
  loaded: boolean
  loading: boolean
  images: PanelImage[]
  load: () => Promise<void>
  selectDoujin: (doujin: string) => void
  /** Applies panel `index` (1-based) of the selected doujin and makes it the active panel. */
  go: (index: number) => Promise<void>
  /** Stops tagging images with a panel (applying a mode does this too). */
  leave: () => void
  refreshImages: () => Promise<void>
  toggleFavorite: (image: PanelImage) => Promise<void>
  exportAll: () => Promise<void>
  openFolder: () => void
}

const PANEL_PINS_PREFIX = 'doujin:'

export const usePanelsStore = create<PanelsState>((set, get) => {
  const persist = (): void => {
    const { doujin, positions, active } = get()
    localStorage.setItem(STATE_KEY, JSON.stringify({ doujin, positions, active } satisfies Saved))
  }
  return {
    ...loadSaved(),
    books: [],
    loaded: false,
    loading: false,
    images: [],

    load: async () => {
      set({ loading: true })
      try {
        const books = await window.nais.invoke('panels:list', undefined)
        let { doujin } = get()
        if (!books.some((b) => b.doujin === doujin)) doujin = books[0]?.doujin ?? null
        set({ books, loaded: true, doujin })
        if (get().active && doujin) usePinsStore.getState().switchMode(PANEL_PINS_PREFIX + doujin)
        persist()
        await get().refreshImages()
      } finally {
        set({ loading: false })
      }
    },

    selectDoujin: (doujin) => {
      set({ doujin, images: [] })
      persist()
      void get().go(get().positions[doujin] ?? 1)
    },

    go: async (index) => {
      const { doujin, books } = get()
      const book = books.find((b) => b.doujin === doujin)
      if (!doujin || !book || book.panels.length === 0) return
      const clamped = Math.min(book.panels.length, Math.max(1, index))
      const panel = book.panels[clamped - 1]
      // imported lazily: the modes store imports this store
      const { applyPromptRow, useModesStore } = await import('./modes-store')
      try {
        await applyPromptRow(panel)
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
        return
      }
      useModesStore.getState().clearActive()
      usePinsStore.getState().switchMode(PANEL_PINS_PREFIX + doujin)
      set({ positions: { ...get().positions, [doujin]: clamped }, active: true, images: [] })
      persist()
      await get().refreshImages()
    },

    leave: () => {
      if (!get().active) return
      set({ active: false, images: [] })
      persist()
    },

    refreshImages: async () => {
      const target = panelForRequest()
      if (!target) return set({ images: [] })
      try {
        const { items } = await window.nais.invoke('panels:images', target)
        // a newer panel may have been chosen meanwhile
        const now = panelForRequest()
        if (now && now.doujin === target.doujin && now.index === target.index)
          set({ images: items })
      } catch {
        set({ images: [] })
      }
    },

    toggleFavorite: async (image) => {
      await window.nais.invoke('images:setFavorite', { id: image.id, favorite: !image.favorite })
      set({
        images: get().images.map((i) => (i.id === image.id ? { ...i, favorite: !i.favorite } : i))
      })
    },

    exportAll: async () => {
      const { doujin } = get()
      if (!doujin) return
      try {
        const { count, canceled } = await window.nais.invoke('panels:export', { doujin })
        if (!canceled) toast(t('ui.panelsExported', count))
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
      }
    },

    openFolder: () => {
      const target = panelForRequest()
      if (target) void window.nais.invoke('panels:openFolder', target)
    }
  }
})

/** The selected doujin's panels. */
export function currentPanels(): PromptMode[] {
  const { books, doujin } = usePanelsStore.getState()
  return books.find((b) => b.doujin === doujin)?.panels ?? []
}

/** The active panel, sent with every generation while the stepper is on; null otherwise. */
export function panelForRequest(): PanelTarget | null {
  const { active, doujin, positions } = usePanelsStore.getState()
  if (!active || !doujin) return null
  const index = positions[doujin] ?? 1
  const panel = currentPanels()[index - 1]
  return panel ? { doujin, index, name: panel.name } : null
}

/** Keeps the image strip current when an image for the active panel is saved. Returns the unsubscribe. */
export function bindPanelEvents(): () => void {
  return window.nais.on('panels:changed', (target) => {
    const now = panelForRequest()
    if (now && now.doujin === target.doujin && now.index === target.index) {
      void usePanelsStore.getState().refreshImages()
    }
  })
}
