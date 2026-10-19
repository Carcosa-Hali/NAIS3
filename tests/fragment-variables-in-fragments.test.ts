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
      { key: 'lingerie', value: 'red lingerie, garter belt' },
      { key: 'casual', value: 'striped shirt, overalls' },
      { key: 'swimwear', value: '${style: sporty => sports bikini | * => monokini}' }
    ]
  }
])

/** A saved fragment that holds a variable block, like a hand-written "selector" fragment. */
const source: FragmentSource = {
  getLines: (path) =>
    ({
      outfit_selector_fragment: [
        '${outfits: lingerie => <outfit_tags_sheet/lingerie> | casual => <outfit_tags_sheet/casual>}'
      ],
      swim_fragment: ['<outfit_tags_sheet/swimwear>'],
      wrapper: ['<outfit_selector_fragment>, smile']
    })[path] ?? null
}

function request(character: string, main = 'indoors\n$outfits = lingerie'): GenerationRequest {
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
    expect(out.characterPrompts[0].prompt).toBe('girl, red lingerie, garter belt')
  })

  it('follows the same roll as blocks written directly in the prompts', () => {
    const out = preprocessRequest(
      request(
        'girl, <outfit_selector_fragment>, ${outfits: lingerie => choker}',
        '$outfits = random(lingerie, casual)'
      ),
      source,
      { sheets, rng: () => 0.9 }
    )
    expect(out.characterPrompts[0].prompt).toBe('girl, striped shirt, overalls')
  })

  it('resolves blocks in fragments nested inside fragments', () => {
    const out = preprocessRequest(request('<wrapper>'), source, { sheets, rng: first })
    expect(out.characterPrompts[0].prompt).toBe('red lingerie, garter belt, smile')
  })

  it('resolves a ${...} block held in a spreadsheet cell', () => {
    const out = preprocessRequest(
      request('<swim_fragment>', 'indoors\n$outfits = lingerie\n$style = sporty'),
      source,
      { sheets, rng: first }
    )
    expect(out.characterPrompts[0].prompt).toBe('sports bikini')
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
      ['$outfits = lingerie\nindoors', '<outfit_selector_fragment>', '<wrapper>'],
      source,
      sheets
    )
    expect(main).toBe('indoors')
    expect(character).toBe('red lingerie, garter belt')
    expect(orphan).toBe('red lingerie, garter belt, smile')
  })
})
