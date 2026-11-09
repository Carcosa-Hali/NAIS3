/**
 * Workbook check: finds what would make images fail or come out wrong, without generating anything.
 *
 * - Static: every literal `<Sheet/Key>` / `<fragment>` reference written in a sheet cell or a mode cell (one
 *   without `${...}` in it) must resolve. With `??` alternatives, at least one must resolve.
 * - Sampled: every mode is rolled `rolls` times like a real generation (sequential `<*...>` walks are not
 *   advanced). Failures are counted by message, every variable's values are counted, and the subject counts
 *   written in the main prompt (`3girls`, `1boy`, `1other`) are compared with the character boxes that came out
 *   non-empty.
 *
 * Pure module (no Electron / fs).
 */

import type { PromptMode, WorkbookCheckReport, WorkbookCheckMode } from '../../shared/types'
import { normalizeFragmentPath } from '../../shared/fragment-path'
import { lookupEntries, type FragmentSource } from './processor'
import { rollPreview } from './request'
import { composeFragmentSources, type SpreadsheetSource } from './spreadsheet'

const REFERENCE_IN_TEXT = /<([^<>]+)>/g
const MAX_MISSING = 200
const TOP_VALUES = 12

/** Subjects written as count tags (`1girl`, `3girls`, `2boys`, `1other`); null when there are none. */
export function countSubjects(prompt: string): number | null {
  let total = 0
  let found = false
  for (const match of prompt.matchAll(/(?:^|[\s,(:{[])(\d+)\s*(girls?|boys?|others?)\b/gi)) {
    total += Number(match[1])
    found = true
  }
  return found ? total : null
}

/** Literal references of a text that can be checked statically (no `${...}`, not an inline `<a|b>` wildcard). */
function literalReferences(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(REFERENCE_IN_TEXT)) {
    const inner = match[1]
    if (inner.includes('${') || inner.includes('|')) continue
    out.push(inner.replace(/^\*/, '').trim())
  }
  return out
}

function resolves(source: FragmentSource, reference: string): boolean {
  for (const raw of reference.split('??')) {
    const path = normalizeFragmentPath(raw.trim().replace(/^\*/, ''))
    if (!path) return true // `<A ?? >`: an empty alternative means "nothing", which always resolves
    try {
      const entries = lookupEntries(source, path)
      if (entries && entries.length > 0) return true
    } catch {
      // try the next alternative
    }
  }
  return false
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export async function checkWorkbook(
  modes: PromptMode[],
  primary: FragmentSource,
  sheets: SpreadsheetSource | null | undefined,
  rolls = 100,
  rng: () => number = Math.random
): Promise<WorkbookCheckReport> {
  const source = composeFragmentSources(primary, sheets, { strict: false })
  const missing: WorkbookCheckReport['missing'] = []
  const seen = new Set<string>()
  const note = (place: string, reference: string): void => {
    const id = `${place}|${reference}`
    if (seen.has(id) || missing.length >= MAX_MISSING) return
    seen.add(id)
    missing.push({ place, reference })
  }

  // Static references in every sheet cell.
  if (sheets && sheets.unavailableReason === undefined) {
    for (const sheet of sheets.sheetNames()) {
      for (const row of sheets.getRows(sheet, '*') ?? []) {
        for (const [column, text] of row.fields) {
          for (const reference of literalReferences(text)) {
            if (!resolves(source, reference))
              note(`${sheet} · row ${row.row} · ${column}`, reference)
          }
        }
      }
      await yieldToLoop()
    }
  }

  const reports: WorkbookCheckMode[] = []
  for (const mode of modes) {
    const errors = new Map<string, number>()
    const values = new Map<string, Map<string, number>>()
    let failed = 0
    let countMismatch = 0
    let countExample: string | undefined
    for (let i = 0; i < rolls; i++) {
      const result = rollPreview(
        {
          prompt: mode.prompt,
          negativePrompt: mode.negativePrompt,
          characters: mode.characters.map((c) => ({
            prompt: c.prompt,
            negativePrompt: c.negativePrompt
          }))
        },
        primary,
        sheets,
        rng
      )
      for (const variable of result.variables) {
        const counts = values.get(variable.name) ?? new Map<string, number>()
        const label = variable.value.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty)'
        counts.set(label, (counts.get(label) ?? 0) + 1)
        values.set(variable.name, counts)
      }
      if (!result.ok) {
        failed++
        errors.set(result.error, (errors.get(result.error) ?? 0) + 1)
      } else {
        const subjects = countSubjects(result.prompt)
        const boxes = result.characters.filter((c) => c.prompt.trim()).length
        if (subjects !== null && boxes > 0 && subjects !== boxes) {
          countMismatch++
          countExample ??= `${subjects} in the main prompt, ${boxes} character boxes`
        }
      }
      if (i % 10 === 9) await yieldToLoop()
    }
    for (const reference of [
      mode.prompt,
      mode.negativePrompt,
      ...mode.characters.flatMap((c) => [c.prompt, c.negativePrompt])
    ].flatMap(literalReferences)) {
      if (!resolves(source, reference)) note(`mode ${mode.name}`, reference)
    }
    reports.push({
      id: mode.id,
      name: mode.name,
      rolls,
      failed,
      errors: [...errors.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([message, count]) => ({ message, count })),
      countMismatch,
      ...(countExample ? { countExample } : {}),
      variables: [...values.entries()].map(([name, counts]) => ({
        name,
        distinct: counts.size,
        top: [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_VALUES)
          .map(([value, count]) => ({ value, count }))
      }))
    })
  }

  return { missing, modes: reports }
}
