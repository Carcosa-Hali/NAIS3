import { describe, expect, it } from 'vitest'
import type { CharacterPromptInput, GenerationRequest } from '../src/shared/types'
import type { FragmentSource } from '../src/main/fragments/processor'
import { preprocessRequest, previewTexts } from '../src/main/fragments/request'
import { createSpreadsheetSource } from '../src/main/fragments/spreadsheet'
import {
  extractVariableDefinitions,
  PromptVariableError,
  resolveVariableBlocks,
  rollVariables,
  type VariableDefinition
} from '../src/main/fragments/variables'

const fragments: Record<string, string[]> = {
  wedding_dress_types: ['ball gown', 'mermaid dress'],
  venues: ['WEDDING', 'PARTY', 'PERFORMANCE']
}
const source: FragmentSource = { getLines: (path) => fragments[path] ?? null }

const first = (): number => 0
const last = (): number => 0.999

describe('variable definitions', () => {
  it('removes $Name = ... lines and keeps everything else', () => {
    const definitions: VariableDefinition[] = []
    const rest = extractVariableDefinitions(
      '1girl\n$Location = random(WEDDING, PARTY)\n  $mood=happy  \nsmile',
      definitions
    )
    expect(rest).toBe('1girl\nsmile')
    expect(definitions).toEqual([
      { name: 'Location', expression: 'random(WEDDING, PARTY)' },
      { name: 'mood', expression: 'happy' }
    ])
  })

  it('does not mistake prompt tags for definitions', () => {
    const definitions: VariableDefinition[] = []
    const text = '@_@, price $5\n$ = nothing'
    expect(extractVariableDefinitions(text, definitions)).toBe(text)
    expect(definitions).toEqual([])
  })
})

describe('rollVariables', () => {
  const roll = (expression: string, rng = first, strict = true): string | undefined =>
    rollVariables([{ name: 'Location', expression }], { source, rng, strict }).get('location')

  it('picks one option with the rng', () => {
    expect(roll('random(WEDDING, PARTY, PERFORMANCE)', first)).toBe('WEDDING')
    expect(roll('random(WEDDING, PARTY, PERFORMANCE)', last)).toBe('PERFORMANCE')
  })

  it('takes a literal value when there is no random()', () => {
    expect(roll('PARTY')).toBe('PARTY')
  })

  it('draws the pool from a fragment reference', () => {
    expect(roll('random(<venues>)', last)).toBe('PERFORMANCE')
    expect(roll('random(<venues>, EXTRA)', last)).toBe('EXTRA')
  })

  it('throws on empty pools and duplicates in strict mode, tolerates them otherwise', () => {
    expect(() => roll('random(<missing>)')).toThrow(PromptVariableError)
    expect(() =>
      rollVariables(
        [
          { name: 'A', expression: '1' },
          { name: 'a', expression: '2' }
        ],
        { source, rng: first, strict: true }
      )
    ).toThrow('defined more than once')
    expect(roll('random(<missing>)', first, false)).toBe('')
  })
})

describe('resolveVariableBlocks', () => {
  const values = new Map([['location', 'Wedding']])
  const resolve = (text: string, strict = true): string =>
    resolveVariableBlocks(text, values, strict)

  it('inserts the value', () => {
    expect(resolve('${Location}, indoors')).toBe('Wedding, indoors')
  })

  it('selects a branch case-insensitively, with multiple labels and a default', () => {
    expect(resolve('${Location: wedding => church | PARTY => balloons}')).toBe('church')
    expect(resolve('${Location: PARTY, WEDDING => festive | * => plain}')).toBe('festive')
    expect(resolve('${Location: PARTY => balloons | * => plain}')).toBe('plain')
  })

  it('does not split on | inside inline wildcards or emphasis, and keeps fragments for later', () => {
    expect(resolve('${Location: WEDDING => <veil|crown>, {{bouquet}} | PARTY => cake}')).toBe(
      '<veil|crown>, {{bouquet}}'
    )
    expect(resolve('${Location: WEDDING => <wedding_dress_types>}')).toBe('<wedding_dress_types>')
  })

  it('resolves nested blocks', () => {
    const nested = new Map([
      ['location', 'WEDDING'],
      ['time', 'night']
    ])
    expect(
      resolveVariableBlocks(
        '${Location: WEDDING => church, ${Time: night => candles | * => sunlight} | PARTY => balloons}',
        nested,
        true
      )
    ).toBe('church, candles')
  })

  it('yields nothing without a match and cleans the stray commas it leaves', () => {
    expect(resolve('1girl, ${Location: PARTY => balloons}, smile')).toBe('1girl, smile')
    expect(resolve('${Location: PARTY => balloons}, smile')).toBe('smile')
    expect(resolve('1girl,\n${Location: PARTY => balloons}\nsmile')).toBe('1girl\n\nsmile')
  })

  it('leaves text without blocks untouched', () => {
    expect(resolve('1girl, {red hair}, [blue eyes], 1.2::smile::')).toBe(
      '1girl, {red hair}, [blue eyes], 1.2::smile::'
    )
  })

  it('throws on undefined variables, missing arrows and unclosed blocks in strict mode only', () => {
    expect(() => resolve('${Nope}')).toThrow('not defined')
    expect(() => resolve('${Location: WEDDING church}')).toThrow('needs "=>"')
    expect(() => resolve('${Location: WEDDING => church')).toThrow('Unclosed')
    expect(resolve('a, ${Nope}, b', false)).toBe('a, b')
  })
})

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  const characters: CharacterPromptInput[] = [
    {
      prompt: '${Location: WEDDING => tuxedo | PARTY => suit | PERFORMANCE => stage costume}',
      negativePrompt: '${Location: WEDDING => casual clothes}',
      enabled: true
    },
    {
      prompt:
        '${Location: WEDDING => wedding veil, <wedding_dress_types> | PARTY => cocktail dress}',
      negativePrompt: '',
      enabled: true
    }
  ]
  return {
    prompt: [
      '# pick the scene once',
      '$Location = random(WEDDING, PARTY, PERFORMANCE)',
      '2girls, ${Location: WEDDING => church, altar | PARTY => balloons | PERFORMANCE => stage, spotlight}'
    ].join('\n'),
    negativePrompt: '${Location: WEDDING => background characters in wedding dresses}, lowres',
    characterPrompts: characters,
    ...overrides
  } as GenerationRequest
}

