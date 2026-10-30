import type { GenerationRequest } from '../../shared/types'
import { removeComments } from '../../shared/nai-presets'
import type { RollPreviewResult, RollPick } from '../../shared/types'
import { processWildcards, type FragmentEntry, type FragmentSource } from './processor'
import { composeFragmentSources, type SpreadsheetSource } from './spreadsheet'
import {
  BlockStore,
  extractVariableDefinitions,
  PromptVariableError,
  resolveVariableBlocks,
  rollVariables,
  type RolledVariable,
  type VariableDefinition
} from './variables'

export interface PreprocessOptions {
  /** External workbook (.xlsx) fragments, resolved as `<Sheet/Key>`. */
  sheets?: SpreadsheetSource | null
  /** Randomness source; tests inject a deterministic one. */
  rng?: () => number
}

const PICK_TEXT_LIMIT = 160

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
 * Two-step substitution shared by generation, the roll preview and the token preview.
 *
 *   collect(text) for every prompt text: strip comments, set `${...}` blocks (and references that contain one)
 *                 aside, collect `$Var = ...` definitions, expand `<fragments>` / `<Sheet/Key>` / wildcards.
 *                 Fragment lines and sheet cells are treated like prompt text: only the line (cell) that was
 *                 actually picked contributes its definitions and blocks.
 *   roll()        roll every collected definition once, in order (a definition may use `${...}` of earlier ones).
 *   finish(text)  for every prompt text: resolve the set-aside blocks (their chosen branch is expanded, which may
 *                 bring in more fragment lines containing blocks).
 *
 * Blocks therefore see definitions from anywhere in the request, in any order, including from fragments and cells.
 */
function createPipeline(
  fragments: FragmentSource,
  rng: () => number,
  strict: boolean,
  peek: boolean,
  onPick?: (path: string, entry: FragmentEntry) => void
): {
  collect: (text: string) => string
  roll: () => RolledVariable[]
  finish: (text: string) => string
} {
  const store = new BlockStore()
  const definitions: VariableDefinition[] = []
  let values: ReadonlyMap<string, string> | null = null

  const hold = (text: string): string =>
    extractVariableDefinitions(store.mask(text, strict), definitions)

  /** Prompt text that enters the pipeline after variables were rolled (a picked line, a chosen branch). */
  const admit = (line: string): string => {
    const known = definitions.length
    const kept = hold(line)
    if (values !== null && definitions.length > known) {
      // Variables are already rolled, so a definition that only turns up now is too late.
      definitions.length = known
      if (strict) {
        throw new PromptVariableError(
          'A "$name = ..." definition was found in text that is only reached after variables are rolled (inside a ${...} branch, a row column, or a reference that uses ${...}). Put it in the prompt, or in a fragment/cell used outside ${...} blocks.'
        )
      }
    }
    return kept
  }

  const lookup: FragmentSource = {
    getLines: (path) => fragments.getLines(path),
    getEntries: fragments.getEntries ? (path) => fragments.getEntries!(path) : undefined,
    onPick
  }
  const expanding: FragmentSource = { ...lookup, select: admit }

  return {
    collect: (text) => processWildcards(hold(removeComments(text)), expanding, rng, peek),
    roll: () => {
      const rolled: RolledVariable[] = []
      values = rollVariables(definitions, {
        source: lookup,
        rng,
        strict,
        peek,
        prepare: (expression, known) =>
          resolveVariableBlocks(store.restore(expression), known, strict),
        record: (variable) => rolled.push(variable)
      })
      return rolled
    },
    finish: (text) =>
      store.resolve(text, values ?? new Map(), strict, (branch) =>
        processWildcards(admit(branch), expanding, rng, peek)
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
  const variables = pipeline.roll()
  const finished = mapRequestTexts(collected, pipeline.finish)
  return variables.length > 0 ? { ...finished, rolledVariables: variables } : finished
}

export interface RollPreviewInput {
  prompt: string
  negativePrompt: string
  characters: { prompt: string; negativePrompt: string }[]
}

/**
 * One real random roll of the prompts without generating: the final texts, every variable's value and every
 * fragment / sheet row that was picked. Errors are reported instead of thrown, and `<*...>` walks are not advanced.
 */
export function rollPreview(
  input: RollPreviewInput,
  source: FragmentSource,
  sheets?: SpreadsheetSource | null,
  rng: () => number = Math.random
): RollPreviewResult {
  const picks: RollPick[] = []
  const record = (path: string, entry: FragmentEntry): void => {
    const text = entry.line.replace(/\s+/g, ' ').trim()
    picks.push({
      path,
      ...(entry.row !== undefined ? { row: entry.row } : {}),
      text: text.length > PICK_TEXT_LIMIT ? `${text.slice(0, PICK_TEXT_LIMIT)}…` : text
    })
  }
  let variables: RolledVariable[] = []
  try {
    const fragments = composeFragmentSources(source, sheets, { strict: true })
    const pipeline = createPipeline(fragments, rng, true, true, record)
    const texts = [
      input.prompt,
      input.negativePrompt,
      ...input.characters.flatMap((c) => [c.prompt, c.negativePrompt])
    ]
    const collected = texts.map(pipeline.collect)
    variables = pipeline.roll()
    const [prompt, negativePrompt, ...rest] = collected.map(pipeline.finish)
    return {
      ok: true,
      prompt,
      negativePrompt,
      characters: input.characters.map((_c, i) => ({
        prompt: rest[i * 2],
        negativePrompt: rest[i * 2 + 1]
      })),
      variables,
      picks
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      variables,
      picks
    }
  }
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
