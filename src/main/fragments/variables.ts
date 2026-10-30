/**
 * Shared prompt variables.
 *
 * Define once, anywhere in any prompt field (main, negative, character, character negative):
 *
 *   $Location = random(WEDDING, PARTY, PERFORMANCE)
 *   $Location = random(<Venues/Event types>)        <- every column-B row of that key (or a saved fragment)
 *
 * The value is rolled once per generated image and is the same in every field. Use it with:
 *
 *   ${Location}                                      -> the rolled value
 *   ${Location: WEDDING => church, altar | PARTY => balloons | * => plain room}
 *
 * Branches are separated by `|`, labels by `,` (any of them matches), `*` is the default, and a branch body may
 * contain `<fragments>`, `<Sheet/Key>` and nested `${...}` blocks. No matching branch and no `*` -> nothing.
 * Names and labels are case-insensitive. `$Name = ...` lines are removed from the prompt before it is sent.
 *
 * More forms:
 *
 *   $Mood = random(calm @3, tense @1)                -> " @n" sets an option's relative weight (default 1)
 *   $Place = row(<Sheet/Key>)                        -> picks one row; ${Place} = its column B,
 *                                                       ${Place.header_name} = any other column of that row
 *   $Place = row(<*Sheet/Key>)                       -> walks the rows in order instead
 *   $Mood := calm                                    -> fixed value: wins over every "=" definition of Mood
 *   <Sheet/${Place.category}_${Mood} ?? Sheet/default>  -> references may use variables (looked up after rolling)
 *
 * Definitions are rolled in the order they were collected, so an expression may use `${...}` of a variable
 * defined before it (e.g. `$Outfit = random(<Outfits/${Place.category}>)`).
 *
 * Pure module (no Electron / fs).
 */

import type { RolledVariable } from '../../shared/types'
import {
  lookupAlternatives,
  nextSequentialIndex,
  pickWeighted,
  splitWeight,
  type FragmentEntry,
  type FragmentSource
} from './processor'

const NAME = String.raw`[\p{L}_][\p{L}\p{N}_]*`
const DEFINITION_LINE = new RegExp(String.raw`^\s*\$(${NAME})\s*(:=|=)\s*(.*?)\s*$`, 'u')
/** `name` or `name.field` (a column of a row() variable). */
const BLOCK_BODY = new RegExp(
  String.raw`^\s*(${NAME}(?:\.[\p{L}\p{N}_]+)?)\s*(?::([\s\S]*))?$`,
  'u'
)
const REFERENCE = /^<\s*(\*)?([^<>]*)>$/
const MAX_DEPTH = 10

export class PromptVariableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptVariableError'
  }
}

export interface VariableDefinition {
  name: string
  expression: string
  /** `$Name := ...`: overrides every ordinary definition of the same name. */
  fixed?: boolean
}

export type { RolledVariable }

/** Pulls `$Name = ...` / `$Name := ...` lines out of `text`, appending them to `into`. Returns the remaining text. */
export function extractVariableDefinitions(text: string, into: VariableDefinition[]): string {
  if (!text.includes('$')) return text
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const match = DEFINITION_LINE.exec(line)
    if (match) {
      into.push(
        match[2] === ':='
          ? { name: match[1], expression: match[3], fixed: true }
          : { name: match[1], expression: match[3] }
      )
    } else kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Indexes of `separator` outside any (), [], {} and outside `<fragment>` references.
 * `<...>` is only skipped when it looks like a fragment reference, so a stray "<" is just text.
 */
function topLevelIndexes(text: string, separator: string): number[] {
  const found: number[] = []
  const closers: string[] = []
  const closeFor: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '<') {
      const reference = /^<[^<>]*>/.exec(text.slice(i))
      if (reference) {
        i += reference[0].length - 1
        continue
      }
    }
    if (closeFor[char]) {
      closers.push(closeFor[char])
      continue
    }
    if (closers.length > 0 && char === closers[closers.length - 1]) {
      closers.pop()
      continue
    }
    if (closers.length === 0 && text.startsWith(separator, i)) {
      found.push(i)
      i += separator.length - 1
    }
  }
  return found
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let start = 0
  for (const index of topLevelIndexes(text, separator)) {
    parts.push(text.slice(start, index))
    start = index + separator.length
  }
  parts.push(text.slice(start))
  return parts
}

