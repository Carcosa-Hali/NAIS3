/**
 * Data for the controls panel.
 *
 * - readControls: the optional `controls` sheet (in any workbook of the folder), one row per variable:
 *     variable | label | group | filters | hidden | note
 *   `filters` lists the columns the panel offers as filters for a row() / deal() variable; `hidden` (1 / yes)
 *   moves the variable to the advanced list. Variables without a row are shown in the advanced list.
 * - sheetColumnValues: every column of a sheet with its distinct values and how many rows have each, for the
 *   filter picker. A column with comma lists in its cells is offered as a list column (matched with `~=`).
 *
 * - workbookOutline: every sheet with its keys and columns (prompt editor completion).
 *
 * Pure module (no Electron / fs).
 */

import type { ControlRow, SheetColumnValues, WorkbookOutline } from '../../shared/types'
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
      out.push({
        variable,
        label: field('label') || variable,
        group: field('group'),
        filters: splitList(field('filters')),
        hidden: isYes(field('hidden')),
        note: field('note')
      })
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
