import { mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  processWildcards,
  resetSequentialCounters,
  type FragmentSource
} from '../src/main/fragments/processor'
import {
  composeFragmentSources,
  createSpreadsheetSource,
  unavailableSpreadsheet
} from '../src/main/fragments/spreadsheet'
import { parseXlsx, WorkbookCache } from '../src/main/fragments/xlsx-reader'

type Cell = string | number | null

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Builds a small but structurally real .xlsx (shared strings, one inline string, phonetic runs). */
async function buildWorkbook(
  sheets: Record<string, Cell[][]>,
  options: { sharedStringsXml?: string } = {}
): Promise<Uint8Array> {
  const shared: string[] = []
  const sharedIndex = (text: string): number => {
    const existing = shared.indexOf(text)
    if (existing >= 0) return existing
    shared.push(text)
    return shared.length - 1
  }
  const names = Object.keys(sheets)
  const zip = new JSZip()
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
      .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join('')}</Relationships>`
  )
  names.forEach((name, sheetIndex) => {
    const rows = sheets[name].map((cells, rowIndex) => {
      const xml = cells
        .map((cell, colIndex) => {
          if (cell === null) return ''
          const ref = `${String.fromCharCode(65 + colIndex)}${rowIndex + 1}`
          return typeof cell === 'number'
            ? `<c r="${ref}"><v>${cell}</v></c>`
            : `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>`
        })
        .join('')
      return `<row r="${rowIndex + 1}">${xml}</row>`
    })
    zip.file(
      `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`
    )
  })
  zip.file(
    'xl/sharedStrings.xml',
    options.sharedStringsXml ??
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
        .map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
        .join('')}</sst>`
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const LOCATIONS: Record<string, Cell[][]> = {
  Locations: [
    ['Category', 'Tags', 'Notes'],
    ['Public locations', 'street, crowd, shops'],
    ['Public locations', 'train station, platform'],
    ['Parks', 'park, trees, bench'],
    ['Parks', 'park, pond, ducks', 'my favourite'],
    ['Private locations', 'bedroom, lamp'],
    ['# Parks', 'commented out']
  ],
  Outfits: [
    ['Formal', 'tuxedo'],
    ['Formal', '<wedding_dress_types>']
  ]
}

describe('parseXlsx', () => {
  it('reads column A and B of every sheet and ignores the other columns', async () => {
    const sheets = await parseXlsx(await buildWorkbook(LOCATIONS))
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Locations', 'Outfits'])
    expect(sheets[0].rows).toContainEqual({ key: 'Parks', value: 'park, pond, ducks' })
    expect(sheets[0].rows).not.toContainEqual(expect.objectContaining({ value: 'my favourite' }))
  })

  it('handles numbers, entities and rows without a value', async () => {
    const sheets = await parseXlsx(
      await buildWorkbook({
        Misc: [['Count', 3], ['Amp', 'rock & roll'], ['OnlyKey'], [null, 'orphan']]
      })
    )
    expect(sheets[0].rows).toEqual([
      { key: 'Count', value: '3' },
      { key: 'Amp', value: 'rock & roll' }
    ])
  })

  it('skips phonetic (furigana) runs, keeps an empty <si/> from shifting indexes, and reads inline and formula strings', async () => {
    const zip = new JSZip()
    zip.file(
      'xl/workbook.xml',
      '<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
    )
    zip.file(
      'xl/sharedStrings.xml',
      '<sst><si/><si><t>場所</t><rPh sb="0" eb="2"><t>バショ</t></rPh></si><si><r><t>神社、</t></r><r><t>鳥居</t></r></si></sst>'
    )
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>inline</t></is></c><c r="B2" t="str"><v>formula &lt;result&gt;</v></c></row></sheetData></worksheet>'
    )
    const sheets = await parseXlsx(await zip.generateAsync({ type: 'uint8array' }))
    expect(sheets[0].rows).toEqual([
      { key: '場所', value: '神社、鳥居' },
      { key: 'inline', value: 'formula <result>' }
    ])
  })

  it('rejects files that are not workbooks', async () => {
    await expect(parseXlsx(new TextEncoder().encode('not a zip'))).rejects.toThrow('Not an .xlsx')
    const zip = new JSZip()
    zip.file('hello.txt', 'hi')
    await expect(parseXlsx(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      'xl/workbook.xml'
    )
  })
})

describe('createSpreadsheetSource', () => {
  const source = createSpreadsheetSource([
    {
      name: 'Locations',
      rows: [
        { key: 'Public locations', value: 'street, crowd' },
        { key: ' public  Locations ', value: 'train station\nplatform' },
        { key: 'Parks', value: 'park' },
        { key: '# Parks', value: 'ignored' },
        { key: 'Parks', value: '# disabled' },
        { key: '', value: 'no key' },
        { key: 'Empty', value: '   ' }
      ]
    }
  ])

  it('collects the column-B value of every row sharing a key, case-insensitively', () => {
    // line breaks inside a cell are kept
    expect(source.getOptions('locations', 'PUBLIC LOCATIONS')).toEqual([
      'street, crowd',
      'train station\nplatform'
    ])
  })

  it('ignores comment rows, blank keys and blank values', () => {
    expect(source.getOptions('Locations', 'Parks')).toEqual(['park'])
    expect(source.getOptions('Locations', 'Empty')).toBeNull()
    expect(source.getOptions('Locations', 'Nope')).toBeNull()
    expect(source.getOptions('Nope', 'Parks')).toBeNull()
  })

  it('lists sheets and keys with their original spelling', () => {
    expect(source.sheetNames()).toEqual(['Locations'])
    expect(source.listKeys('Locations')).toEqual(['Public locations', 'Parks'])
  })
})