export interface RollOptions {
  /** Resolves `<name>` / `<Sheet/Key>` inside random(...) and row(...). */
  source: FragmentSource
  rng: () => number
  /** true: problems throw PromptVariableError (generation). false: problems yield an empty value (previews). */
  strict: boolean
  /** true: `row(<*...>)` reads its next row without advancing the walk (previews). */
  peek?: boolean
  /** Prepares an expression before it is evaluated (resolves `${...}` of variables rolled so far). */
  prepare?: (expression: string, values: ReadonlyMap<string, string>) => string
  /** Receives every rolled variable, in rolling order. */
  record?: (variable: RolledVariable) => void
}

function fail(strict: boolean, message: string): void {
  if (strict) throw new PromptVariableError(message)
}

/** Key under which a row() variable's column names are kept, for error messages. Cannot clash with a name. */
const columnsKey = (id: string): string => `${id}.`

interface PoolItem {
  text: string
  weight: number
  lock: string
  from?: { path: string; entry: FragmentEntry }
}

function referenceLock(path: string, entry: FragmentEntry): string {
  return entry.row !== undefined ? `<${path}#${entry.row}>` : `<${path}>`
}

function expandPool(args: string, options: RollOptions, name: string): PoolItem[] {
  const pool: PoolItem[] = []
  for (const raw of splitTopLevel(args, ',')) {
    const { text: arg, weight } = splitWeight(raw)
    if (!arg || weight <= 0) continue
    const reference = REFERENCE.exec(arg)
    if (!reference || reference[1]) {
      pool.push({ text: arg, weight, lock: arg })
      continue
    }
    const found = lookupAlternatives(options.source, reference[2].split('??'), (entries) =>
      entries.some((entry) => entry.line.trim())
    )
    if (found === null) continue // `<A ?? >`: nothing
    const entries = found.entries?.filter((entry) => entry.line.trim()) ?? []
    if (entries.length === 0) {
      fail(options.strict, `Variable "${name}": random(): <${reference[2].trim()}> has no entries.`)
      continue
    }
    for (const entry of entries) {
      pool.push({
        text: entry.line.trim(),
        weight: weight * entry.weight,
        lock: `random(${referenceLock(found.path, entry)})`,
        from: { path: found.path, entry }
      })
    }
  }
  return pool
}

interface PickedRow {
  path: string
  entry: FragmentEntry
}

/** row(<Sheet/Key>): one row, following a picked cell that is only another reference (`<Other/Key>`). */
function pickRow(argument: string, options: RollOptions, name: string): PickedRow | null {
  let reference = REFERENCE.exec(argument.trim())
  if (!reference) {
    fail(options.strict, `Variable "${name}": row() takes one reference, like row(<Sheet/Key>).`)
    return null
  }
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    const sequential = Boolean(reference[1])
    const found = lookupAlternatives(options.source, reference[2].split('??'))
    if (found === null) return null // `<A ?? >`: nothing
    const entries = found.entries ?? []
    if (entries.length === 0) {
      fail(options.strict, `Variable "${name}": row(): <${reference[2].trim()}> has no rows.`)
      return null
    }
    const entry = sequential
      ? entries[nextSequentialIndex(found.path, entries.length, options.peek === true)]
      : entries[
          pickWeighted(
            entries.map((e) => e.weight),
            options.rng
          )
        ]
    options.source.onPick?.(found.path, entry)

    // A cell holding nothing but another sheet reference (an index sheet pointing at the real rows): follow it.
    const inner = REFERENCE.exec(entry.line.trim())
    if (!inner || inner[2].includes('|') || !inner[2].includes('/')) {
      return { path: found.path, entry }
    }
    reference = inner
  }
  fail(options.strict, `Variable "${name}": row() references are nested too deeply.`)
  return null
}

function evaluate(
  name: string,
  expression: string,
  options: RollOptions
): { value: string; lock: string; fields?: ReadonlyMap<string, string> } {
  const random = /^random\s*\(([\s\S]*)\)$/i.exec(expression)
  if (random) {
    const pool = expandPool(random[1], options, name)
    if (pool.length === 0) {
      fail(options.strict, `Variable "${name}": random() has no options.`)
      return { value: '', lock: '' }
    }
    const item =
      pool[
        pickWeighted(
          pool.map((p) => p.weight),
          options.rng
        )
      ]
    if (item.from) options.source.onPick?.(item.from.path, item.from.entry)
    return { value: item.text, lock: item.lock }
  }

  const row = /^row\s*\(([\s\S]*)\)$/i.exec(expression)
  if (row) {
    const picked = pickRow(row[1], options, name)
    if (!picked) return { value: '', lock: '', fields: new Map() }
    return {
      value: picked.entry.line,
      lock: `row(${referenceLock(picked.path, picked.entry)})`,
      fields: picked.entry.fields ?? new Map()
    }
  }

  if (!expression) fail(options.strict, `Variable "${name}" has no value.`)
  return { value: expression, lock: expression }
}

