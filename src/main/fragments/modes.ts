/**
 * Modes: named sets of prompt texts kept on a sheet called `modes` (in any workbook of the folder).
 *
 *   mode | main | main_neg | char_1 | char_1_neg | char_1_pos | ... | char_6 | char_6_neg | char_6_pos | size | note
 *
 * One row per mode. Picking a mode in the prompt panel fills the main prompt, the main negative and one character
 * box per non-empty char_N (positions from char_N_pos as "x, y" between 0 and 1, size as "832x1216").
 * Cells are copied as written, so they hold the same syntax as the prompt boxes ($name = ..., <Sheet/Key>, ${...}).
 *
 * Pure module (no Electron / fs).
 */

import type { PromptMode } from '../../shared/types'
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

/** Every mode row of every `modes` sheet, in file and row order. */
export function readModes(sheets: SpreadsheetSource | null | undefined): PromptMode[] {
  if (!sheets || sheets.unavailableReason !== undefined) return []
  const modes: PromptMode[] = []
  for (const { qualified, file } of sheets.sheetsNamed(MODES_SHEET)) {
    for (const row of sheets.getRows(qualified, '*') ?? []) {
      const field = (name: string): string => row.fields.get(name) ?? ''
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
      modes.push({
        id: file ? `${file}:${row.key}` : row.key,
        name: row.key,
        ...(file ? { file } : {}),
        row: row.row,
        prompt: field('main'),
        negativePrompt: field('main_neg') || field('negative'),
        characters,
        ...(dimensions ? { size: dimensions } : {}),
        ...(field('note') ? { note: field('note') } : {})
      })
    }
  }
  return modes
}