describe('<Sheet/Key> fragments', () => {
  const saved: FragmentSource = {
    getLines: (path) =>
      ({
        wedding_dress_types: ['ball gown', 'mermaid dress'],
        'locations/parks': ['saved fragment wins']
      })[path] ?? null
  }
  const sheets = createSpreadsheetSource([
    {
      name: 'Locations',
      rows: [
        { key: 'Public locations', value: 'street, crowd' },
        { key: 'Public locations', value: 'train station' },
        { key: 'Parks', value: 'park' }
      ]
    },
    {
      name: 'Outfits',
      rows: [{ key: 'Formal', value: '<wedding_dress_types>, veil' }]
    }
  ])
  const first = (): number => 0
  const last = (): number => 0.999
  const strict = composeFragmentSources(saved, sheets, { strict: true })

  it('picks one column-B row at random', () => {
    expect(processWildcards('<Locations/Public locations>', strict, first)).toBe('street, crowd')
    expect(processWildcards('<Locations / public locations>', strict, last)).toBe('train station')
  })

  it('walks the rows in order with <*Sheet/Key>', () => {
    resetSequentialCounters()
    const run = (): string => processWildcards('<*Locations/Public locations>', strict, first)
    expect([run(), run(), run()]).toEqual(['street, crowd', 'train station', 'street, crowd'])
  })

  it('expands fragments nested in a cell', () => {
    expect(processWildcards('<Outfits/Formal>', strict, first)).toBe('ball gown, veil')
  })

  it('keeps fragments saved in the app ahead of the workbook', () => {
    expect(processWildcards('<Locations/Parks>', strict, first)).toBe('saved fragment wins')
  })

  it('throws for a known sheet with a missing key (strict) and lists what exists', () => {
    expect(() => processWildcards('<Locations/Beaches>', strict, first)).toThrow(
      /no usable rows for key "beaches".*Public locations, Parks/
    )
  })

  it('throws for an unknown sheet (strict) and lists the real sheets', () => {
    expect(() => processWildcards('<Locatoins/Parks>', strict, first)).toThrow(
      /no sheet "locatoins"\. Sheets: Locations, Outfits/
    )
  })

  it('leaves paths without a slash to the saved-fragment behaviour', () => {
    expect(processWildcards('<unknown>', strict, first)).toBe('<unknown>')
  })

  it('never throws in preview mode', () => {
    const lenient = composeFragmentSources(saved, sheets, { strict: false })
    expect(lenient.getLines('locations/beaches')).toBeNull()
    expect(lenient.getLines('mystery/thing')).toBeNull()
  })

  it('matches keys typed with stray or full-width spaces', () => {
    expect(processWildcards('<locations/Public   locations>', strict, first)).toBe('street, crowd')
    expect(processWildcards('<Locations/Public\u3000locations>', strict, first)).toBe(
      'street, crowd'
    )
  })

  it('refuses to send a prompt when the configured workbook is unreadable', () => {
    const broken = composeFragmentSources(saved, unavailableSpreadsheet('file is missing'), {
      strict: true
    })
    expect(() => processWildcards('<Locations/Parks2>', broken, first)).toThrow('file is missing')
    expect(processWildcards('<plain>', broken, first)).toBe('<plain>')
  })
})

describe('WorkbookCache', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nais3-workbook-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null without a path', async () => {
    expect(await new WorkbookCache().refresh('')).toBeNull()
    expect(await new WorkbookCache().refresh(null)).toBeNull()
  })

  it('picks up edits on the next refresh and survives a half-written file', async () => {
    const file = join(dir, 'tags.xlsx')
    await writeFile(file, await buildWorkbook({ Locations: [['Parks', 'park']] }))
    const cache = new WorkbookCache()

    expect((await cache.refresh(file))?.getOptions('Locations', 'Parks')).toEqual(['park'])
    expect(cache.status()).toEqual({ path: file, sheetCount: 1, error: null })

    await writeFile(
      file,
      await buildWorkbook({
        Locations: [
          ['Parks', 'park'],
          ['Parks', 'pond']
        ]
      })
    )
    await utimes(file, new Date(), new Date(Date.now() + 5000))
    expect((await cache.refresh(file))?.getOptions('Locations', 'Parks')).toEqual(['park', 'pond'])

    // Excel mid-save: truncated zip. The last good copy stays in use.
    await writeFile(file, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))
    await utimes(file, new Date(), new Date(Date.now() + 10000))
    expect((await cache.refresh(file))?.getOptions('Locations', 'Parks')).toEqual(['park', 'pond'])
    expect(cache.status().error).toContain('Not an .xlsx')
  })

  it('reports a missing file instead of throwing', async () => {
    const cache = new WorkbookCache()
    const source = await cache.refresh(join(dir, 'nope.xlsx'))
    expect(source?.unavailableReason).toBeTruthy()
    expect(cache.status().error).toBeTruthy()
  })
})
