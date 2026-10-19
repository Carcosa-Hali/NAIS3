import type { GenerationRequest } from '../../shared/types'
import { removeComments } from '../../shared/nai-presets'
import { processWildcards, type FragmentSource } from './processor'
import { composeFragmentSources, type SpreadsheetSource } from './spreadsheet'
import {
  BlockStore,
  extractVariableDefinitions,
  PromptVariableError,
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
 * Two-step substitution shared by generation and the token preview.
 *
 *   collect(text) for every prompt text: strip comments, set `${...}` blocks aside, collect `$Var = ...`
 *   definitions, expand `<fragments>` / `<Sheet/Key>` / wildcards. Fragment lines and sheet cells are treated like
 *   prompt text: only the line (cell) that was actually picked contributes its definitions and blocks.
 *   roll()        roll every collected definition once.
 *   finish(text)  for every prompt text: resolve the set-aside blocks (their chosen branch is expanded, which may bring
 *                 in more fragment lines containing blocks).
 *
 * Blocks therefore see definitions from anywhere in the request, in any order, including from fragments and cells.
 */
function createPipeline(
  fragments: FragmentSource,
  rng: () => number,
  strict: boolean,
  peek: boolean
): {
  collect: (text: string) => string
  roll: () => void
  finish: (text: string) => string
} {
  const store = new BlockStore()
  const definitions: VariableDefinition[] = []
  let values: ReadonlyMap<string, string> | null = null

  const hold = (text: string): string =>
    extractVariableDefinitions(store.mask(text, strict), definitions)

  const expanding: FragmentSource = {
    getLines: (path) => fragments.getLines(path),
    select: (line) => {
      const known = definitions.length
      const kept = hold(line)
      if (values !== null && definitions.length > known) {
        // Variables are already rolled, so a definition that only turns up inside a chosen variable branch is too late.
        definitions.length = known
        if (strict) {
          throw new PromptVariableError(
            'A "$name = ..." definition inside a ${...} branch cannot be used. Put it in the prompt, or in a fragment/cell used outside ${...} blocks.'
          )
        }
      }
      return kept
    }
  }

  return {
    collect: (text) => processWildcards(hold(removeComments(text)), expanding, rng, peek),
    roll: () => {
      values = rollVariables(definitions, { source: fragments, rng, strict })
    },
    finish: (text) =>
      store.resolve(text, values ?? new Map(), strict, (branch) =>
        processWildcards(branch, expanding, rng, peek)
      )
  }
}

/**
 * Process each queued image once; split metadata and the transmitted prompt share the result.
 *
 * Comments go first so a commented-out line can neither define a variable nor consume a fragment.
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
  const pipeline = createPipeline(fragments, rng, true, false)

  const collected = mapRequestTexts(request, pipeline.collect)
  pipeline.roll()
  return mapRequestTexts(collected, pipeline.finish)
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
  const fragments = composeFragmentSources(source, sheets, { strict: false })
  const pipeline = createPipeline(fragments, () => 0, false, true)

  const collected = texts.map(pipeline.collect)
  pipeline.roll()
  return collected.map(pipeline.finish)
}
