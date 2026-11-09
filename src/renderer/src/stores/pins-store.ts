import { create } from 'zustand'
import type { PinnedVariable, RollPreviewResult } from '@shared/types'
import { enabledCharacters } from './characters-store'
import { styleForRequest } from './style-store'

/**
 * Pinned prompt variables (pin panel). A pin is sent with every generation and roll preview as
 * `$name := lock`, and wins over every definition of that name in the prompts, fragments and sheets.
 * Kept in localStorage, so pins survive a restart until they are removed.
 */
const STORAGE_KEY = 'variable_pins'

function loadPins(): PinnedVariable[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (p): p is PinnedVariable =>
            typeof p === 'object' &&
            p !== null &&
            typeof (p as PinnedVariable).name === 'string' &&
            typeof (p as PinnedVariable).lock === 'string'
        )
      : []
  } catch {
    return []
  }
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

interface PinsState {
  pins: PinnedVariable[]
  /** The last roll made from the pin panel (variables with their possible values). */
  lastRoll: RollPreviewResult | null
  rolling: boolean
  pin: (pin: PinnedVariable) => void
  pinMany: (pins: PinnedVariable[]) => void
  unpin: (name: string) => void
  clear: () => void
  /** Rolls the current prompts once (with the pins applied) to list every variable and its values. */
  roll: () => Promise<void>
}

export const usePinsStore = create<PinsState>((set, get) => {
  const save = (pins: PinnedVariable[]): void => {
    set({ pins })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pins))
  }
  return {
    pins: loadPins(),
    lastRoll: null,
    rolling: false,
    pin: (pin) => save([...get().pins.filter((p) => !sameName(p.name, pin.name)), pin]),
    pinMany: (pins) => {
      const names = pins.map((p) => p.name)
      save([...get().pins.filter((p) => !names.some((n) => sameName(n, p.name))), ...pins])
    },
    unpin: (name) => save(get().pins.filter((p) => !sameName(p.name, name))),
    clear: () => save([]),
    roll: async () => {
      // imported lazily: the generation store imports this store
      const { useGenerationStore } = await import('./generation-store')
      const request = useGenerationStore.getState().request
      set({ rolling: true })
      try {
        const lastRoll = await window.nais.invoke('fragments:rollPreview', {
          prompt: request.prompt,
          negativePrompt: request.negativePrompt,
          characters: enabledCharacters().map((c) => ({
            prompt: c.prompt,
            negativePrompt: c.negativePrompt
          })),
          pins: pinsForRequest(),
          style: styleForRequest()
        })
        set({ lastRoll })
      } catch (error) {
        set({
          lastRoll: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            variables: [],
            picks: []
          }
        })
      } finally {
        set({ rolling: false })
      }
    }
  }
})

/** The pins as sent with a request. */
export function pinsForRequest(): { name: string; lock: string }[] {
  return usePinsStore.getState().pins.map(({ name, lock }) => ({ name, lock }))
}
