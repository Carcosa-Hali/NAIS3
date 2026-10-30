import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import type { FragmentSource } from '../src/main/fragments/processor'
import { preprocessRequest, previewTexts } from '../src/main/fragments/request'
import { createSpreadsheetSource } from '../src/main/fragments/spreadsheet'

const first = (): number => 0

const sheets = createSpreadsheetSource([
  {
    name: 'outfit_tags_sheet',
    rows: [
      { key: 'formal', value: 'black suit, necktie' },
      { key: 'casual', value: 'striped shirt, overalls' },
      { key: 'sportswear', value: '${style: sporty => track jacket | * => sweater}' }
    ]
  }
])

/** A saved fragment that holds a variable block, like a hand-written "selector" fragment. */
const source: FragmentSource = {
  getLines: (path) =>
    ({
      outfit_selector_fragment: [
        '${outfits: formal => <outfit_tags_sheet/formal> | casual => <outfit_tags_sheet/casual>}'
      ],
      sports_fragment: ['<outfit_tags_sheet/sportswear>'],
      wrapper: ['<outfit_selector_fragment>, smile']
    })[path] ?? null
}

function request(character: string, main = 'indoors\n$outfits = formal'): GenerationRequest {
  return {
    prompt: main,
    negativePrompt: '',
    characterPrompts: [{ prompt: character, negativePrompt: '', enabled: true }]
  } as unknown as GenerationRequest
}

describe('variable blocks that arrive through fragments', () => {
  it('resolves a ${...} block held in a saved fragment', () => {
    const out = preprocessRequest(request('girl, <outfit_selector_fragment>'), source, {
      sheets,
      rng: first
    })
    expect(out.prompt).toBe('indoors')
    expect(out.characterPrompts[0].prompt).toBe('girl, black suit, necktie')
  })

  it('follows the same roll as blocks written directly in the prompts', () => {
    const out = preprocessRequest(
      request(
        'girl, <outfit_selector_fragment>, ${outfits: formal => choker}',
        '$outfits = random(formal, casual)'
      ),
      source,
      { sheets, rng: () => 0.9 }
    )
    expect(out.characterPrompts[0].prompt).toBe('girl, striped shirt, overalls')
  })

  it('resolves blocks in fragments nested inside fragments', () => {
    const out = preprocessRequest(request('<wrapper>'), source, { sheets, rng: first })
    expect(out.characterPrompts[0].prompt).toBe('black suit, necktie, smile')
  })

  it('resolves a ${...} block held in a spreadsheet cell', () => {
    const out = preprocessRequest(
      request('<sports_fragment>', 'indoors\n$outfits = formal\n$style = sporty'),
      source,
      { sheets, rng: first }
    )
    expect(out.characterPrompts[0].prompt).toBe('track jacket')
  })

  it('still fails clearly when a fragment uses a variable that nothing defines', () => {
    expect(() =>
      preprocessRequest(request('<outfit_selector_fragment>', 'indoors'), source, {
        sheets,
        rng: first
      })
    ).toThrow('Variable "outfits" is not defined')
  })

  it('counts tokens on the resolved text without throwing', () => {
    const [main, character, orphan] = previewTexts(
      ['$outfits = formal\nindoors', '<outfit_selector_fragment>', '<wrapper>'],
      source,
      sheets
    )
    expect(main).toBe('indoors')
    expect(character).toBe('black suit, necktie')
    expect(orphan).toBe('black suit, necktie, smile')
  })
})
