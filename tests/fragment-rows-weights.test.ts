import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import {
  pickWeighted,
  processWildcards,
  resetSequentialCounters,
  splitWeight,
  type FragmentSource
} from '../src/main/fragments/processor'
import { preprocessRequest, rollPreview } from '../src/main/fragments/request'
import { createSpreadsheetSource, fieldName } from '../src/main/fragments/spreadsheet'

const first = (): number => 0
const last = (): number => 0.999

/** Cycles through the given random numbers. */
function sequence(...numbers: number[]): () => number {
  let i = 0
  return () => numbers[i++ % numbers.length]
}

const sheets = createSpreadsheetSource([
  {
    name: 'Places',
    header: ['key', 'tags', 'lighting', 'Clothing Category', 'weight', 'Caption'],
    rows: [
      { key: 'key', value: 'tags', cells: ['key', 'tags'], row: 1 },
      {
        key: 'outdoor',
        value: 'park, trees',
        cells: ['outdoor', 'park, trees', 'sunlight', 'casual', '3', ''],
        row: 2
      },
      {
        key: 'outdoor',
        value: 'beach, sand',
        cells: ['outdoor', 'beach, sand', 'bright', 'swim', '1', 'sign reading "OPEN"'],
        row: 3
      },
      {
        key: 'outdoor',
        value: 'quarry, rocks',
        cells: ['outdoor', 'quarry, rocks', 'overcast', 'work', '0'],
        row: 4
      },
      {
        key: 'indoor',
        value: '',
        cells: ['indoor', '', 'lamp light', 'home', ''],
        row: 5
      }
    ]
  },
  {
    name: 'Index',
    header: ['key', 'target'],
    rows: [
      { key: 'any', value: '<Places/outdoor>', cells: ['any', '<Places/outdoor>'], row: 2 },
      { key: 'any', value: '<Places/indoor>', cells: ['any', '<Places/indoor>'], row: 3 }
    ]
  },
  {
    name: 'Clothes',
    rows: [
      { key: 'casual_regular', value: 'hoodie, jeans' },
      { key: 'casual_formal', value: 'blazer, slacks' },
      { key: 'swim_regular', value: 'swimsuit' },
      { key: 'fallback_regular', value: 't-shirt' },
      { key: 'fallback_formal', value: 'suit' },
      { key: 'with_definition', value: 'scarf\n$late = 1' }
    ]
  }
])

const fragments: Record<string, string[]> = {
  weather: ['sunny', 'rainy', 'snowy']
}
const source: FragmentSource = { getLines: (path) => fragments[path] ?? null }

function request(main: string, character = '', characterNegative = ''): GenerationRequest {
  return {
    prompt: main,
    negativePrompt: '',
    characterPrompts: [{ prompt: character, negativePrompt: characterNegative, enabled: true }]
  } as unknown as GenerationRequest
}

const run = (main: string, character = '', rng: () => number = first): GenerationRequest =>
  preprocessRequest(request(main, character), source, { sheets, rng })

describe('weights', () => {
  it('splits a trailing " @n" weight off an option', () => {
    expect(splitWeight('calm @3')).toEqual({ text: 'calm', weight: 3 })
    expect(splitWeight('calm')).toEqual({ text: 'calm', weight: 1 })
    expect(splitWeight('@_@')).toEqual({ text: '@_@', weight: 1 })
    expect(splitWeight('rating:general @0.5')).toEqual({ text: 'rating:general', weight: 0.5 })
  })

  it('picks by weight', () => {
    expect(pickWeighted([1, 3], () => 0.24)).toBe(0)
    expect(pickWeighted([1, 3], () => 0.26)).toBe(1)
  })

  it('weights inline <a|b> options and random() options; weight 0 is never picked', () => {
    expect(processWildcards('<a @0|b>', source, first)).toBe('b')
    expect(processWildcards('<a @1|b @3>', source, () => 0.3)).toBe('b')
    expect(run('$m = random(calm @0, tense)\n${m}', '', first).prompt).toBe('tense')
    expect(run('$m = random(calm @1, tense @3)\n${m}', '', () => 0.2).prompt).toBe('calm')
    expect(run('$m = random(calm @1, tense @3)\n${m}', '', () => 0.3).prompt).toBe('tense')
  })

  it('uses a sheet\'s "weight" column and skips rows weighted 0', () => {
    // weights 3 and 1 (the quarry row has weight 0)
    expect(run('<Places/outdoor>', '', () => 0.7).prompt).toBe('park, trees')
    expect(run('<Places/outdoor>', '', () => 0.8).prompt).toBe('beach, sand')
    expect(run('<Places/outdoor>', '', last).prompt).toBe('beach, sand')
  })

  it('multiplies a weighted reference inside random() by each row weight', () => {
    const out = run('$p = random(<Places/outdoor> @2, elsewhere @8)\n${p}', '', () => 0.5)
    // pool: park 6, beach 2, elsewhere 8 -> 0.5 * 16 = 8 falls in "elsewhere"
    expect(out.prompt).toBe('elsewhere')
  })
})

