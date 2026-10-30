/**
 * External spreadsheet fragments.
 *
 * A workbook (.xlsx) is reduced to: sheet name -> rows (column A key, column B value, plus every other column).
 * `<Sheet/Key>` in a prompt then behaves like a fragment whose lines are the column-B cells of every
 * row on `Sheet` whose column A equals `Key`.
 *
 * Row 1 of a sheet doubles as its header row:
 *   - a column headed `weight` sets each row's relative chance (blank = 1, 0 = never picked);
 *   - `row(<Sheet/Key>)` exposes every column of the picked row by its header name.
 * Other columns are otherwise ignored, so they stay free for notes.
 *
 * This module is pure (no Electron / fs) so the browser dev build and the tests can import it.
 */

import { normalizeFragmentPath } from '../../shared/fragment-path'
import type { FragmentEntry, FragmentSource } from './processor'

export interface SheetRow {
  /** Column A */
  key: string
  /** Column B */
  value: string
  /** Every cell of the row, index 0 = column A. Optional so callers that only know A and B keep working. */
  cells?: string[]
  /** 1-based row number in the sheet (as shown by Excel). */
  row?: number
}

export interface ParsedSheet {
  name: string
  rows: SheetRow[]
  /** Cells of the sheet's first row. Defaults to the first parsed row's cells. */
  header?: string[]
}

/** A row reached through `<Sheet/Key>`: its column-B value, its weight and its other columns by header name. */
export interface SheetEntry {
  value: string
  weight: number
  row: number
  fields: ReadonlyMap<string, string>
}

export interface SpreadsheetSource {
  hasSheet: (sheet: string) => boolean
  /** Column-B candidates of every row whose column A equals `key`; null when the sheet has no such key. */
  getOptions: (sheet: string, key: string) => string[] | null
  /** Every row whose column A equals `key` (including rows with an empty column B); null when there is none. */
  getRows: (sheet: string, key: string) => SheetEntry[] | null
  /** Original-case sheet names (for status / error messages). */
  sheetNames: () => string[]
  /** Original-case keys of a sheet (for error messages). */
  listKeys: (sheet: string) => string[]
  /** Set when a workbook is configured but could not be read and no earlier copy is available. */
  readonly unavailableReason?: string
}

/**
 * Sheet names and keys match case-insensitively, ignoring surrounding spaces and runs of whitespace
 * (including full-width spaces), because they are typed by hand in a spreadsheet.
 */
function normalizeName(name: string): string {
  return normalizeFragmentPath(name).replace(/\s+/g, ' ')
}

/** Rows or cells starting with # are ignored, like comment lines in fragments. */
function isComment(text: string): boolean {
  return text.trimStart().startsWith('#')
}

/**
 * A cell keeps its line breaks (Alt+Enter), so one cell can hold several prompt lines, including
 * `$Var = ...` definition lines. Lines starting with # inside a cell are comments and are dropped,
 * and trailing spaces are trimmed.
 */
function cleanCell(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => !isComment(line))
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

/** Header text -> field name used in `${var.field}`: lower case, runs of other characters become `_`. */
export function fieldName(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
}

/** Blank or unreadable = 1; negative = 0. */
function parseWeight(text: string | undefined): number {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return 1
  const weight = Number(trimmed)
  if (!Number.isFinite(weight)) return 1
  return Math.max(0, weight)
}

export function createSpreadsheetSource(sheets: ParsedSheet[]): SpreadsheetSource {
  const bySheet = new Map<
    string,
    { name: string; keys: Map<string, { label: string; rows: SheetEntry[] }> }
  >()

  for (const sheet of sheets) {
    const sheetKey = normalizeName(sheet.name)
    const entry = bySheet.get(sheetKey) ?? { name: sheet.name, keys: new Map() }
    bySheet.set(sheetKey, entry)

    const header = (sheet.header ?? sheet.rows[0]?.cells ?? []).map(fieldName)
    const weightColumn = header.indexOf('weight')

    sheet.rows.forEach((row, index) => {
      const key = row.key.trim()
      if (!key || isComment(key) || isComment(row.value)) return
      const cells = row.cells ?? [row.key, row.value]
      const weight = weightColumn >= 0 ? parseWeight(cells[weightColumn]) : 1
      if (weight <= 0) return

      let fields: Map<string, string> | null = null
      const readFields = (): ReadonlyMap<string, string> => {
        if (fields === null) {
          fields = new Map()
          header.forEach((name, column) => {
            if (name && !fields!.has(name)) fields!.set(name, cleanCell(cells[column] ?? ''))
          })
        }
        return fields
      }
      const normalizedKey = normalizeName(key)
      const bucket = entry.keys.get(normalizedKey) ?? { label: key, rows: [] }
      // Columns are read on first use: most rows are only ever picked for their column B.
      bucket.rows.push({
        value: cleanCell(row.value),
        weight,
        row: row.row ?? index + 1,
        get fields() {
          return readFields()
        }
      })
      entry.keys.set(normalizedKey, bucket)
    })
  }

  const rowsOf = (sheet: string, key: string): SheetEntry[] | null =>
    bySheet.get(normalizeName(sheet))?.keys.get(normalizeName(key))?.rows ?? null

  return {
    hasSheet: (sheet) => bySheet.has(normalizeName(sheet)),
    getOptions: (sheet, key) => {
      const values = rowsOf(sheet, key)
        ?.map((row) => row.value)
        .filter(Boolean)
      return values && values.length > 0 ? values : null
    },
    getRows: (sheet, key) => rowsOf(sheet, key),
    sheetNames: () => [...bySheet.values()].map((entry) => entry.name),
    listKeys: (sheet) =>
      [...(bySheet.get(normalizeName(sheet))?.keys.values() ?? [])].map((bucket) => bucket.label)
  }
}