/**
 * Rolls every definition once, in order (fixed `:=` definitions first). Variable names are case-insensitive.
 * A row() variable also sets `name.field` for every column of its row.
 */
export function rollVariables(
  definitions: VariableDefinition[],
  options: RollOptions
): Map<string, string> {
  const values = new Map<string, string>()
  const fixed = new Set<string>()
  const seen = new Set<string>()
  const ordered: VariableDefinition[] = []

  for (const definition of definitions) {
    if (!definition.fixed) continue
    const id = definition.name.toLowerCase()
    if (fixed.has(id)) {
      fail(options.strict, `Variable "${definition.name}" is fixed (:=) more than once.`)
      continue
    }
    fixed.add(id)
    ordered.push(definition)
  }
  for (const definition of definitions) {
    if (definition.fixed) continue
    const id = definition.name.toLowerCase()
    if (seen.has(id) && !fixed.has(id)) {
      fail(options.strict, `Variable "${definition.name}" is defined more than once.`)
      continue
    }
    seen.add(id)
    if (!fixed.has(id)) ordered.push(definition)
  }

  for (const { name, expression } of ordered) {
    const id = name.toLowerCase()
    let prepared = expression
    if (options.prepare) {
      try {
        prepared = options.prepare(expression, values)
      } catch (error) {
        if (error instanceof PromptVariableError) {
          throw new PromptVariableError(
            `In "$${name} = ${expression.slice(0, 60)}": ${error.message} Definitions are rolled in order, so an expression can only use variables defined before it.`
          )
        }
        throw error
      }
    }
    const result = evaluate(name, prepared.trim(), options)
    values.set(id, result.value)
    if (result.fields) {
      for (const [field, text] of result.fields) values.set(`${id}.${field}`, text)
      values.set(columnsKey(id), [...result.fields.keys()].join(', '))
    }
    options.record?.({ name, value: result.value, lock: result.lock })
  }
  return values
}

/**
 * Index of the ">" closing a `<reference>` that starts at `open`, or -1 when it is not a reference.
 * `${...}` blocks inside it are skipped, so their `=>` arrows do not end the reference.
 */
function findReferenceEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text.startsWith('${', i)) {
      const end = findBlockEnd(text, i + 1)
      if (end < 0) return -1
      i = end
      continue
    }
    if (text[i] === '<' || text[i] === '\n') return -1
    if (text[i] === '>') return i
  }
  return -1
}

/** Index of the "}" closing the "{" at `open`, or -1. */
function findBlockEnd(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** Blocks that resolve to nothing leave stray commas ("a, , b"); clean those lines up. */
export function tidyCommas(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/(?:\s*,){2,}/g, ',')
        .replace(/^\s*,\s*/, '')
        .replace(/\s*,\s*$/, '')
    )
    .join('\n')
}

/**
 * Holds `${...}` blocks that were set aside while fragments were expanded. A block is replaced in the text by a
 * placeholder made of two private-use characters, so fragment expansion never touches (or half-expands) its
 * branches; the chosen branch is expanded later, once every `$Var = ...` definition in the request is known.
 */
export class BlockStore {
  private readonly blocks: string[] = []

  /**
   * Replaces each top-level `${...}` block, and each `<reference>` that contains a `${...}` block, with a
   * placeholder. An unclosed block is an error (strict) or left as text.
   */
  mask(text: string, strict: boolean): string {
    if (!text.includes('${')) return text
    let out = ''
    let i = 0
    while (i < text.length) {
      if (text.startsWith('${', i)) {
        const end = findBlockEnd(text, i + 1)
        if (end < 0) {
          fail(strict, `Unclosed "\${" near: ${text.slice(i, i + 40)}`)
          out += text.slice(i)
          break
        }
        out += this.hold(text.slice(i, end + 1))
        i = end + 1
        continue
      }
      if (text[i] === '<') {
        const end = findReferenceEnd(text, i)
        if (end > 0) {
          const reference = text.slice(i, end + 1)
          out += reference.includes('${') ? this.hold(reference) : reference
          i = end + 1
          continue
        }
      }
      out += text[i]
      i++
    }
    return out
  }