describe('variables inside references', () => {
  it('looks a reference up after the roll, using the rolled values', () => {
    const out = run('$cat = casual\n$tier = random(formal)', '<Clothes/${cat}_${tier}>')
    expect(out.characterPrompts[0].prompt).toBe('blazer, slacks')
  })

  it('works with a variable defined after the reference, or in another field', () => {
    const out = preprocessRequest(
      request('outdoors', '<Clothes/${cat}_regular>', '$cat = swim'),
      source,
      { sheets, rng: first }
    )
    expect(out.characterPrompts[0].prompt).toBe('swimsuit')
  })

  it('falls back with ?? when the first key does not exist', () => {
    const out = run('$cat = unknown', '<Clothes/${cat}_regular ?? Clothes/fallback_regular>')
    expect(out.characterPrompts[0].prompt).toBe('t-shirt')
  })

  it('produces nothing for an empty last alternative, and still fails without one', () => {
    expect(
      run('$cat = unknown', 'girl, <Clothes/${cat}_regular ?? >, smile').characterPrompts[0].prompt
    ).toBe('girl, smile')
    expect(() => run('$cat = unknown', '<Clothes/${cat}_regular>')).toThrow('no usable rows')
  })

  it('allows a ${...} block with branches inside a reference', () => {
    const out = run('$mood = dressy', '<Clothes/casual_${mood: dressy => formal | * => regular}>')
    expect(out.characterPrompts[0].prompt).toBe('blazer, slacks')
  })

  it('rejects a definition inside a cell that is only reached through such a reference', () => {
    expect(() => run('$k = with_definition', '<Clothes/${k}>')).toThrow(
      'after variables are rolled'
    )
  })

  it('lets a definition use variables defined before it', () => {
    const out = run('$cat = casual\n$clothes = random(<Clothes/${cat}_formal>)\n${clothes}')
    expect(out.prompt).toBe('blazer, slacks')
  })

  it('explains the order when a definition uses a variable defined after it', () => {
    expect(() => run('$clothes = random(<Clothes/${cat}_formal>)\n$cat = casual')).toThrow(
      'defined before it'
    )
  })
})

describe('row()', () => {
  it('turns header names into field names', () => {
    expect(fieldName('Clothing Category')).toBe('clothing_category')
    expect(fieldName(' total (auto) ')).toBe('total_auto')
  })

  it('exposes column B and every other column of the picked row', () => {
    const out = run(
      '$place = row(<Places/outdoor>)\n${place}, ${place.lighting}',
      '<Clothes/${place.clothing_category}_regular>',
      () => 0.9
    )
    expect(out.prompt).toBe('beach, sand, bright')
    expect(out.characterPrompts[0].prompt).toBe('swimsuit')
  })

  it('reads rows whose column B is empty', () => {
    const out = run('$place = row(<Places/indoor>)\n${place.lighting}')
    expect(out.prompt).toBe('lamp light')
  })

  it('branches on a column and drops empty columns cleanly', () => {
    const out = run(
      '$place = row(<Places/outdoor>)\nscene, ${place.caption}, ${place.clothing_category: swim => water | * => land}',
      '',
      first
    )
    expect(out.prompt).toBe('scene, land')
  })

  it('follows an index cell that holds only another reference', () => {
    const out = run('$place = row(<Index/any>)\n${place.lighting}', '', sequence(0.9, 0.1))
    // index picks row 3 (<Places/indoor>)
    expect(out.prompt).toBe('lamp light')
  })

  it('walks rows in order with row(<*...>)', () => {
    resetSequentialCounters()
    const walk = (): string => run('$place = row(<*Places/outdoor>)\n${place}').prompt
    expect([walk(), walk(), walk()]).toEqual(['park, trees', 'beach, sand', 'park, trees'])
    resetSequentialCounters()
  })

  it('names the available columns when a column does not exist', () => {
    expect(() => run('$place = row(<Places/outdoor>)\n${place.colour}')).toThrow(
      'Columns: key, tags, lighting, clothing_category, weight, caption'
    )
    expect(() => run('$plain = x\n${plain.colour}')).toThrow('not a row(...) variable')
  })

  it('selects one row by number with #', () => {
    expect(run('$place = row(<Places/outdoor#3>)\n${place.lighting}').prompt).toBe('bright')
    expect(() => run('$place = row(<Places/outdoor#9>)')).toThrow('has no row 9')
    expect(run('<weather#2>').prompt).toBe('rainy')
  })

  it('rejects definitions found in a column value', () => {
    const late = createSpreadsheetSource([
      {
        name: 'S',
        header: ['key', 'value', 'extra'],
        rows: [{ key: 'k', value: 'v', cells: ['k', 'v', 'tag\n$late = 1'] }]
      }
    ])
    expect(() =>
      preprocessRequest(request('$r = row(<S/k>)\n${r.extra}'), source, {
        sheets: late,
        rng: first
      })
    ).toThrow('after variables are rolled')
  })
})

