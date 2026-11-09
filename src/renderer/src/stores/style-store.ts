import { create } from 'zustand'
import type { StyleLayer } from '@shared/types'

/**
 * Style layer: a main-prompt and a negative text that are added to every generation and roll preview, apart from
 * the prompt boxes. Applying a mode or a prompt preset replaces the prompt boxes but never the style layer, so
 * artist sets, composition tags and the like can be swapped freely on top of any mode.
 * Kept in localStorage, so it survives a restart.
 */
const STORAGE_KEY = 'style_layer'

interface StoredStyle {
  prompt: string
  negativePrompt: string
  enabled: boolean
  expanded: boolean
}

const EMPTY: StoredStyle = { prompt: '', negativePrompt: '', enabled: true, expanded: false }

function loadStyle(): StoredStyle {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? 'null'
    ) as Partial<StoredStyle> | null
    if (!parsed || typeof parsed !== 'object') return EMPTY
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      negativePrompt: typeof parsed.negativePrompt === 'string' ? parsed.negativePrompt : '',
      enabled: parsed.enabled !== false,
      expanded: parsed.expanded === true
    }
  } catch {
    return EMPTY
  }
}

interface StyleState extends StoredStyle {
  patch: (patch: Partial<StoredStyle>) => void
}

export const useStyleStore = create<StyleState>((set, get) => ({
  ...loadStyle(),
  patch: (patch) => {
    set(patch)
    const { prompt, negativePrompt, enabled, expanded } = get()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ prompt, negativePrompt, enabled, expanded } satisfies StoredStyle)
    )
  }
}))

/** The style layer to send with a generation or roll preview; undefined when it is off or empty. */
export function styleForRequest(): StyleLayer | undefined {
  const { prompt, negativePrompt, enabled } = useStyleStore.getState()
  if (!enabled || (!prompt.trim() && !negativePrompt.trim())) return undefined
  return { prompt, negativePrompt }
}
