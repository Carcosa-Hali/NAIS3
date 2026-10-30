import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import type { FragmentSource } from '../src/main/fragments/processor'
import { preprocessRequest, previewTexts } from '../src/main/fragments/request'
import { createSpreadsheetSource } from '../src/main/fragments/spreadsheet'

const first = (): number => 0
const last = (): number => 0.999

const SCENE_CLUB =
  'indoors, concert hall, stage, spotlight, smoke, crowd, audience, silhouette, The audience claps and cheers.,\n$outfits = formal'
const SCENE_BEACH = 'outdoors, beach, ocean, sunset\n$outfits = sportswear'

const sheets = createSpreadsheetSource([
  {
    name: 'Scenes',
    rows: [
      { key: 'night', value: SCENE_CLUB },
      { key: 'night', value: SCENE_BEACH },
      { key: 'noted', value: 'indoors, library\n# internal note\nbooks' }
    ]
  },
  {
    name: 'Outfits',
    rows: [
      { key: 'formal', value: 'black suit, necktie' },
      { key: 'sportswear', value: 'track jacket' },
      { key: 'casual', value: 'overalls' }
    ]
  }
])

const none: FragmentSource = { getLines: () => null }

const CHARACTER =
  'girl, ${outfits: formal => <Outfits/formal> | sportswear => <Outfits/sportswear> | * => <Outfits/casual>}'

function request(prompt: string, character = CHARACTER, negative = ''): GenerationRequest {
  return {
    prompt,
    negativePrompt: negative,
    characterPrompts: [{ prompt: character, negativePrompt: '', enabled: true }]
  } as unknown as GenerationRequest
}

describe('cells that keep their line breaks', () => {
  it('inserts a multi-line cell with its line breaks', () => {
    const out = preprocessRequest(request('<Scenes/noted>', 'girl'), none, { sheets, rng: first })
    expect(out.prompt).toBe('indoors, library\nbooks')
  })

  it('drops # comment lines inside a cell but keeps the rest', () => {
    const rows = createSpreadsheetSource([
      { name: 'S', rows: [{ key: 'k', value: 'a, b  \r\n# note\r\nc' }] }
    ])
    expect(rows.getOptions('S', 'k')).toEqual(['a, b\nc'])
  })

  it('still ignores a row whose cell starts with #', () => {
    const rows = createSpreadsheetSource([
      { name: 'S', rows: [{ key: 'k', value: '# disabled\nstill disabled' }] }
    ])
    expect(rows.getOptions('S', 'k')).toBeNull()
  })
})

describe('$definitions inside a picked cell or fragment', () => {
  it('uses the definition from the chosen cell for blocks elsewhere in the request', () => {
    const out = preprocessRequest(request('2girls, <Scenes/night>'), none, { sheets, rng: first })
    expect(out.prompt).toBe(
      '2girls, indoors, concert hall, stage, spotlight, smoke, crowd, audience, silhouette, The audience claps and cheers., '
    )
    expect(out.characterPrompts[0].prompt).toBe('girl, black suit, necktie')
  })

  it('follows whichever cell is picked, definition and scene together', () => {
    const out = preprocessRequest(request('2girls, <Scenes/night>'), none, { sheets, rng: last })
    expect(out.prompt).toBe('2girls, outdoors, beach, ocean, sunset')
    expect(out.characterPrompts[0].prompt).toBe('girl, track jacket')
  })

  it('does not collect definitions from cells that were not picked', () => {
    // rng picks the first row; the beach row defines sportswear but must not apply
    const out = preprocessRequest(request('<Scenes/night>'), none, { sheets, rng: first })
    expect(out.characterPrompts[0].prompt).not.toContain('track jacket')
  })

  it('works when the cell is used in the character prompt and blocks come before it', () => {
    const out = preprocessRequest(
      request('indoors', '${outfits: formal => <Outfits/formal>}, girl, <Scenes/night>'),
      none,
      { sheets, rng: first }
    )
    expect(out.characterPrompts[0].prompt.startsWith('black suit, necktie, girl, indoors')).toBe(
      true
    )
  })

  it('handles definitions held in saved fragments as well', () => {
    const saved: FragmentSource = {
      getLines: (path) => (path === 'scene' ? ['rooftop, night\n$outfits = sportswear'] : null)
    }
    const out = preprocessRequest(request('<scene>'), saved, { sheets, rng: first })
    expect(out.prompt).toBe('rooftop, night')
    expect(out.characterPrompts[0].prompt).toBe('girl, track jacket')
  })

  it('reports a variable defined twice, once by the prompt and once by a cell', () => {
    expect(() =>
      preprocessRequest(request('$outfits = casual\n<Scenes/night>'), none, { sheets, rng: first })
    ).toThrow('defined more than once')
  })

  it('still fails clearly when nothing defines the variable', () => {
    expect(() =>
      preprocessRequest(request('<Scenes/noted>'), none, { sheets, rng: first })
    ).toThrow('Variable "outfits" is not defined')
  })

  it('rejects a definition that only appears inside a chosen ${...} branch', () => {
    const saved: FragmentSource = { getLines: (path) => (path === 'late' ? ['$x = 1'] : null) }
    expect(() =>
      preprocessRequest(request('$y = a\n${y: a => <late>}', 'girl'), saved, { rng: first })
    ).toThrow('inside a ${...} branch')
  })

  it('previews token text with the cell definition, without throwing', () => {
    const [main, character] = previewTexts(['<Scenes/night>', CHARACTER], none, sheets)
    expect(main).toContain('concert hall')
    expect(character).toBe('girl, black suit, necktie')
  })
})

describe('blocks inside fragments and cells, in any order', () => {
  it('resolves a selector block that appears before the cell that defines the variable', () => {
    const saved: FragmentSource = {
      getLines: (path) =>
        path === 'selector'
          ? ['${outfits: formal => <Outfits/formal> | * => <Outfits/casual>}']
          : null
    }
    const out = preprocessRequest(
      {
        prompt: '<Scenes/night>',
        negativePrompt: '',
        characterPrompts: [{ prompt: 'girl, <selector>', negativePrompt: '', enabled: true }]
      } as unknown as GenerationRequest,
      saved,
      { sheets, rng: first }
    )
    expect(out.characterPrompts[0].prompt).toBe('girl, black suit, necktie')
  })

  it('cleans up commas left by a block that resolves to nothing', () => {
    const out = preprocessRequest(
      request('1girl\n$outfits = formal', 'girl, ${outfits: nope => x}, smile', ''),
      none,
      { sheets, rng: first }
    ) as GenerationRequest
    expect(out.characterPrompts[0].prompt).toBe('girl, smile')
  })
})