describe('fixed values and rolled-variable records', () => {
  it('lets := override every ordinary definition of the same name', () => {
    const out = run('$m = random(calm, tense)\n$m := quiet\n${m}', '', last)
    expect(out.prompt).toBe('quiet')
    expect(() => run('$m := a\n$m := b')).toThrow('fixed (:=) more than once')
  })

  it('records every rolled variable with a lock that reproduces it', () => {
    const out = run(
      '$m = random(calm, tense)\n$place = row(<Places/outdoor>)\n$w = random(<weather>)\n${m} ${place} ${w}',
      '',
      () => 0.9
    )
    expect(out.rolledVariables).toEqual([
      { name: 'm', value: 'tense', lock: 'tense' },
      { name: 'place', value: 'beach, sand', lock: 'row(<places/outdoor#3>)' },
      { name: 'w', value: 'snowy', lock: 'random(<weather#3>)' }
    ])
    const locked = out.rolledVariables!.map((v) => `$${v.name} := ${v.lock}`).join('\n')
    const again = run(
      `${locked}\n$m = random(calm, tense)\n\${m} \${place.lighting} \${w}`,
      '',
      first
    )
    expect(again.prompt).toBe('tense bright snowy')
  })

  it('leaves the request without a record when nothing was rolled', () => {
    expect(run('plain').rolledVariables).toBe(undefined)
  })
})

describe('rollPreview', () => {
  const input = (prompt: string, character = ''): Parameters<typeof rollPreview>[0] => ({
    prompt,
    negativePrompt: 'lowres',
    characters: [{ prompt: character, negativePrompt: '' }]
  })

  it('returns the final texts, the variables and every pick', () => {
    const result = rollPreview(
      input(
        '$place = row(<Places/outdoor>)\n${place}, <weather>',
        '<Clothes/${place.clothing_category}_regular>'
      ),
      source,
      sheets,
      first
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.prompt).toBe('park, trees, sunny')
    expect(result.negativePrompt).toBe('lowres')
    expect(result.characters).toEqual([{ prompt: 'hoodie, jeans', negativePrompt: '' }])
    expect(result.variables.map((v) => v.name)).toEqual(['place'])
    expect(result.picks).toEqual([
      { path: 'weather', row: 1, text: 'sunny' },
      { path: 'places/outdoor', row: 2, text: 'park, trees' },
      { path: 'clothes/casual_regular', row: 1, text: 'hoodie, jeans' }
    ])
  })

  it('reports errors instead of throwing', () => {
    const result = rollPreview(input('<Places/nowhere>'), source, sheets, first)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('no usable rows')
  })

  it('does not advance <*...> walks', () => {
    resetSequentialCounters()
    const peek = (): string => {
      const result = rollPreview(
        input('$p = row(<*Places/outdoor>)\n${p}, <*weather>'),
        source,
        sheets
      )
      return result.ok ? result.prompt : result.error
    }
    expect(peek()).toBe('park, trees, sunny')
    expect(peek()).toBe('park, trees, sunny')
  })
})
