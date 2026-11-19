/**
 * Data for the controls panel.
 *
 * - readControls: the optional `controls` sheet (in any workbook of the folder), one row per variable:
 *     variable | label | group | input | choices | show | weights | filters | open | hidden | note
 *   `filters` lists the columns the panel offers as filters for a row() / deal() variable; `hidden` (1 / yes)
 *   moves the variable to the advanced list. Variables without a row are shown in the advanced list.
 *   `input` (pick / filter / both), `choices` (reference(s) whose rows are the entries), `show` (label columns),
 *   `weights` (no = no weight boxes) and `open` (start opened) shape the control; all optional.
 * - controlChoices: the rows of a control's `choices` reference(s), as tickable entries.
 * - sheetColumnValues: every column of a sheet with its distinct values and how many rows have each, for the
 *   filter picker. A column with comma lists in its cells is offered as a list column (matched with `~=`).
 *
 * - workbookOutline: every sheet with its keys and columns (prompt editor completion).
 *
 * Pure module (no Electron / fs).
 */

import type {
  ControlChoice,
  ControlRow,
  SheetColumnValues,
  WorkbookOutline
} from '../../shared/types'
import type { SpreadsheetSource } from './spreadsheet'

export const CONTROLS_SHEET = 'controls'
const MAX_VALUES = 300
const MAX_VALUE_LENGTH = 60

const isYes = (text: string): boolean => /^\s*(1|yes|y|true|x|hidden)\s*$/i.test(text)
const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

export function readControls(sheets: SpreadsheetSource | null | undefined): ControlRow[] {
  if (!sheets || sheets.unavailableReason !== undefined) return []
  const out: ControlRow[] = []
  for (const { qualified } of sheets.sheetsNamed(CONTROLS_SHEET)) {
    for (const row of sheets.getRows(qualified, '*') ?? []) {
      const field = (name: string): string => (row.fields.get(name) ?? '').trim()
      const variable = row.key.trim().replace(/^\$/, '')
      if (!variable) continue
      const input = field('input').toLowerCase()
      const weights = field('weights')
      out.push({
        variable,
        label: field('label') || variable,
        group: field('group'),
        filters: splitList(field('filters')),
        hidden: isYes(field('hidden')) || input === 'hidden' || input === 'none',
        note: field('note'),
        ...(input === 'pick' || input === 'filter' || input === 'both' ? { input } : {}),
        ...(field('choices') ? { choices: field('choices') } : {}),
        ...(field('show') ? { show: splitList(field('show')).map(fieldName) } : {}),
        ...(weights ? { weights: !/^\s*(0|no|n|false)\s*$/i.test(weights) } : {}),
        ...(isYes(field('open')) ? { open: true } : {})
      })
    }
  }
  return out
}

/** A header name as a field name (`Outfit Category` -> `outfit_category`), like the spreadsheet reader does. */
const fieldName = (header: string): string =>
  header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const MAX_CHOICES = 20000

/**
 * Every row of a control's `choices`: one or more references (`<acts/*[random=yes]>`, `<locations/*> <media/*>`).
 * Each row is an entry pinned by its own key and row number; `show` names the columns of its label.
 */
export function controlChoices(
  sheets: SpreadsheetSource | null | undefined,
  choices: string,
  show: string[]
): ControlChoice[] {
  if (!sheets || sheets.unavailableReason !== undefined) return []
  const out: ControlChoice[] = []
  const seen = new Set<string>()
  for (const match of choices.matchAll(/<([^<>]+)>/g)) {
    const path = match[1].trim()
    const slash = path.indexOf('/')
    if (slash <= 0) continue
    const sheet = path.slice(0, slash).trim()
    const key = path.slice(slash + 1).trim()
    let rows: ReturnType<SpreadsheetSource['getRows']> = null
    try {
      rows = sheets.getRows(sheet, key)
    } catch {
      rows = null
    }
    for (const row of rows ?? []) {
      if (row.weight <= 0 && key.startsWith('*')) continue
      const lock = `<${sheet}/${row.key}#${row.row}>`
      if (seen.has(lock.toLowerCase())) continue
      seen.add(lock.toLowerCase())
      const parts = show
        .map((column) => (column === 'key' ? row.key : (row.fields.get(column) ?? '')).trim())
        .filter(Boolean)
      const flat = row.value.replace(/\s+/g, ' ').trim()
      out.push({
        label: parts.length > 0 ? parts.join(' · ') : row.key,
        lock,
        detail: flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
      })
      if (out.length >= MAX_CHOICES) return out
    }
  }
  return out
}

export function sheetColumnValues(
  sheets: SpreadsheetSource | null | undefined,
  sheet: string
): SheetColumnValues[] {
  if (!sheets || sheets.unavailableReason !== undefined) return []
  const rows = sheets.getRows(sheet, '*') ?? []
  if (rows.length === 0) return []
  const out: SheetColumnValues[] = []
  for (const column of sheets.columns(sheet)) {
    if (!column || column === 'weight') continue
    const cells = rows.map((row) => (row.fields.get(column) ?? '').trim())
    const filled = cells.filter(Boolean)
    if (filled.length === 0) continue
    // any comma: a list column (`a, b`), matched item by item with `~=`
    const list = filled.some((cell) => cell.includes(','))
    const counts = new Map<string, number>()
    for (const cell of filled) {
      const items = list ? splitList(cell) : [cell]
      for (const item of new Set(items.map((i) => i.toLowerCase()))) {
        counts.set(item, (counts.get(item) ?? 0) + 1)
      }
    }
    // free-text columns (prompts, sentences) make poor filters
    if (counts.size > MAX_VALUES) continue
    if ([...counts.keys()].some((value) => value.length > MAX_VALUE_LENGTH)) continue
    out.push({
      column,
      list,
      values: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }))
    })
  }
  return out
}

/** Sheet names with their keys and columns, for the prompt editor's completion. */
export function workbookOutline(sheets: SpreadsheetSource | null | undefined): WorkbookOutline {
  if (!sheets || sheets.unavailableReason !== undefined) return { sheets: [] }
  return {
    sheets: sheets.sheetNames().map((name) => ({
      name,
      keys: sheets.listKeys(name),
      columns: sheets.columns(name).filter(Boolean)
    }))
  }
}
