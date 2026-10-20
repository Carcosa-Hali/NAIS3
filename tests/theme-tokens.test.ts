import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  ensureContrast,
  mixHex,
  readableOn,
  WHITE_ON_FILL_MIN
} from '../src/renderer/src/lib/color'
import {
  buildWhimsTokens,
  STATUS_CHIP_ALPHA,
  THEME_PRESETS,
  type ThemeMode
} from '../src/renderer/src/lib/theme-presets'

const CASES = THEME_PRESETS.flatMap((preset) =>
  (['light', 'dark'] as ThemeMode[]).flatMap((mode) => {
    const palette = preset[mode]
    if (!palette) return []
    return [{ name: `${preset.id}/${mode}`, palette, tokens: buildWhimsTokens(palette, mode) }]
  })
)

const STATUS = [
  ['danger', 'error'],
  ['success', 'success'],
  ['warning', 'warning'],
  ['info', 'info']
] as const

describe('readableOn — 흰색 우선', () => {
  it('흰색 대비가 기준 이상이면 흰색', () => {
    expect(readableOn('#c2610a')).toBe('#ffffff') // NAIS3 light accent, 4.19:1
    expect(readableOn('#2e7de9')).toBe('#ffffff') // Tokyo Night light, 4.02:1
    expect(readableOn('#0070f3')).toBe('#ffffff')
  })

  it('흰색이 기준에 못 미칠 때만 검정', () => {
    expect(readableOn('#eb9550')).toBe('#000000') // NAIS3 dark accent, 2.35:1
    expect(readableOn('#ffffff')).toBe('#000000')
  })
})

describe('ensureContrast', () => {
  it('끝점(toward 100%)까지 시도한다', () => {
    // Only pure black reaches 21:1 on white; a float loop that skips t = 1 would miss it.
    expect(ensureContrast('#777777', ['#ffffff'], '#000000', 21)).toBe('#000000')
  })
})

describe.each(CASES)('$name 상태색', ({ palette, tokens }) => {
  it('on-accent는 흰색 우선 규칙을 따른다', () => {
    const white = contrastRatio(palette.primary, '#ffffff') >= WHITE_ON_FILL_MIN
    expect(tokens['--on-accent']).toBe(white ? '#ffffff' : '#000000')
  })

  it.each(STATUS)('--%s 채움은 팔레트 원색을 유지한다', (token, key) => {
    expect(tokens[`--${token}`]).toBe(palette[key])
  })

  it('on-danger는 채움(팔레트 원색) 기준으로 고른다', () => {
    expect(tokens['--on-danger']).toBe(readableOn(palette.error))
  })

  it.each([
    ['--accent', '--on-accent'],
    ['--danger', '--on-danger']
  ])('%s 채움 위 글자는 흰색 우선 기준 이상', (fill, on) => {
    expect(contrastRatio(tokens[on], tokens[fill])).toBeGreaterThanOrEqual(WHITE_ON_FILL_MIN)
  })

  it.each(STATUS)('--%s-ink는 모든 면과 15% 칩에서 읽힌다', (token) => {
    const surfaces = [tokens['--paper'], tokens['--surface'], tokens['--surface-2']]
    const target = Math.min(4.5, ...surfaces.map((bg) => contrastRatio(palette.ink, bg)))
    const chips = surfaces.map((bg) => mixHex(bg, tokens[`--${token}`], STATUS_CHIP_ALPHA))
    for (const bg of [...surfaces, ...chips])
      expect(contrastRatio(tokens[`--${token}-ink`], bg)).toBeGreaterThanOrEqual(target)
  })
})

it('기본 NAIS3 라이트 주 버튼 글자는 흰색', () => {
  const nais3 = THEME_PRESETS.find((preset) => preset.id === 'nais3')!
  expect(buildWhimsTokens(nais3.light!, 'light')['--on-accent']).toBe('#ffffff')
})

it('다크 Nord 위험 버튼은 연분홍으로 바래지 않는다', () => {
  const nord = THEME_PRESETS.find((preset) => preset.id === 'nord')!
  const tokens = buildWhimsTokens(nord.dark!, 'dark')
  expect(tokens['--danger']).toBe('#bf616a')
})
