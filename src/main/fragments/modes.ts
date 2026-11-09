/**
 * Modes: named sets of prompt texts kept on a sheet called `modes` (in any workbook of the folder).
 *
 *   mode | main | main_neg | char_1 | char_1_neg | char_1_pos | ... | char_6 | char_6_neg | char_6_pos | size | note
 *
 * One row per mode. Picking a mode in the prompt panel fills the main prompt, the main negative and one character
 * box per non-empty char_N (positions from char_N_pos as "x, y" between 0 and 1, size as "832x1216").
 * Cells are copied as written, so they hold the same syntax as the prompt boxes ($name = ..., <Sheet/Key>, ${...}).
 * Optional columns: extends (inherit empty cells from another mode), set (lines added on top), hidden.
 *
 * Pure module (no Electron / fs).
 */

import type { DoujinPanels, PromptMode } from '../../shared/types'
import type { SpreadsheetSource } from './spreadsheet'

export const MODES_SHEET = 'modes'
export const MAX_MODE_CHARACTERS = 6

function position(text: string | undefined): { x: number; y: number } | undefined {
  const match = /^\s*(\d*\.?\d+)\s*[,;\s]\s*(\d*\.?\d+)\s*$/.exec(text ?? '')
  if (!match) return undefined
  const clamp = (value: number): number => Math.min(1, Math.max(0, value))
  return { x: clamp(Number(match[1])), y: clamp(Number(match[2])) }
}

function size(text: string | undefined): { width: number; height: number } | undefined {
  const match = /^\s*(\d{3,4})\s*[x×*,]\s*(\d{3,4})\s*$/i.exec(text ?? '')
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined
}

/** Cell value that means "empty here", so an extending mode can clear a cell it would otherwise inherit. */
const CLEARED = '-'
const MAX_EXTENDS_DEPTH = 8

function isHidden(text: string): boolean {
  return /^\s*(1|yes|y|true|x|hidden)\s*$/i.test(text)
}

/**
 * The `set` lines of a row and of every row it extends, outermost first. A `$name = …` / `$name := …` line of a
 * row replaces the same name's line from the rows it extends, so a child can change what its parent fixed.
 */
function setLines(
  row: { fields: ReadonlyMap<string, string> },
  byName: ReadonlyMap<string, { fields: ReadonlyMap<string, string> }>
): string {
  const chain: string[] = []
  let current: typeof row | undefined = row
  for (let depth = 0; current && depth <= MAX_EXTENDS_DEPTH; depth++) {
    const own = (current.fields.get('set') ?? '').trim()
    if (own && own !== CLEARED) chain.unshift(own)
    const parent = (current.fields.get('extends') ?? '').trim().toLowerCase()
    current = parent ? byName.get(parent) : undefined
  }
  const lines: string[] = []
  const definedAt = new Map<string, number>()
  for (const line of chain.join('\n').split('\n')) {
    const name = /^\s*\$([\p{L}_][\p{L}\p{N}_]*)\s*:?=/u.exec(line)?.[1]?.toLowerCase()
    if (name !== undefined && definedAt.has(name)) {
      lines[definedAt.get(name)!] = line
      continue
    }
    if (name !== undefined) definedAt.set(name, lines.length)
    lines.push(line)
  }
  return lines.join('\n').trim()
}

/**
 * Every mode row of every `modes` sheet, in file and row order.
 *
 * - `extends`: the name of another mode on the same sheet. Every empty cell of this row takes that mode's value
 *   (chains are followed); a cell holding just `-` stays empty.
 * - `set`: lines added at the top of the main prompt, typically `$name := value` overrides of the inherited
 *   definitions. Set lines are inherited too; a row's line for a name replaces its parent's line for it.
 * - `hidden`: 1 / yes keeps the row out of the mode list (a base that other modes extend).
 */
export function readModes(sheets: SpreadsheetSource | null | undefined): PromptMode[] {
  return readPromptRows(sheets, MODES_SHEET)
}

/** Name of the sheet that holds a doujin's panels (one workbook file per doujin). */
export const PANELS_SHEET = 'panels'

/**
 * Doujin panels: every `panels` sheet, one per workbook file (the file name is the doujin's name). Rows use the
 * modes columns (main, main_neg, char_N, char_N_neg, char_N_pos, size, extends, set, hidden, note); column A is
 * the panel's name. Rows are the panels in reading order; a hidden row can hold what every panel extends.
 */
export function readPanels(sheets: SpreadsheetSource | null | undefined): DoujinPanels[] {
  if (!sheets || sheets.unavailableReason !== undefined) return []
  return sheets.sheetsNamed(PANELS_SHEET).map(({ qualified, file }) => ({
    doujin: file ?? PANELS_SHEET,
    panels: readPromptRows(sheets, qualified, true)
  }))
}

function readPromptRows(
  sheets: SpreadsheetSource | null | undefined,
  sheetName: string,
  exact = false
): PromptMode[] {
  if (!sheets || sheets.unavailableReason !== undefined) return []
  const modes: PromptMode[] = []
  const targets = exact
    ? [
        {
          qualified: sheetName,
          file: sheetName.includes(':') ? sheetName.slice(0, sheetName.indexOf(':')) : undefined
        }
      ]
    : sheets.sheetsNamed(sheetName)
  for (const { qualified, file } of targets) {
    const rows = sheets.getRows(qualified, '*') ?? []
    const byName = new Map(rows.map((row) => [row.key.trim().toLowerCase(), row]))
    for (const row of rows) {
      const field = (name: string): string => {
        let current: typeof row | undefined = row
        for (let depth = 0; current && depth <= MAX_EXTENDS_DEPTH; depth++) {
          const value = current.fields.get(name) ?? ''
          if (value.trim() === CLEARED) return ''
          if (value.trim()) return value
          const parent = (current.fields.get('extends') ?? '').trim().toLowerCase()
          current = parent ? byName.get(parent) : undefined
        }
        return ''
      }
      if (isHidden(row.fields.get('hidden') ?? '')) continue
      const characters: PromptMode['characters'] = []
      for (let i = 1; i <= MAX_MODE_CHARACTERS; i++) {
        const prompt = field(`char_${i}`)
        if (!prompt.trim()) continue
        const center = position(field(`char_${i}_pos`))
        characters.push({
          prompt,
          negativePrompt: field(`char_${i}_neg`),
          ...(center ? { center } : {})
        })
      }
      const dimensions = size(field('size'))
      const set = setLines(row, byName)
      const main = field('main')
      modes.push({
        id: file ? `${file}:${row.key}` : row.key,
        name: row.key,
        ...(file ? { file } : {}),
        row: row.row,
        prompt: set ? `${set}\n${main}` : main,
        negativePrompt: field('main_neg') || field('negative'),
        characters,
        ...(dimensions ? { size: dimensions } : {}),
        ...(field('note') ? { note: field('note') } : {})
      })
    }
  }
  return modes
}
