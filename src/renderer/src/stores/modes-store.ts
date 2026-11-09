import { create } from 'zustand'
import type { PromptMode } from '@shared/types'
import { t } from '../lib/i18n'
import { useCharactersStore } from './characters-store'
import { useGenerationStore } from './generation-store'
import { usePanelsStore } from './panels-store'
import { usePinsStore } from './pins-store'
import { usePromptPresetsStore } from './prompt-presets-store'

/**
 * Modes from the workbook's `modes` sheets. Applying one fills the main prompt, the main negative and the
 * character boxes (as cards in the mode-slot folder), and the image size when the mode has one.
 */
const ACTIVE_KEY = 'mode_active'

interface ModesState {
  modes: PromptMode[]
  loaded: boolean
  loading: boolean
  /** Id of the mode applied last (shown on the bar). */
  activeId: string | null
  load: () => Promise<void>
  apply: (mode: PromptMode) => Promise<void>
  /** Forgets the active mode (a doujin panel was applied instead). */
  clearActive: () => void
}

/**
 * Fills the prompt panel from a modes / panels row: main prompt, negative, the character boxes (cards in the
 * mode-slot folder) and the size when the row has one. Clears the active prompt preset first.
 */
export async function applyPromptRow(mode: PromptMode): Promise<void> {
  // A prompt preset that stays active would save the mode's text over itself.
  usePromptPresetsStore.getState().setActive(null)
  const generation = useGenerationStore.getState()
  generation.patchRequest({
    prompt: mode.prompt,
    negativePrompt: mode.negativePrompt,
    ...(generation.promptSplitEnabled
      ? { promptParts: { base: mode.prompt, additional: '', detail: '' } }
      : {}),
    ...(mode.size ? { width: mode.size.width, height: mode.size.height } : {})
  })
  await useCharactersStore
    .getState()
    .applyModeCharacters(mode.characters, t('ui.modeSlotsFolder'), (index) =>
      t('ui.modeSlotValue', index + 1)
    )
}

export const useModesStore = create<ModesState>((set) => ({
  modes: [],
  loaded: false,
  loading: false,
  activeId: localStorage.getItem(ACTIVE_KEY),
  clearActive: () => {
    set({ activeId: null })
    localStorage.removeItem(ACTIVE_KEY)
  },
  load: async () => {
    set({ loading: true })
    try {
      set({ modes: await window.nais.invoke('modes:list', undefined), loaded: true })
    } finally {
      set({ loading: false })
    }
  },
  apply: async (mode) => {
    await applyPromptRow(mode)
    // a mode is not a doujin panel: images go back to the normal folders
    usePanelsStore.getState().leave()
    set({ activeId: mode.id })
    localStorage.setItem(ACTIVE_KEY, mode.id)
    // every mode keeps its own pins
    usePinsStore.getState().switchMode(mode.id)
  }
}))
