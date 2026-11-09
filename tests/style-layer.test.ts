import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import type { FragmentSource } from '../src/main/fragments/processor'
import { joinBeforeText, preprocessRequest, rollPreview } from '../src/main/fragments/request'

const fragments: Record<string, string[]> = {
  'artists/set': ['artist:one, artist:two']
}
const source: FragmentSource = { getLines: (path) => fragments[path] ?? null }
const first = (): number => 0

function request(patch: Partial<GenerationRequest>): GenerationRequest {
  return {
    prompt: '',
    negativePrompt: '',
    model: 'nai-diffusion-4-5-full',
    width: 1024,
    height: 1024,
    steps: 28,
    cfgScale: 5,
    cfgRescale: 0,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    seed: 1,
    variety: false,
    qualityToggle: false,
    ucPreset: 0,
    characterPrompts: [],
    useCoords: false,
    ...patch
  }
}

describe('joinBeforeText', () => {
  it('appends when there is no Text: block', () => {
    expect(joinBeforeText('a, b', 'style')).toBe('a, b, style')
    expect(joinBeforeText('', 'style')).toBe('style')
    expect(joinBeforeText('a, Textbook', 'style')).toBe('a, Textbook, style')
  })
  it('goes before the first Text: block, which stays last', () => {
    expect(joinBeforeText('a, b, Text: HELLO, WORLD', 'style')).toBe(
      'a, b, style, Text: HELLO, WORLD'
    )
    expect(joinBeforeText('a,\nText: one\n\ntwo', 's1, s2,')).toBe('a, s1, s2, Text: one\n\ntwo')
    expect(joinBeforeText('Text: only', 'style')).toBe('style, Text: only')
  })
  it('ignores an empty addition', () => {
    expect(joinBeforeText('a, Text: x', '  ')).toBe('a, Text: x')
  })
})

describe('style layer', () => {
  const style = { prompt: '<artists/set>, ${loc} light', negativePrompt: 'lowres' }
  const main = '$loc = random(park, beach)\n1girl, ${loc}, Text: SIGN'

  it('is expanded with the request variables and merged before Text:', () => {
    const out = preprocessRequest(request({ prompt: main, negativePrompt: 'bad', style }), source, {
      rng: first
    })
    expect(out.prompt).toBe('1girl, park, artist:one, artist:two, park light, Text: SIGN')
    expect(out.negativePrompt).toBe('bad, lowres')
    expect(out.style).toBeUndefined()
  })

  it('can fix a variable of the mode with :=', () => {
    const out = preprocessRequest(
      request({ prompt: main, style: { prompt: '$loc := beach', negativePrompt: '' } }),
      source,
      { rng: first }
    )
    expect(out.prompt).toBe('1girl, beach, Text: SIGN')
  })

  it('shows up in the roll preview like at generation time', () => {
    const result = rollPreview(
      {
        prompt: main,
        negativePrompt: 'bad',
        characters: [{ prompt: 'girl', negativePrompt: '' }],
        style
      },
      source,
      null,
      first
    )
    expect(result.ok).toBe(true)
    expect(result.prompt).toBe('1girl, park, artist:one, artist:two, park light, Text: SIGN')
    expect(result.negativePrompt).toBe('bad, lowres')
    expect(result.characters).toEqual([{ prompt: 'girl', negativePrompt: '' }])
  })
})
