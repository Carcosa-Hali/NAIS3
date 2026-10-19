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
 * Pure module (no Electron / fs).
 */

import { normalizeFragmentPath } from '../../shared/fragment-path'
import type { FragmentSource } from './processor'

const NAME = String.raw`[\p{L}_][\p{L}\p{N}_]*`
const DEFINITION_LINE = new RegExp(String.raw`^\s*\$(${NAME})\s*=\s*(.*?)\s*$`, 'u')
const BLOCK_BODY = new RegExp(String.raw`^\s*(${NAME})\s*(?::([\s\S]*))?$`, 'u')
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
}

/** Pulls `$Name = ...` lines out of `text`, appending them to `into`. Returns the remaining text. */
export function extractVariableDefinitions(text: string, into: VariableDefinition[]): string {
  if (!text.includes('$')) return text
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const match = DEFINITION_LINE.exec(line)
    if (match) into.push({ name: match[1], expression: match[2] })
    else kept.push(line)
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
  /** Resolves `<name>` / `<Sheet/Key>` inside random(...). */
  source: FragmentSource
  rng: () => number
  /** true: problems throw PromptVariableError (generation). false: problems yield an empty value (previews). */
  strict: boolean
}

function fail(strict: boolean, message: string): void {
  if (strict) throw new PromptVariableError(message)
}

function expandPool(args: string, options: RollOptions): string[] {
  const pool: string[] = []
  for (const raw of splitTopLevel(args, ',')) {
    const arg = raw.trim()
    if (!arg) continue
    const reference = /^<([^<>]+)>$/.exec(arg)
    if (!reference) {
      pool.push(arg)
      continue
    }
    const lines = options.source.getLines(normalizeFragmentPath(reference[1]))
    if (lines && lines.length > 0) pool.push(...lines.map((line) => line.trim()).filter(Boolean))
    else fail(options.strict, `random(): <${reference[1].trim()}> has no entries.`)
  }
  return pool
}

/** Rolls every definition once. Variable names are case-insensitive. */
export function rollVariables(
  definitions: VariableDefinition[],
  options: RollOptions
): Map<string, string> {
  const values = new Map<string, string>()
  for (const { name, expression } of definitions) {
    const id = name.toLowerCase()
    if (values.has(id)) {
      fail(options.strict, `Variable "${name}" is defined more than once.`)
      continue
    }
    const random = /^random\s*\(([\s\S]*)\)$/i.exec(expression)
    if (!random) {
      if (!expression) fail(options.strict, `Variable "${name}" has no value.`)
      values.set(id, expression)
      continue
    }
    const pool = expandPool(random[1], options)
    if (pool.length === 0) fail(options.strict, `Variable "${name}": random() has no options.`)
    values.set(id, pool.length > 0 ? pool[Math.floor(options.rng() * pool.length)] : '')
  }
  return values
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
function tidyCommas(text: string): string {
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
    fail(
      strict,
      `Variable "${name}" is not defined (add a line like "$${name} = random(A, B, C)").`
    )
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
