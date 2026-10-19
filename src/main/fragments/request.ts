import type { GenerationRequest } from '../../shared/types'
import { removeComments } from '../../shared/nai-presets'
import { processWildcards, type FragmentSource } from './processor'
import { composeFragmentSources, type SpreadsheetSource } from './spreadsheet'
import {
  extractVariableDefinitions,
  resolveVariableBlocks,
  rollVariables,
  type VariableDefinition
} from './variables'

export interface PreprocessOptions {
  /** External workbook (.xlsx) fragments, resolved as `<Sheet/Key>`. */
  sheets?: SpreadsheetSource | null
  /** Randomness source; tests inject a deterministic one. */
  rng?: () => number
}

/** Applies `fn` to every prompt text of a request, keeping the structure (and the merged prompt) intact. */
function mapRequestTexts(
  request: GenerationRequest,
  fn: (text: string) => string
): GenerationRequest {
  const parts = request.promptParts
    ? {
        base: fn(request.promptParts.base),
        additional: fn(request.promptParts.additional),
        detail: fn(request.promptParts.detail)
      }
    : undefined
  return {
    ...request,
    prompt: parts
      ? [parts.base, parts.additional, parts.detail].filter((part) => part.trim()).join(', ')
      : fn(request.prompt),
    negativePrompt: fn(request.negativePrompt),
    promptParts: parts,
    characterPrompts: request.characterPrompts.map((character) => ({
      ...character,
      prompt: fn(character.prompt),
      negativePrompt: fn(character.negativePrompt)
    }))
  }
}

/**
 * Fragment lines (saved fragments and spreadsheet cells) may themselves contain `${Var: ...}` blocks, for
 * example a "selector" fragment that holds the whole case list. Blocks are resolved on each line as it is
 * looked up, before that line is expanded, so they work at any nesting depth.
 */
function withVariableBlocks(
  source: FragmentSource,
  values: ReadonlyMap<string, string>,
  strict: boolean
): FragmentSource {
  return {
    getLines: (path) => {
      const lines = source.getLines(path)
      return lines ? lines.map((line) => resolveVariableBlocks(line, values, strict)) : lines
    }
  }
}

/**
 * Process each queued image once; split metadata and the transmitted prompt share the result.
 *
 * Order: strip comments -> collect `$Var = ...` definitions from every field and roll them once ->
 * resolve `${Var: ...}` blocks in every field, and in every fragment line as it is expanded ->
 * expand `<fragments>` / `<Sheet/Key>` / wildcards.
 * Comments go first so a commented-out line can neither define a variable nor consume a fragment.
 *
 * Throws (so the queue item fails with a readable message instead of spending Anlas on a broken prompt)
 * when a variable is undefined or a known sheet has no such key.
 */
export function preprocessRequest(
  request: GenerationRequest,
  source: FragmentSource,
  options: PreprocessOptions = {}
): GenerationRequest {
  const rng = options.rng ?? Math.random
  const fragments = composeFragmentSources(source, options.sheets, { strict: true })

  const definitions: VariableDefinition[] = []
  const stripped = mapRequestTexts(request, (text) =>
    extractVariableDefinitions(removeComments(text), definitions)
  )
  const values = rollVariables(definitions, { source: fragments, rng, strict: true })
  const expanding = withVariableBlocks(fragments, values, true)

  return mapRequestTexts(stripped, (text) =>
    processWildcards(resolveVariableBlocks(text, values, true), expanding, rng)
  )
}

/**
 * Deterministic, non-throwing substitution for token counts: variables take their first option,
 * fragments their first line, and sequential counters are left untouched. The texts are treated as one
 * prompt, so a variable defined in one field (say the main prompt) also resolves in the others.
 */
export function previewTexts(
  texts: string[],
  source: FragmentSource,
  sheets?: SpreadsheetSource | null
): string[] {
  const rng = (): number => 0
  const fragments = composeFragmentSources(source, sheets, { strict: false })
  const definitions: VariableDefinition[] = []
  const stripped = texts.map((text) =>
    extractVariableDefinitions(removeComments(text), definitions)
  )
  const values = rollVariables(definitions, { source: fragments, rng, strict: false })
  const expanding = withVariableBlocks(fragments, values, false)
  return stripped.map((text) =>
    processWildcards(resolveVariableBlocks(text, values, false), expanding, rng, true)
  )
}
