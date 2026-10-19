/**
 * External spreadsheet fragments.
 *
 * A workbook (.xlsx) is reduced to: sheet name -> rows of (column A key, column B value).
 * `<Sheet/Key>` in a prompt then behaves like a fragment whose lines are the column-B cells of every
 * row on `Sheet` whose column A equals `Key`. Columns C and beyond are ignored, so they are free for notes.
 *
 * This module is pure (no Electron / fs) so the browser dev build and the tests can import it.
 */

import { normalizeFragmentPath } from '../../shared/fragment-path'
import type { FragmentSource } from './processor'

export interface SheetRow {
  /** Column A */
  key: string
  /** Column B */
  value: string
}

export interface ParsedSheet {
  name: string
  rows: SheetRow[]
}

export interface SpreadsheetSource {
  hasSheet: (sheet: string) => boolean
  /** Column-B candidates of every row whose column A equals `key`; null when the sheet has no such key. */
  getOptions: (sheet: string, key: string) => string[] | null
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

export function createSpreadsheetSource(sheets: ParsedSheet[]): SpreadsheetSource {
  const bySheet = new Map<
    string,
    { name: string; keys: Map<string, { label: string; values: string[] }> }
  >()

  for (const sheet of sheets) {
    const sheetKey = normalizeName(sheet.name)
    const entry = bySheet.get(sheetKey) ?? { name: sheet.name, keys: new Map() }
    bySheet.set(sheetKey, entry)
    for (const row of sheet.rows) {
      const key = row.key.trim()
      const value = cleanCell(row.value)
      if (!key || !value || isComment(key) || isComment(row.value)) continue
      const normalizedKey = normalizeName(key)
      const bucket = entry.keys.get(normalizedKey) ?? { label: key, values: [] }
      bucket.values.push(value)
      entry.keys.set(normalizedKey, bucket)
    }
  }

  return {
    hasSheet: (sheet) => bySheet.has(normalizeName(sheet)),
    getOptions: (sheet, key) =>
      bySheet.get(normalizeName(sheet))?.keys.get(normalizeName(key))?.values ?? null,
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

/**
 * Fragments saved in the app win; `<Sheet/Key>` is tried when no saved fragment of that path exists.
 * Without a workbook nothing changes at all. Paths arrive normalized, so the first `/` always separates the sheet
 * (Excel forbids `/` in sheet names) from the key (which may itself contain `/`).
 */
export function composeFragmentSources(
  primary: FragmentSource,
  sheets: SpreadsheetSource | null | undefined,
  options: ComposeOptions = {}
): FragmentSource {
  if (!sheets) return primary
  const strict = options.strict === true

  return {
    getLines: (path) => {
      const own = primary.getLines(path)
      if (own && own.length > 0) return own

      const slash = path.indexOf('/')
      if (slash <= 0) return own

      if (sheets.unavailableReason !== undefined) {
        if (strict) {
          throw new Error(
            `Spreadsheet fragments are unavailable (<${path}> could not be resolved): ${sheets.unavailableReason}`
          )
        }
        return own
      }

      const sheet = path.slice(0, slash)
      const key = path.slice(slash + 1)
      if (!sheets.hasSheet(sheet)) {
        if (strict) {
          throw new Error(
            `<${path}> matches no saved fragment and the workbook has no sheet "${sheet}". Sheets: ${sheets.sheetNames().join(', ') || '(none)'}.`
          )
        }
        return own
      }

      const options = sheets.getOptions(sheet, key)
      if (options && options.length > 0) return options

      if (strict) {
        const known = sheets.listKeys(sheet)
        const hint =
          known.length > 0 ? ` Keys on this sheet: ${known.slice(0, 15).join(', ')}.` : ''
        throw new Error(
          `Spreadsheet sheet "${sheet}" has no usable rows for key "${key}" (needs column A = key and a non-empty column B).${hint}`
        )
      }
      return own
    }
  }
}