  /** Puts the original text of every placeholder back (for definition expressions). */
  restore(text: string): string {
    return text.replace(PLACEHOLDER, (_match, index: string) => this.blocks[Number(index)] ?? '')
  }

  private hold(text: string): string {
    return `${OPEN}${this.blocks.push(text) - 1}${CLOSE}`
  }

  /**
   * Resolves every placeholder in `text`. The chosen branch goes through `expand` (fragments, wildcards), which may
   * itself bring in new placeholders from fragment lines; those are resolved in the next round.
   */
  resolve(
    text: string,
    values: ReadonlyMap<string, string>,
    strict: boolean,
    expand: (branch: string) => string
  ): string {
    let current = text
    let emptied = false
    for (let round = 0; current.includes(OPEN); round++) {
      if (round > MAX_DEPTH) {
        fail(strict, 'Variable blocks are nested too deeply.')
        return current.replace(PLACEHOLDER, '')
      }
      current = current.replace(PLACEHOLDER, (_match, index: string) => {
        const block = this.blocks[Number(index)] ?? ''
        const result = expand(resolveVariableBlocks(block, values, strict))
        if (result.trim() === '') emptied = true
        return result
      })
    }
    return emptied ? tidyCommas(current) : current
  }
}

const OPEN = ''
const CLOSE = ''
const PLACEHOLDER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g')

/** Replaces every `${...}` block in `text` using the rolled `values`. */
export function resolveVariableBlocks(
  text: string,
  values: ReadonlyMap<string, string>,
  strict: boolean
): string {
  if (!text.includes('${')) return text
  const state = { emptied: false }
  const result = resolveInner(text, values, strict, state, 0)
  return state.emptied ? tidyCommas(result) : result
}

function resolveInner(
  text: string,
  values: ReadonlyMap<string, string>,
  strict: boolean,
  state: { emptied: boolean },
  depth: number
): string {
  if (depth > MAX_DEPTH) {
    fail(strict, 'Variable blocks are nested too deeply.')
    return text
  }
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('${', cursor)
    if (start < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start)
    const end = findBlockEnd(text, start + 1)
    if (end < 0) {
      fail(strict, `Unclosed "\${" near: ${text.slice(start, start + 40)}`)
      out += text.slice(start)
      break
    }
    const replacement = evaluateBlock(text.slice(start + 2, end), values, strict, state, depth)
    if (replacement.trim() === '') state.emptied = true
    out += replacement
    cursor = end + 1
  }
  return out
}

function evaluateBlock(
  inner: string,
  values: ReadonlyMap<string, string>,
  strict: boolean,
  state: { emptied: boolean },
  depth: number
): string {
  const parsed = BLOCK_BODY.exec(inner)
  if (!parsed) {
    fail(strict, `Invalid variable block "\${${inner.slice(0, 40)}}".`)
    return ''
  }
  const [, name, branchText] = parsed
  const value = values.get(name.toLowerCase())
  if (value === undefined) {
    const dot = name.indexOf('.')
    const owner = dot > 0 ? name.slice(0, dot).toLowerCase() : null
    const columns = owner !== null ? values.get(columnsKey(owner)) : undefined
    if (columns !== undefined) {
      fail(
        strict,
        `"${name}": the row picked for "${name.slice(0, dot)}" has no column "${name.slice(dot + 1)}". Columns: ${columns || '(none)'}.`
      )
    } else if (owner !== null && values.has(owner)) {
      fail(strict, `"${name}": "${name.slice(0, dot)}" is not a row(...) variable.`)
    } else {
      fail(
        strict,
        `Variable "${name}" is not defined (add a line like "$${name} = random(A, B, C)").`
      )
    }
    return ''
  }
  if (branchText === undefined) return value

  const current = value.trim().toLowerCase()
  let fallback: string | null = null
  for (const branch of splitTopLevel(branchText, '|')) {
    if (!branch.trim()) continue
    const arrow = topLevelIndexes(branch, '=>')[0]
    if (arrow === undefined) {
      fail(strict, `Branch "${branch.trim().slice(0, 40)}" in \${${name}: ...} needs "=>".`)
      continue
    }
    const labels = splitTopLevel(branch.slice(0, arrow), ',').map((label) =>
      label.trim().toLowerCase()
    )
    const body = branch.slice(arrow + 2).trim()
    if (labels.includes(current)) return resolveInner(body, values, strict, state, depth + 1)
    if (labels.includes('*') && fallback === null) fallback = body
  }
  return fallback === null ? '' : resolveInner(fallback, values, strict, state, depth + 1)
}