describe('preprocessRequest', () => {
  it('rolls each variable once and shares it across main, negative and character prompts', () => {
    const out = preprocessRequest(request(), source, { rng: first })
    expect(out.prompt).toBe('2girls, church, altar')
    expect(out.negativePrompt).toBe('background characters in wedding dresses, lowres')
    expect(out.characterPrompts[0].prompt).toBe('tuxedo')
    expect(out.characterPrompts[0].negativePrompt).toBe('casual clothes')
    expect(out.characterPrompts[1].prompt).toBe('wedding veil, ball gown')
  })

  it('follows another roll consistently in every section', () => {
    const out = preprocessRequest(request(), source, { rng: last })
    expect(out.prompt).toBe('2girls, stage, spotlight')
    expect(out.negativePrompt).toBe('lowres')
    expect(out.characterPrompts[0].prompt).toBe('stage costume')
    expect(out.characterPrompts[1].prompt).toBe('')
  })

  it('re-rolls for every image', () => {
    const rolls = [0, 0.4, 0.9]
    let call = 0
    const rng = (): number => rolls[call++ % rolls.length]
    const prompts = [0, 1, 2].map(() => {
      const out = preprocessRequest(request({ characterPrompts: [] }), source, { rng })
      return out.prompt
    })
    expect(new Set(prompts).size).toBe(3)
  })

  it('accepts definitions in any field, including character prompts, and the split prompt parts', () => {
    const out = preprocessRequest(
      request({
        prompt: '',
        promptParts: {
          base: '2girls, ${Location: WEDDING => church}',
          additional: '${Location}',
          detail: ''
        },
        negativePrompt: '',
        characterPrompts: [
          {
            prompt: '$Location = random(WEDDING)\n${Location: WEDDING => tuxedo}',
            negativePrompt: '',
            enabled: true
          }
        ]
      }),
      source,
      { rng: first }
    )
    expect(out.prompt).toBe('2girls, church, WEDDING')
    expect(out.promptParts).toEqual({ base: '2girls, church', additional: 'WEDDING', detail: '' })
    expect(out.characterPrompts[0].prompt).toBe('tuxedo')
  })

  it('ignores definitions inside comments', () => {
    const out = preprocessRequest(
      request({
        prompt: '# $Location = random(PARTY)\n$Location = WEDDING\n${Location}',
        negativePrompt: '',
        characterPrompts: []
      }),
      source,
      { rng: first }
    )
    expect(out.prompt).toBe('WEDDING')
  })

  it('fails loudly instead of sending a broken prompt', () => {
    expect(() =>
      preprocessRequest(request({ prompt: '${Unknown}', characterPrompts: [] }), source)
    ).toThrow('not defined')
  })

  it('uses spreadsheet rows as the variable pool and inside branches', () => {
    const sheets = createSpreadsheetSource([
      {
        name: 'Events',
        rows: [
          { key: 'Venues', value: 'WEDDING' },
          { key: 'Venues', value: 'PARTY' }
        ]
      },
      { name: 'Wedding', rows: [{ key: 'Outfits', value: 'lace veil' }] }
    ])
    const out = preprocessRequest(
      request({
        prompt: '$Location = random(<Events/Venues>)\n${Location: WEDDING => <Wedding/Outfits>}',
        negativePrompt: '',
        characterPrompts: []
      }),
      source,
      { rng: first, sheets }
    )
    expect(out.prompt).toBe('lace veil')
  })
})

describe('previewTexts (token counting)', () => {
  it('resolves variables defined in one field inside the others without throwing', () => {
    const [main, negative, unknown] = previewTexts(
      [
        '$Location = random(WEDDING, PARTY)\nchurch: ${Location}',
        '${Location: WEDDING => bad veil}',
        '${Nope}, ok'
      ],
      source
    )
    expect(main).toBe('church: WEDDING')
    expect(negative).toBe('bad veil')
    expect(unknown).toBe('ok')
  })
})
