import type { FragmentWorkbookInfo } from '../../shared/types'
import { getSetting } from '../db/settings'
import type { SpreadsheetSource } from './spreadsheet'
import { WorkbookCache } from './xlsx-reader'

/** Settings key holding the path of the external fragment workbook (.xlsx). Empty / unset = feature off. */
export const WORKBOOK_SETTING = 'fragment_workbook_path'

const cache = new WorkbookCache()

/**
 * The current workbook for `<Sheet/Key>` lookups, or null when none is configured.
 * Cheap to call before every image: the file is only re-read when its modification time or size changed.
 */
export function refreshWorkbook(): Promise<SpreadsheetSource | null> {
  return cache.refresh(getSetting(WORKBOOK_SETTING))
}

export async function workbookStatus(): Promise<FragmentWorkbookInfo> {
  await refreshWorkbook()
  return cache.status()
}
