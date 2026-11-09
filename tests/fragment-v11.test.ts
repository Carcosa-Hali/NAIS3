import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import { resetSequentialCounters, type FragmentSource } from '../src/main/fragments/processor'
import { preprocessRequest, rollPreview } from '../src/main/fragments/request'
import {
  createSpreadsheetSource,
  parsePoolKey,
  type ParsedSheet
} from '../src/main/fragments/spreadsheet'
import { calculate } from '../src/main/fragments/variables'
import { WorkbookCache } from '../src/main/fragments/xlsx-reader'
import { readModes } from '../src/main/fragments/modes'

const empty: FragmentSource = { getLines: () => null }
const first = (): number => 0
const last = (): number => 0.999

function sequence(...numbers: number[]): () => number {
  let i = 0
  return () => numbers[i++ % numbers.length]
}

/** Header row + data rows -> ParsedSheet (rows numbered like Excel). */
function sheet(name: string, table: string[][], file?: string): ParsedSheet {
  return {
    name,
    header: table[0],
    ...(file ? { file } : {}),
    rows: table.map((cells, index) => ({
      key: cells[0] ?? '',
      value: cells[1] ?? '',
      cells,
      row: index + 1
    }))
  }
}

function request(prompt: string, extra: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    prompt,
    negativePrompt: '',
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    seed: 1,
    characterPrompts: [],
    ...extra
  } as GenerationRequest
}

const PLACES = sheet('places', [
  ['category', '+tags', '+light', 'kind', 'text', 'weight'],
  ['park', 'trees, bench', 'sunlight', 'outdoor', '', ''],
  ['park', 'pond, ducks', '', 'outdoor', 'Text: hello', ''],
  ['cafe', 'indoors, cafe', 'warm lighting', 'indoor', '', '3'],
  ['game alpha', 'ring world', 'sci-fi lighting', 'game', '', ''],
  ['game beta', 'desert, ruins', 'red lighting', 'game', '', '0']
])

describe('joined + columns', () => {
  it('joins every + column in order, skipping blanks, as the row value', () => {
    const sheets = createSpreadsheetSource([PLACES])
    expect(sheets.getOptions('places', 'park')).toEqual(['trees, bench, sunlight', 'pond, ducks'])
    const out = preprocessRequest(request('$p = row(<places/cafe>)\n${p}, ${p.kind}'), empty, {
      sheets
    })
    expect(out.prompt).toBe('indoors, cafe, warm lighting, indoor')
  })

  it('keeps column B as the value on sheets without + columns', () => {
    const sheets = createSpreadsheetSource([
      sheet('plain', [
        ['key', 'value', 'other'],
        ['a', 'alpha', 'x']
      ])
    ])
    expect(sheets.getOptions('plain', 'a')).toEqual(['alpha'])
  })
})

