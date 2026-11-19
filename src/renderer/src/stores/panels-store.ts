import { create } from 'zustand'
import type { StoryPanels, PanelImage, PanelTarget, PromptMode } from '@shared/types'
import { usePinsStore } from './pins-store'
import { t } from '../lib/i18n'
import { toast } from './toast-store'

/**
 * Story panel stepper. The `panels` sheet of each story's workbook lists its panels in reading order (same
 * columns as modes). Going to a panel fills the prompt panel from its row, like applying a mode, and while a
 * panel is active every generated image is tagged with it, saved into that panel's own folder.
 * Pins are kept per story (the pin store's "mode" is `story:<name>`).
 */
const STATE_KEY = 'story_stepper'

interface Saved {
  story: string | null
  /** Last panel per story (1-based). */
  positions: Record<string, number>
  active: boolean
}

function loadSaved(): Saved {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as Partial<Saved> | null
    return {
      story: typeof parsed?.story === 'string' ? parsed.story : null,
      positions: parsed?.positions && typeof parsed.positions === 'object' ? parsed.positions : {},
      active: parsed?.active === true
    }
  } catch {
    return { story: null, positions: {}, active: false }
  }
}

interface PanelsState extends Saved {
  books: StoryPanels[]
  loaded: boolean
  loading: boolean
  images: PanelImage[]
  load: () => Promise<void>
  selectStory: (story: string) => void
  /** Applies panel `index` (1-based) of the selected story and makes it the active panel. */
  go: (index: number) => Promise<void>
  /** Stops tagging images with a panel (applying a mode does this too). */
  leave: () => void
  refreshImages: () => Promise<void>
  toggleFavorite: (image: PanelImage) => Promise<void>
  exportAll: () => Promise<void>
  openFolder: () => void
}

const PANEL_PINS_PREFIX = 'story:'

export const usePanelsStore = create<PanelsState>((set, get) => {
  const persist = (): void => {
    const { story, positions, active } = get()
    localStorage.setItem(STATE_KEY, JSON.stringify({ story, positions, active } satisfies Saved))
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
        const listed = await window.nais.invoke('panels:list', undefined)
        const books = Array.isArray(listed) ? listed : []
        let { story } = get()
        if (!books.some((b) => b.story === story)) story = books[0]?.story ?? null
        set({ books, loaded: true, story })
        if (get().active && story) usePinsStore.getState().switchMode(PANEL_PINS_PREFIX + story)
        persist()
        await get().refreshImages()
      } finally {
        set({ loading: false })
      }
    },

    selectStory: (story) => {
      set({ story, images: [] })
      persist()
      void get().go(get().positions[story] ?? 1)
    },

    go: async (index) => {
      const { story, books } = get()
      const book = books.find((b) => b.story === story)
      if (!story || !book || book.panels.length === 0) return
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
      usePinsStore.getState().switchMode(PANEL_PINS_PREFIX + story)
      set({ positions: { ...get().positions, [story]: clamped }, active: true, images: [] })
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
        const result = await window.nais.invoke('panels:images', target)
        const items = Array.isArray(result?.items) ? result.items : []
        // a newer panel may have been chosen meanwhile
        const now = panelForRequest()
        if (now && now.story === target.story && now.index === target.index)
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
      const { story } = get()
      if (!story) return
      try {
        const { count, canceled } = await window.nais.invoke('panels:export', { story })
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

/** The selected story's panels. */
export function currentPanels(): PromptMode[] {
  const { books, story } = usePanelsStore.getState()
  return books.find((b) => b.story === story)?.panels ?? []
}

/** The active panel, sent with every generation while the stepper is on; null otherwise. */
export function panelForRequest(): PanelTarget | null {
  const { active, story, positions } = usePanelsStore.getState()
  if (!active || !story) return null
  const index = positions[story] ?? 1
  const panel = currentPanels()[index - 1]
  return panel ? { story, index, name: panel.name } : null
}

/** Keeps the image strip current when an image for the active panel is saved. Returns the unsubscribe. */
export function bindPanelEvents(): () => void {
  return window.nais.on('panels:changed', (target) => {
    const now = panelForRequest()
    if (now && now.story === target.story && now.index === target.index) {
      void usePanelsStore.getState().refreshImages()
    }
  })
}
