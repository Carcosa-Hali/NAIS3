import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import type { FragmentSource } from '../src/main/fragments/processor'
import { preprocessRequest, rollPreview } from '../src/main/fragments/request'
import { createSpreadsheetSource, type ParsedSheet } from '../src/main/fragments/spreadsheet'
import { controlChoices, readControls } from '../src/main/fragments/controls'
import { picksLabel, picksLock } from '../src/shared/control-picks'

const empty: FragmentSource = { getLines: () => null }

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

const CAST = sheet('cast', [
  ['key', 'prompt', 'pools'],
  ['ann', 'girl, ann', 'group_a'],
  ['bea', 'girl, bea', 'group_a'],
  ['cid', 'boy, cid', 'group_b']
])

function run(prompt: string, rng: () => number, pins: { name: string; lock: string }[] = []): string {
  const out = preprocessRequest(
    {
      prompt,
      negativePrompt: '',
      characterPrompts: [],
      pinnedVariables: pins
    } as unknown as GenerationRequest,
    empty,
    { sheets: createSpreadsheetSource([CAST]), rng }
  )
  return out.prompt
}

describe('row() / deal() with several weighted references', () => {
  it('picks one reference by weight, then a row of it', () => {
    const prompt = '$who = row(<cast/ann> @3, <cast/cid>)\n${who}'
    expect(run(prompt, () => 0)).toBe('girl, ann')
    expect(run(prompt, () => 0.9)).toBe('boy, cid')
  })

  it('deal() moves on when the chosen reference is taken, and fails when all are', () => {
    const prompt = '$a = deal(<cast/ann>)\n$b = deal(<cast/ann> @5, <cast/bea>)\n${a} / ${b}'
    expect(run(prompt, () => 0)).toBe('girl, ann / girl, bea')
    expect(() => run('$a = deal(<cast/ann>)\n$b = deal(<cast/ann>, <cast/ann#2>)\n${b}', () => 0)).toThrow()
  })

  it('works as a pin built from ticked entries', () => {
    const lock = picksLock('deal', [
      { lock: '<cast/ann#2>', label: 'ann', weight: 0 },
      { lock: '<cast/bea#3>', label: 'bea', weight: 2 },
      { lock: '<cast/cid#4>', label: 'cid', weight: 1 }
    ])
    expect(lock).toBe('deal(<cast/bea#3> @2, <cast/cid#4>)')
    expect(run('$w = deal(<cast/*[pools~=group_a]>)\n${w}', () => 0, [{ name: 'w', lock }])).toBe(
      'girl, bea'
    )
  })

  it('lists the rows of every reference in the preview', () => {
    const result = rollPreview(
      {
        prompt: '$who = row(<cast/ann> @3, <cast/*[pools~=group_b]>)\n${who}',
        negativePrompt: '',
        characters: []
      },
      empty,
      createSpreadsheetSource([CAST]),
      () => 0
    )
    const who = result.variables.find((v) => v.name === 'who')
    expect(who?.options?.map((o) => o.lock)).toEqual(['row(<cast/ann#2>)', 'row(<cast/cid#4>)'])
  })
})

describe('picks', () => {
  it('builds random(), single row and filter locks', () => {
    expect(picksLock('random', [{ lock: 'games', label: 'games', weight: 1 }])).toBe('games')
    expect(
      picksLock('random', [
        { lock: 'random(<k/a#1>)', label: 'a', weight: 1 },
        { lock: 'shows', label: 'shows', weight: 0.5 }
      ])
    ).toBe('random(<k/a#1>, shows @0.5)')
    expect(picksLock('row', [{ lock: 'row(<cast/ann#2>)', label: 'ann', weight: 4 }])).toBe(
      'row(<cast/ann#2>)'
    )
    expect(
      picksLock('row', [{ lock: '<locations/*[setting=indoor]>', label: 'w', weight: 1 }])
    ).toBe('row(<locations/*[setting=indoor]>)')
    expect(picksLock('row', [])).toBe('')
    expect(picksLabel([1, 2, 3].map((n) => ({ lock: `${n}`, label: `x${n}`, weight: 1 })))).toBe(
      'x1, x2 (+1)'
    )
  })
})

describe('controls sheet v13 columns', () => {
  const sheets = createSpreadsheetSource([
    CAST,
    sheet('controls', [
      ['variable', 'label', 'group', 'input', 'choices', 'show', 'weights', 'filters', 'open', 'hidden', 'note'],
      ['second', 'Second', 'Cast', 'pick', '<cast/*[pools~=group_a]>', 'key, pools', 'no', '', 'yes', '', ''],
      ['lu', '', '', 'hidden', '', '', '', '', '', '', '']
    ])
  ])
  it('reads input, choices, show, weights and open', () => {
    const [second, lu] = readControls(sheets)
    expect(second).toMatchObject({
      input: 'pick',
      choices: '<cast/*[pools~=group_a]>',
      show: ['key', 'pools'],
      weights: false,
      open: true
    })
    expect(lu.hidden).toBe(true)
  })
  it('lists the choices as row references', () => {
    expect(controlChoices(sheets, '<cast/*[pools~=group_a]> <cast/cid>', ['key', 'pools'])).toEqual([
      { label: 'ann · group_a', lock: '<cast/ann#2>', detail: 'girl, ann' },
      { label: 'bea · group_a', lock: '<cast/bea#3>', detail: 'girl, bea' },
      { label: 'cid · group_b', lock: '<cast/cid#4>', detail: 'boy, cid' }
    ])
  })
})