describe('sheet-wide pools', () => {
  it('parses pool keys', () => {
    expect(parsePoolKey('park')).toBeNull()
    expect(parsePoolKey('*')).toEqual({ evenKeys: false, filters: [] })
    expect(parsePoolKey('**[Kind != game, show][tier=]')).toEqual({
      evenKeys: true,
      filters: [
        { field: 'kind', negate: true, list: false, values: ['game', 'show'] },
        { field: 'tier', negate: false, list: false, values: [''] }
      ]
    })
  })

  it('<sheet/*> is every row by weight, never the header row', () => {
    const sheets = createSpreadsheetSource([PLACES])
    const rows = sheets.getRows('places', '*')!
    expect(rows.map((r) => r.key)).toEqual(['park', 'park', 'cafe', 'game alpha'])
    expect(rows.map((r) => r.weight)).toEqual([1, 1, 3, 1])
  })

  it('<sheet/**> gives every key the same total chance', () => {
    const sheets = createSpreadsheetSource([PLACES])
    const rows = sheets.getRows('places', '**')!
    expect(rows.map((r) => r.weight)).toEqual([0.5, 0.5, 1, 1])
    expect(rows[0].fields.get('kind')).toBe('outdoor')
  })

  it('filters by column', () => {
    const sheets = createSpreadsheetSource([PLACES])
    expect(sheets.getRows('places', '*[kind=game]')!.map((r) => r.key)).toEqual(['game alpha'])
    expect(sheets.getRows('places', '*[kind!=game,indoor]')!.map((r) => r.row)).toEqual([2, 3])
    expect(sheets.getRows('places', '*[text=]')!.map((r) => r.row)).toEqual([2, 4, 5])
    expect(sheets.getRows('places', '*[kind=nothing]')).toBeNull()
  })

  it('works in prompts, random() and row(), and walks with <*sheet/*>', () => {
    resetSequentialCounters()
    const sheets = createSpreadsheetSource([PLACES])
    expect(preprocessRequest(request('<places/*[kind=indoor]>'), empty, { sheets }).prompt).toBe(
      'indoors, cafe, warm lighting'
    )
    const walk = (): string =>
      preprocessRequest(request('$p = row(<*places/*>)\n${p.category}'), empty, { sheets }).prompt
    expect([walk(), walk(), walk(), walk(), walk()]).toEqual([
      'park',
      'park',
      'cafe',
      'game alpha',
      'park'
    ])
  })

  it('pins a pooled row by its own key, so the lock reads plainly', () => {
    const sheets = createSpreadsheetSource([PLACES])
    const out = preprocessRequest(request('$p = row(<places/*[kind=game]>)\n${p}'), empty, {
      sheets,
      rng: first
    })
    expect(out.rolledVariables?.[0].lock).toBe('row(<places/game alpha#5>)')
  })
})

describe('workbook folders', () => {
  const sheets = createSpreadsheetSource([
    sheet(
      'places',
      [
        ['k', 'v'],
        ['a', 'master a']
      ],
      'master'
    ),
    sheet(
      'panels',
      [
        ['k', 'v'],
        ['p1', 'one-panel']
      ],
      'story1'
    ),
    sheet(
      'panels',
      [
        ['k', 'v'],
        ['p1', 'two-panel']
      ],
      'story2'
    )
  ])

  it('reaches a unique sheet by its bare name and any sheet as File:Sheet', () => {
    expect(sheets.getOptions('places', 'a')).toEqual(['master a'])
    expect(sheets.getOptions('master:places', 'a')).toEqual(['master a'])
    expect(sheets.getOptions('Story2 : Panels', 'p1')).toEqual(['two-panel'])
  })

  it('refuses an ambiguous bare sheet name with a hint', () => {
    expect(() => preprocessRequest(request('<panels/p1>'), empty, { sheets })).toThrow(
      /story1:panels/
    )
    expect(preprocessRequest(request('<story1:panels/p1>'), empty, { sheets }).prompt).toBe(
      'one-panel'
    )
  })
})