/** Placeholder for a configured workbook that cannot be read and has never been read successfully. */
export function unavailableSpreadsheet(reason: string): SpreadsheetSource {
  return {
    hasSheet: () => false,
    getOptions: () => null,
    getRows: () => null,
    sheetNames: () => [],
    listKeys: () => [],
    unavailableReason: reason
  }
}

export interface ComposeOptions {
  /**
   * true  -> actual generation: with a workbook configured, a `<Sheet/Key>` that resolves to nothing (unknown
   *          sheet, missing / empty key, unreadable workbook) throws, so a typo cannot silently send junk to NovelAI.
   * false -> previews (token counts): never throws, misses fall back to the plain fragment behaviour.
   */
  strict?: boolean
}

/** `Key#12` -> { base: "Key", row: 12 } (the row number as shown by Excel, or a fragment's 1-based line). */
function splitRowSuffix(path: string): { base: string; row: number } | null {
  const match = /^(.*?)\s*#\s*(\d+)$/.exec(path)
  return match && match[1] ? { base: match[1], row: Number(match[2]) } : null
}

function lineEntries(lines: string[] | null): FragmentEntry[] | null {
  return lines ? lines.map((line, index) => ({ line, weight: 1, row: index + 1 })) : null
}

/**
 * Fragments saved in the app win; `<Sheet/Key>` is tried when no saved fragment of that path exists.
 * Paths arrive normalized, so the first `/` always separates the sheet (Excel forbids `/` in sheet names) from
 * the key (which may itself contain `/`).
 *
 * `path#N` narrows a lookup to one row: the row numbered N on the sheet, or line N of a saved fragment.
 *
 * `getLines` only returns rows with a non-empty column B; `getEntries` returns every row (row() reads other
 * columns, so an empty column B is fine there) with its weight and fields.
 */
export function composeFragmentSources(
  primary: FragmentSource,
  sheets: SpreadsheetSource | null | undefined,
  options: ComposeOptions = {}
): FragmentSource {
  const strict = options.strict === true

  /** null = this path is not a sheet reference (or sheets are off): fall back to the saved fragments' answer. */
  const sheetEntries = (path: string): FragmentEntry[] | null => {
    if (!sheets) return null
    const slash = path.indexOf('/')
    if (slash <= 0) return null

    if (sheets.unavailableReason !== undefined) {
      if (strict) {
        throw new Error(
          `Spreadsheet fragments are unavailable (<${path}> could not be resolved): ${sheets.unavailableReason}`
        )
      }
      return null
    }

    const sheet = path.slice(0, slash)
    const key = path.slice(slash + 1)
    if (!sheets.hasSheet(sheet)) {
      if (strict) {
        throw new Error(
          `<${path}> matches no saved fragment and the workbook has no sheet "${sheet}". Sheets: ${sheets.sheetNames().join(', ') || '(none)'}.`
        )
      }
      return null
    }

    let rows = sheets.getRows(sheet, key)
    let narrowed: number | null = null
    if (!rows) {
      const suffix = splitRowSuffix(key)
      if (suffix) {
        rows = sheets.getRows(sheet, suffix.base)?.filter((row) => row.row === suffix.row) ?? null
        narrowed = suffix.row
      }
    }
    if (rows && rows.length > 0) {
      return rows.map((row) => ({
        line: row.value,
        weight: row.weight,
        row: row.row,
        get fields() {
          return row.fields
        }
      }))
    }

    if (strict) {
      const known = sheets.listKeys(sheet)
      const hint = known.length > 0 ? ` Keys on this sheet: ${known.slice(0, 15).join(', ')}.` : ''
      throw new Error(
        narrowed !== null
          ? `Spreadsheet sheet "${sheet}" has no row ${narrowed} for key "${splitRowSuffix(key)?.base}".`
          : `Spreadsheet sheet "${sheet}" has no usable rows for key "${key}" (needs column A = key, and a weight above 0 if the sheet has a weight column).${hint}`
      )
    }
    return null
  }

  const ownEntries = (path: string): FragmentEntry[] | null => {
    const own = lineEntries(primary.getLines(path))
    if (own && own.length > 0) return own
    const suffix = splitRowSuffix(path)
    if (!suffix) return own
    const base = lineEntries(primary.getLines(suffix.base))
    const picked = base?.filter((entry) => entry.row === suffix.row) ?? []
    return picked.length > 0 ? picked : own
  }

  const getEntries = (path: string): FragmentEntry[] | null => {
    const own = ownEntries(path)
    if (own && own.length > 0) return own
    return sheetEntries(path) ?? own
  }

  return {
    getEntries,
    getLines: (path) => {
      const entries = getEntries(path)
      if (!entries) return null
      const lines = entries.map((entry) => entry.line).filter((line) => line.trim())
      if (lines.length > 0 || entries.length === 0) return lines
      if (strict) {
        throw new Error(
          `<${path}> has rows but every column-B cell is empty. Use row(<${path}>) to read its other columns.`
        )
      }
      return null
    }
  }
}
