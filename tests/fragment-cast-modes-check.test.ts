import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import type { FragmentSource } from '../src/main/fragments/processor'
import { preprocessRequest, rollPreview } from '../src/main/fragments/request'
import { createSpreadsheetSource, type ParsedSheet } from '../src/main/fragments/spreadsheet'
import { readModes } from '../src/main/fragments/modes'
import { checkWorkbook, countSubjects } from '../src/main/fragments/check'

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

function request(prompt: string): GenerationRequest {
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
    characterPrompts: []
  } as unknown as GenerationRequest
}

const CAST = sheet('cast', [
  ['key', 'body', 'pools'],
  ['alpha', 'alpha body', 'group_a, group_b'],
  ['beta', 'beta body', 'group_a'],
  ['gamma', 'gamma body', 'group_b'],
  ['delta', 'delta body', '']
])

describe('list filter [column~=value]', () => {
  const sheets = createSpreadsheetSource([CAST])
  it('matches rows whose comma list holds a value', () => {
    expect(sheets.getRows('cast', '*[pools~=group_b]')?.map((r) => r.key)).toEqual([
      'alpha',
      'gamma'
    ])
    expect(sheets.getRows('cast', '*[pools~=group_a, group_b]')?.length).toBe(3)
    expect(sheets.getRows('cast', '*[pools!~=group_a]')?.map((r) => r.key)).toEqual([
      'gamma',
      'delta'
    ])
  })
})

describe('deal()', () => {
  const sheets = createSpreadsheetSource([CAST])
  it('never deals the same row twice in one image', () => {
    const out = preprocessRequest(
      request(
        '$a = deal(<cast/*[pools~=group_a]>)\n$b = deal(<cast/*[pools~=group_a]>)\n${a.body} | ${b.body}'
      ),
      empty,
      { sheets, rng: first }
    )
    expect(out.prompt).toBe('alpha body | beta body')
  })

  it('skips a row taken by row(), including a pinned one', () => {
    const out = preprocessRequest(
      {
        ...request('$x = row(<cast/alpha>)\n$y = deal(<cast/*[pools~=group_b]>)\n${y.body}'),
        pinnedVariables: []
      },
      empty,
      { sheets, rng: first }
    )
    expect(out.prompt).toBe('gamma body')
    const pinned = preprocessRequest(
      {
        ...request('$y = deal(<cast/*[pools~=group_b]>)\n$x = deal(<cast/*>)\n${y.body}'),
        pinnedVariables: [{ name: 'x', lock: 'row(<cast/alpha#2>)' }]
      },
      empty,
      { sheets, rng: first }
    )
    expect(pinned.prompt).toBe('gamma body')
  })

  it('fails clearly when the pool is used up', () => {
    expect(() =>
      preprocessRequest(request('$a = deal(<cast/beta>)\n$b = deal(<cast/beta>)\n${a}'), empty, {
        sheets,
        rng: first
      })
    ).toThrow(/already taken/)
  })
})

const MODES = sheet('modes', [
  ['mode', 'main', 'main_neg', 'char_1', 'char_2', 'extends', 'set', 'hidden', 'note'],
  ['base', '$k = random(a, b)\n2girls, ${k}', 'bad', 'girl one', 'girl two', '', '', 'yes', ''],
  ['scene', '', '', '', '', 'base', '', '', 'all'],
  ['scene b', '', '', '', '-', 'scene', '$k := b', '', ''],
  ['solo', '1girl', '', '', '-', 'base', '', '', '']
])

describe('modes: extends / set / hidden', () => {
  const sheets = createSpreadsheetSource([MODES])
  const modes = readModes(sheets)
  it('inherits empty cells, clears "-" cells, adds set lines and hides bases', () => {
    expect(modes.map((m) => m.name)).toEqual(['scene', 'scene b', 'solo'])
    const scene = modes[0]
    expect(scene.prompt).toBe('$k = random(a, b)\n2girls, ${k}')
    expect(scene.negativePrompt).toBe('bad')
    expect(scene.characters.length).toBe(2)
    expect(scene.note).toBe('all')
    const sceneB = modes[1]
    expect(sceneB.prompt).toBe('$k := b\n$k = random(a, b)\n2girls, ${k}')
    expect(sceneB.characters.map((c) => c.prompt)).toEqual(['girl one'])
    const roll = rollPreview(
      { prompt: sceneB.prompt, negativePrompt: '', characters: [] },
      empty,
      sheets,
      first
    )
    expect(roll.ok && roll.prompt).toBe('2girls, b')
  })
})

describe('workbook check', () => {
  it('counts subject tags', () => {
    expect(countSubjects('3girls, 1other, park')).toBe(4)
    expect(countSubjects('1girl, 1boy')).toBe(2)
    expect(countSubjects('park')).toBeNull()
  })

  it('reports missing references, failures and count mismatches', async () => {
    const sheets = createSpreadsheetSource([
      MODES,
      sheet('refs', [
        ['key', 'value'],
        ['ok', '<refs/other>'],
        ['bad', '<refs/nowhere>'],
        ['maybe', '<refs/nowhere ?? >'],
        ['other', 'x']
      ])
    ])
    const report = await checkWorkbook(readModes(sheets), empty, sheets, 20, first)
    expect(report.missing.map((m) => m.reference)).toEqual(['refs/nowhere'])
    const solo = report.modes.find((m) => m.name === 'solo')!
    expect(solo.countMismatch).toBe(0)
    const scene = report.modes.find((m) => m.name === 'scene')!
    expect(scene.failed).toBe(0)
    expect(scene.variables.find((v) => v.name === 'k')?.top[0]).toEqual({ value: 'a', count: 20 })
  })
})