describe('functions', () => {
  it('shuffle() and list() expose .1 .2 ... and .count', () => {
    const out = preprocessRequest(
      request('$s = shuffle(a, b, c)\n${s.1} ${s.2} ${s.3} ${s.count}'),
      empty,
      { rng: first }
    )
    expect(out.prompt.split(' ').sort()).toEqual(['3', 'a', 'b', 'c'])
    const lock = out.rolledVariables![0].lock
    expect(lock).toMatch(/^list\(/)
    const again = preprocessRequest(request(`$s := ${lock}\n\${s.1} \${s.2} \${s.3}`), empty, {
      rng: last
    })
    expect(again.prompt).toBe(out.prompt.split(' ').slice(0, 3).join(' '))
  })

  it('shuffle() takes its items from references too', () => {
    const fragments: FragmentSource = { getLines: (p) => (p === 'seats' ? ['x', 'y'] : null) }
    const out = preprocessRequest(request('$s = shuffle(<seats>, z)\n${s}'), fragments, {
      rng: first
    })
    expect(out.prompt.split(', ').sort()).toEqual(['x', 'y', 'z'])
  })

  it('chance() with default and custom labels, percent from a cell', () => {
    const sheets = createSpreadsheetSource([
      sheet('odds', [
        ['k', 'v'],
        ['rain', '15']
      ])
    ])
    const roll = (prompt: string, rng: () => number): string =>
      preprocessRequest(request(prompt), empty, { sheets, rng }).prompt
    expect(roll('$c = chance(15)\n${c}', () => 0.1)).toBe('yes')
    expect(roll('$c = chance(15%)\n${c}', () => 0.2)).toBe('no')
    expect(roll('$c = chance(<odds/rain>, on, off)\n${c}', () => 0.149)).toBe('on')
    expect(roll('$c = chance(<odds/rain>, on, off)\n${c}', () => 0.15)).toBe('off')
    expect(roll('$c = chance(100, on, )\n[${c}]', () => 0.5)).toBe('[on]')
    expect(roll('$c = chance(0, on, )\n[${c}]', () => 0.5)).toBe('[]')
  })

  it('calc() does arithmetic with variables', () => {
    expect(calculate('3 + 2 * (4 - 1)')).toBe(9)
    expect(calculate('max(1, 5, 2) / 2')).toBe(2.5)
    expect(calculate('-3 % 2 + floor(2.7)')).toBe(1)
    expect(() => calculate('1 +')).toThrow()
    expect(() => calculate('alert(1)')).toThrow()
    const out = preprocessRequest(
      request('$extras = 2\n$n = calc(3 + ${extras})\n${n}girls'),
      empty
    )
    expect(out.prompt).toBe('5girls')
    expect(() => preprocessRequest(request('$n = calc(1/0)\n${n}'), empty)).toThrow(/division/)
  })
})

describe('pins', () => {
  it('a pin wins over = and := definitions of the same name, without errors', () => {
    const out = preprocessRequest(
      request('$m = random(a, b)\n$m := c\n${m}', { pinnedVariables: [{ name: 'm', lock: 'd' }] }),
      empty,
      { rng: first }
    )
    expect(out.prompt).toBe('d')
    expect(out.rolledVariables).toEqual([
      { name: 'm', value: 'd', lock: 'd', kind: 'value', pinned: true }
    ])
    expect(out.pinnedVariables).toBeUndefined()
  })

  it('later definitions see the pinned value', () => {
    const sheets = createSpreadsheetSource([PLACES])
    const out = preprocessRequest(
      request('$p = row(<places/*>)\n$k = ${p.kind}\n${k}', {
        pinnedVariables: [{ name: 'p', lock: 'row(<places/cafe#4>)' }]
      }),
      empty,
      { sheets, rng: last }
    )
    expect(out.prompt).toBe('indoor')
  })

  it('the roll preview lists the values a variable could take', () => {
    const sheets = createSpreadsheetSource([PLACES])
    const result = rollPreview(
      {
        prompt:
          '$p = row(<places/park>)\n$m = random(calm @2, tense, calm)\n$c = chance(50)\n${p} ${m} ${c}',
        negativePrompt: '',
        characters: [],
        pins: [{ name: 'c', lock: 'yes' }]
      },
      empty,
      sheets,
      first
    )
    expect(result.ok).toBe(true)
    const byName = new Map(result.variables.map((v) => [v.name, v]))
    expect(byName.get('p')!.options!.map((o) => o.lock)).toEqual([
      'row(<places/park#2>)',
      'row(<places/park#3>)'
    ])
    expect(byName.get('p')!.options![0].label).toBe('park · #2 — trees, bench, sunlight')
    expect(byName.get('m')!.options!.map((o) => o.lock)).toEqual(['calm', 'tense'])
    expect(byName.get('c')!.pinned).toBe(true)
  })
})

describe('modes sheet', () => {
  it('reads modes from every file, one per row, with blank character slots dropped', () => {
    const sheets = createSpreadsheetSource([
      sheet(
        'modes',
        [
          ['mode', 'main', 'main_neg', 'char_1', 'char_1_neg', 'char_2', 'char_2_pos', 'note'],
          ['scene', '<places/*>', 'lowres', 'girl', 'boy', '', '', 'all slots'],
          ['duo', 'x', '', 'a', '', 'b', '0.3, 0.7', '']
        ],
        'master'
      ),
      sheet(
        'modes',
        [
          ['mode', 'main', 'char_1'],
          ['story', '$panel = row(<*story:panels/*>)', '${panel.c1}']
        ],
        'story'
      )
    ])
    const modes = readModes(sheets)
    expect(modes.map((m) => m.id)).toEqual(['master:scene', 'master:duo', 'story:story'])
    expect(modes[0]).toMatchObject({
      name: 'scene',
      file: 'master',
      prompt: '<places/*>',
      negativePrompt: 'lowres',
      note: 'all slots',
      characters: [{ prompt: 'girl', negativePrompt: 'boy' }]
    })
    expect(modes[1].characters).toEqual([
      { prompt: 'a', negativePrompt: '' },
      { prompt: 'b', negativePrompt: '', center: { x: 0.3, y: 0.7 } }
    ])
  })
})

describe('WorkbookCache with a folder', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nais3-v11-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  beforeEach(() => resetSequentialCounters())

  async function workbook(sheets: Record<string, string[][]>): Promise<Uint8Array> {
    const names = Object.keys(sheets)
    const zip = new JSZip()
    const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    zip.file(
      'xl/workbook.xml',
      `<workbook xmlns:r="r"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`
    )
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/s${i + 1}.xml"/>`).join('')}</Relationships>`
    )
    names.forEach((name, i) => {
      const rows = sheets[name]
        .map(
          (cells, r) =>
            `<row r="${r + 1}">${cells.map((c, col) => `<c r="${String.fromCharCode(65 + col)}${r + 1}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`).join('')}</row>`
        )
        .join('')
      zip.file(
        `xl/worksheets/s${i + 1}.xml`,
        `<worksheet><sheetData>${rows}</sheetData></worksheet>`
      )
    })
    return zip.generateAsync({ type: 'uint8array' })
  }

  it('loads every workbook in the folder and its subfolders, and reloads edited files', async () => {
    await writeFile(
      join(dir, 'master.xlsx'),
      await workbook({
        places: [
          ['k', 'v'],
          ['a', 'one']
        ]
      })
    )
    await mkdir(join(dir, 'stories'))
    await writeFile(
      join(dir, 'stories', 'story1.xlsx'),
      await workbook({
        panels: [
          ['k', 'v'],
          ['p1', 'panel one']
        ]
      })
    )
    await writeFile(join(dir, '~$master.xlsx'), 'lock file')

    const cache = new WorkbookCache()
    let source = await cache.refresh(dir)
    expect(source?.getOptions('places', 'a')).toEqual(['one'])
    expect(source?.getOptions('story1:panels', 'p1')).toEqual(['panel one'])
    expect(cache.status()).toMatchObject({ folder: true, fileCount: 2, sheetCount: 2, error: null })

    await writeFile(
      join(dir, 'master.xlsx'),
      await workbook({
        places: [
          ['k', 'v'],
          ['a', 'two']
        ]
      })
    )
    await utimes(join(dir, 'master.xlsx'), new Date(), new Date(Date.now() + 5000))
    source = await cache.refresh(dir)
    expect(source?.getOptions('places', 'a')).toEqual(['two'])

    // A broken file keeps its last good copy; the others are unaffected.
    await writeFile(join(dir, 'master.xlsx'), new Uint8Array([0x50, 0x4b]))
    await utimes(join(dir, 'master.xlsx'), new Date(), new Date(Date.now() + 10000))
    source = await cache.refresh(dir)
    expect(source?.getOptions('places', 'a')).toEqual(['two'])
    expect(cache.status().error).toContain('master.xlsx')
  })
})

describe('pin panel value lists', () => {
  it('a pinned variable still lists the values of the definition it overrides', () => {
    const sheets = createSpreadsheetSource([PLACES])
    const result = rollPreview(
      {
        prompt: '$p = row(<places/park>)\n${p}',
        negativePrompt: '',
        characters: [],
        pins: [{ name: 'p', lock: 'row(<places/park#3>)' }]
      },
      empty,
      sheets,
      first
    )
    expect(result.ok).toBe(true)
    const p = result.variables[0]
    expect(p).toMatchObject({ pinned: true, value: 'pond, ducks' })
    expect(p.options!.map((o) => o.lock)).toEqual(['row(<places/park#2>)', 'row(<places/park#3>)'])
    // only the pinned row is reported as picked
    if (result.ok) expect(result.picks.map((x) => x.row)).toEqual([3])
  })
})
