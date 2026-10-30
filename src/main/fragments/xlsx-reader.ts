/**
 * Minimal .xlsx reader: every cell of every worksheet is read as text (row 1 doubles as the header row).
 * An .xlsx is a zip of XML parts, and jszip is already a dependency, so no spreadsheet library is added.
 *
 * Deliberately lenient: formulas use their cached result, numbers are used as text, errors and
 * booleans are skipped, and phonetic (furigana) runs are ignored so Japanese cells read as typed.
 */

import { posix } from 'path'
import { promises as fs } from 'fs'
import JSZip from 'jszip'
import type { FragmentWorkbookInfo } from '../../shared/types'
import {
  createSpreadsheetSource,
  unavailableSpreadsheet,
  type ParsedSheet,
  type SpreadsheetSource
} from './spreadsheet'

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decodeXml(text: string): string {
  return text
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
      if (entity.startsWith('#x')) return safeCodePoint(parseInt(entity.slice(2), 16), match)
      if (entity.startsWith('#')) return safeCodePoint(parseInt(entity.slice(1), 10), match)
      return XML_ENTITIES[entity] ?? match
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
}

function safeCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = match[2] ?? match[3] ?? ''
  }
  return attributes
}

/** Concatenate the <t> runs of a shared string / inline string, skipping phonetic <rPh> runs. */
function extractText(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  let text = ''
  for (const match of withoutPhonetic.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    text += match[1] ?? ''
  }
  return decodeXml(text)
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return []
  const strings: string[] = []
  for (const match of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    strings.push(extractText(match[1] ?? ''))
  }
  return strings
}

/** "A" -> 0, "B" -> 1, "AA" -> 26 */
function columnIndex(letters: string): number {
  let index = 0
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

function parseSheetRows(xml: string, shared: string[]): Pick<ParsedSheet, 'rows' | 'header'> {
  const rows: ParsedSheet['rows'] = []
  let header: string[] | undefined
  let rowPosition = 0

  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(parseAttributes(rowMatch[1]).r) || rowPosition + 1
    rowPosition = rowNumber
    const rowXml = rowMatch[2]
    if (!rowXml) continue

    const cells: string[] = []
    let position = 0
    for (const cellMatch of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = parseAttributes(cellMatch[1])
      const reference = /^([A-Za-z]+)\d*$/.exec(attributes.r ?? '')
      const column = reference ? columnIndex(reference[1].toUpperCase()) : position
      position = column + 1
      const text = cellText(attributes.t, cellMatch[2] ?? '', shared)
      if (text !== null) cells[column] = text
    }
    for (let i = 0; i < cells.length; i++) cells[i] ??= ''

    if (rowNumber === 1) header = cells
    if (cells[0] !== undefined && cells[0] !== '') {
      rows.push({ key: cells[0], value: cells[1] ?? '', cells, row: rowNumber })
    }
  }
  return { rows, header: header ?? [] }
}

function cellText(type: string | undefined, inner: string, shared: string[]): string | null {
  if (type === 'inlineStr') return extractText(inner)
  const raw = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(inner)?.[1]
  if (raw === undefined) return null
  switch (type) {
    case 's':
      return shared[parseInt(raw, 10)] ?? null
    case 'str':
      return decodeXml(raw)
    case 'e': // error value
    case 'b': // boolean
      return null
    default:
      return decodeXml(raw) // number
  }
}

/** Resolve a workbook relationship target to a zip entry name. */
function entryName(target: string): string {
  return target.startsWith('/') ? target.slice(1) : posix.normalize(`xl/${target}`)
}

export async function parseXlsx(data: Uint8Array): Promise<ParsedSheet[]> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch {
    throw new Error('Not an .xlsx file (it could not be opened as a zip archive).')
  }
  const read = async (name: string): Promise<string | null> => {
    const file = zip.file(name)
    return file ? file.async('string') : null
  }

  const workbook = await read('xl/workbook.xml')
  if (!workbook) throw new Error('Not an .xlsx workbook (xl/workbook.xml is missing).')
  const relationships = (await read('xl/_rels/workbook.xml.rels')) ?? ''
  const shared = parseSharedStrings(await read('xl/sharedStrings.xml'))

  const targets = new Map<string, string>()
  for (const match of relationships.matchAll(/<Relationship\b[^>]*>/g)) {
    const attributes = parseAttributes(match[0])
    if (attributes.Id && attributes.Target) targets.set(attributes.Id, attributes.Target)
  }

  const sheets: ParsedSheet[] = []
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const attributes = parseAttributes(match[0])
    const target = targets.get(attributes['r:id'] ?? '')
    if (!attributes.name || !target) continue
    const xml = await read(entryName(target))
    if (xml === null) continue // chartsheet or missing part
    sheets.push({ name: decodeXml(attributes.name), ...parseSheetRows(xml, shared) })
  }
  return sheets
}

/**
 * Re-reads the workbook only when its modification time or size changed, so edits made in Excel show up
 * on the next generation without re-parsing on every image. If a re-read fails (file locked mid-save,
 * temporarily missing) the last good copy stays in use.
 */
export class WorkbookCache {
  private filePath: string | null = null
  private stamp = ''
  private current: SpreadsheetSource | null = null
  private error: string | null = null

  async refresh(filePath: string | null | undefined): Promise<SpreadsheetSource | null> {
    const path = filePath?.trim() || null
    if (path !== this.filePath) {
      this.filePath = path
      this.stamp = ''
      this.current = null
      this.error = null
    }
    if (!path) return null

    try {
      const stat = await fs.stat(path)
      const stamp = `${stat.mtimeMs}:${stat.size}`
      if (this.current && stamp === this.stamp) return this.current
      const sheets = await parseXlsx(await fs.readFile(path))
      this.current = createSpreadsheetSource(sheets)
      this.stamp = stamp
      this.error = null
      return this.current
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      return this.current ?? unavailableSpreadsheet(this.error)
    }
  }

  status(): FragmentWorkbookInfo {
    return {
      path: this.filePath,
      sheetCount: this.current?.sheetNames().length ?? 0,
      error: this.error
    }
  }
}
