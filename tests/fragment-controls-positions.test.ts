import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import type { FragmentSource } from '../src/main/fragments/processor'
import { preprocessRequest, rollPreview, takePosition } from '../src/main/fragments/request'
import { createSpreadsheetSource, type ParsedSheet } from '../src/main/fragments/spreadsheet'
import { readControls, sheetColumnValues } from '../src/main/fragments/controls'

const empty: FragmentSource = { getLines: () => null }
const first = (): number => 0

function sheet(name: string, table: string[][]): ParsedSheet {
  return {
    name,
    header: table[0],
    rows: table.map((cells, index) => ({
      key: cells[0] ?? '',
      value: cells[1] ?? '',
      cells,
      row: index + 1
    }))
  }
}

const PEOPLE = sheet('people', [
  ['key', 'prompt', 'kind', 'pools', 'description'],
  [
    'one',
    'first',
    'a',
    'x, y',
    'a fairly long description that is far too long to be a useful filter value'
  ],
  ['two', 'second', 'b', 'y', 'short'],
  ['three', 'third', 'a', 'z', 'short']
])
const CONTROLS = sheet('controls', [
  ['variable', 'label', 'group', 'filters', 'hidden', 'note'],
  ['$who', 'Who', 'Cast', 'kind, pools', '', 'the person'],
  ['mood', '', '', '', 'yes', '']
])

describe('@pos(x, y)', () => {
  it('is removed from the text and sets the position; the last one wins', () => {
    expect(takePosition('girl, @pos(0.2, 0.7), smile')).toEqual({
      text: 'girl, smile',
      center: { x: 0.2, y: 0.7 }
    })
    expect(takePosition('@pos(0.1 0.1), girl, @pos(1.5, 0.3)').center).toEqual({ x: 1, y: 0.3 })
    expect(takePosition('girl')).toEqual({ text: 'girl' })
    expect(takePosition('girl, @pos(), smile')).toEqual({ text: 'girl, smile' })
    expect(takePosition('girl, @pos(0.2, 0.4), @pos( )')).toEqual({
      text: 'girl',
      center: { x: 0.2, y: 0.4 }
    })
  })

  it('positions characters and turns coordinates on', () => {
    const sheets = createSpreadsheetSource([
      sheet('positions', [
        ['key', 'value'],
        ['lead', '0.3, 0.6']
      ])
    ])
    const out = preprocessRequest(
      {
        prompt: '1girl',
        negativePrompt: '',
        useCoords: false,
        characterPrompts: [
          { prompt: 'girl, @pos(<positions/lead>)', negativePrompt: '', enabled: true },
          { prompt: 'boy', negativePrompt: '', enabled: true, center: { x: 0.5, y: 0.5 } }
        ]
      } as unknown as GenerationRequest,
      empty,
      { sheets, rng: first }
    )
    expect(out.useCoords).toBe(true)
    expect(out.characterPrompts[0]).toMatchObject({ prompt: 'girl', center: { x: 0.3, y: 0.6 } })
    expect(out.characterPrompts[1].center).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe('controls data', () => {
  const sheets = createSpreadsheetSource([PEOPLE, CONTROLS])

  it('reads the controls sheet', () => {
    expect(readControls(sheets)).toEqual([
      {
        variable: 'who',
        label: 'Who',
        group: 'Cast',
        filters: ['kind', 'pools'],
        hidden: false,
        note: 'the person'
      },
      { variable: 'mood', label: 'mood', group: '', filters: [], hidden: true, note: '' }
    ])
  })

  it('lists filterable columns with their values', () => {
    const columns = sheetColumnValues(sheets, 'people')
    expect(columns.map((c) => c.column)).toEqual(['key', 'prompt', 'kind', 'pools'])
    expect(columns.find((c) => c.column === 'kind')).toEqual({
      column: 'kind',
      list: false,
      values: [
        { value: 'a', count: 2 },
        { value: 'b', count: 1 }
      ]
    })
    expect(columns.find((c) => c.column === 'pools')?.list).toBe(true)
    expect(columns.find((c) => c.column === 'pools')?.values[0]).toEqual({ value: 'y', count: 2 })
  })

  it('reports how a variable was rolled and from which sheet', () => {
    const result = rollPreview(
      {
        prompt: '$who = deal(<people/*[kind=a]>)\n$mood = random(calm, tense)\n${who} ${mood}',
        negativePrompt: '',
        characters: [],
        pins: [{ name: 'who', lock: 'row(<people/three#4>)' }]
      },
      empty,
      sheets,
      first
    )
    expect(result.ok).toBe(true)
    const who = result.variables.find((v) => v.name === 'who')
    expect(who).toMatchObject({ kind: 'deal', sheet: 'people', value: 'third', pinned: true })
    expect(result.variables.find((v) => v.name === 'mood')?.kind).toBe('random')
  })
})
