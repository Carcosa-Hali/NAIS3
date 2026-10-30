/**
 * 조각 프롬프트/와일드카드 처리기 — NAIS2 fragment-processor.ts 이식.
 *
 * 지원 문법 (NAIS2와 동일):
 * 1. <이름> / <폴더/이름> — 조각에서 랜덤 줄 선택 (선택된 줄은 재귀 치환)
 * 2. <*이름> — 순차 선택 (배치 생성용, 경로별 카운터)
 * 3. <a|b|c> — 인라인 랜덤
 * 4. (a, b/c, d) — 괄호 와일드카드 (옵션에 쉼표 포함 가능)
 * 5. a/b/c — 쉼표 구분 태그 안의 단순 슬래시 (공백·URL 제외)
 *
 * NAIS2와 다른 점: 재귀 깊이 가드(10) 추가 — 자기 참조 조각의 무한 루프 방지.
 *
 * Fork additions:
 * - `<a @3|b|c>`: an option ending in ` @number` gets that relative weight (default 1).
 * - Weighted rows: a source with `getEntries` (spreadsheet rows) is picked by each row's weight.
 * - `<A ?? B ?? C>`: the first reference that has entries wins. An empty last alternative (`<A ?? >`) means
 *   "nothing" instead of an error.
 */

import { normalizeFragmentPath } from '../../shared/fragment-path'

/** One pickable line of a fragment or one spreadsheet row. */
export interface FragmentEntry {
  line: string
  /** Relative chance (> 0). */
  weight: number
  /** 1-based line number of a fragment, or the row number on a sheet. */
  row?: number
  /** Spreadsheet columns by header field name (see spreadsheet.ts). */
  fields?: ReadonlyMap<string, string>
}

export interface FragmentSource {
  /** path("폴더/이름" 또는 "이름")로 조각 줄 목록 조회. 없으면 null */
  getLines: (path: string) => string[] | null
  /** Weighted entries (rows with their columns). When absent, every line of getLines() has weight 1. */
  getEntries?: (path: string) => FragmentEntry[] | null
  /** Called with every entry that was picked (used by the roll preview to show where text came from). */
  onPick?: (path: string, entry: FragmentEntry) => void
  /**
   * Optional hook applied to the line that was actually picked (not to every candidate line), before that line
   * is expanded further. Used to collect `$Var = ...` definitions from the chosen fragment line / sheet cell.
   */
  select?: (line: string) => string
}

const MAX_DEPTH = 10
const sequentialCounters = new Map<string, number>()

export function resetSequentialCounters(): void {
  sequentialCounters.clear()
}

/** Next index of a `<*path>` walk over `length` entries. `peek` reads without advancing. */
export function nextSequentialIndex(path: string, length: number, peek: boolean): number {
  const index = sequentialCounters.get(path) ?? 0
  if (!peek) sequentialCounters.set(path, index + 1)
  return length > 0 ? index % length : 0
}

/** Index picked at random according to `weights` (all > 0). */
export function pickWeighted(weights: number[], rng: () => number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (!(total > 0)) return Math.floor(rng() * weights.length)
  let target = rng() * total
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i]
    if (target < 0) return i
  }
  return weights.length - 1
}

/** `text @3` -> { text, weight: 3 }. Without a suffix the weight is 1. */
export function splitWeight(option: string): { text: string; weight: number } {
  const match = /^([\s\S]*?)\s+@\s*(\d+(?:\.\d+)?|\.\d+)\s*$/.exec(option)
  if (!match) return { text: option.trim(), weight: 1 }
  return { text: match[1].trim(), weight: Number(match[2]) }
}

/** Entries of `path` with their weights; plain line sources count each line once. */
export function lookupEntries(source: FragmentSource, path: string): FragmentEntry[] | null {
  if (source.getEntries) return source.getEntries(path)
  const lines = source.getLines(path)
  return lines ? lines.map((line, index) => ({ line, weight: 1, row: index + 1 })) : null
}

/**
 * Resolves `A ?? B ?? C` (already split) to the first path with entries. Lookups that fail before the last
 * alternative (unknown sheet or key in strict mode) just move on to the next one. Returns null for an empty last
 * alternative ("nothing").
 */
export function lookupAlternatives(
  source: FragmentSource,
  alternatives: string[],
  usable: (entries: FragmentEntry[]) => boolean = (entries) => entries.length > 0
): { path: string; entries: FragmentEntry[] | null } | null {
  for (let i = 0; i < alternatives.length; i++) {
    const last = i === alternatives.length - 1
    const path = normalizeFragmentPath(alternatives[i])
    if (!path) {
      if (last) return null
      continue
    }
    if (last) return { path, entries: lookupEntries(source, path) }
    try {
      const entries = lookupEntries(source, path)
      if (entries && usable(entries)) return { path, entries }
    } catch {
      // try the next alternative
    }
  }
  return null
}

function processFileWildcards(
  prompt: string,
  source: FragmentSource,
  rng: () => number,
  depth: number,
  peek: boolean
): string {
  if (depth > MAX_DEPTH) return prompt
  const filePattern = /<([^<>]+)>/g

  return prompt.replace(filePattern, (match, content: string) => {
    const trimmed = content.trim()

    // 인라인 와일드카드: <a|b|c>  (an option may end in " @weight")
    if (trimmed.includes('|')) {
      const options = trimmed
        .split('|')
        .map(splitWeight)
        .filter((o) => o.text.length > 0 && o.weight > 0)
      if (options.length === 0) return match
      return options[
        pickWeighted(
          options.map((o) => o.weight),
          rng
        )
      ].text
    }

    // 순차 모드: <*이름>
    const isSequential = trimmed.startsWith('*')
    const body = isSequential ? trimmed.slice(1) : trimmed
    const alternatives = body.split('??')
    if (!normalizeFragmentPath(alternatives[0]) && alternatives.length === 1) return match

    const found = lookupAlternatives(source, alternatives, (entries) =>
      entries.some((entry) => entry.line.trim())
    )
    if (found === null) return '' // `<A ?? >` with nothing found
    const { path } = found
    const entries = found.entries?.filter((entry) => entry.line.trim()) ?? null
    if (!entries || entries.length === 0) {
      // 조각 없으면 원본 유지 (NAIS2 동일). A strict source throws here instead (rows without column-B text).
      if (found.entries && found.entries.length > 0) source.getLines(path)
      return alternatives.length > 1 ? '' : match
    }

    const entry = isSequential
      ? entries[nextSequentialIndex(path, entries.length, peek)]
      : entries[
          pickWeighted(
            entries.map((e) => e.weight),
            rng
          )
        ]
    source.onPick?.(path, entry)

    let line = entry.line
    if (source.select) line = source.select(line)

    // 선택된 줄 안의 중첩 조각 재귀 치환
    return processFileWildcards(line, source, rng, depth + 1, peek)
  })
}

/** (a, b/c, d) — 괄호 안에 슬래시가 있으면 옵션 세트 중 하나 선택 */
function processParenthesisWildcards(prompt: string, rng: () => number): string {
  const parenPattern = /\(([^()]+\/[^()]+)\)/g
  return prompt.replace(parenPattern, (_match, content: string) => {
    const options = content
      .split('/')
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
    if (options.length <= 1) return content
    return options[Math.floor(rng() * options.length)]
  })
}

/** 쉼표 구분 태그 안의 a/b/c (공백 없음, URL 아님). 줄 단위로 처리해 개행을 보존한다 */
function processSimpleWildcards(prompt: string, rng: () => number): string {
  // ⚠️ 전체를 split(',')→join(', ')하면 trim이 개행을 삼켜 프롬프트가 한 줄로 붕괴한다
  //    (주석(#) 범위가 전체로 번져 빈 프롬프트가 전송되던 버그의 원인)
  return prompt
    .split('\n')
    .map((line) =>
      line
        .split(',')
        .map((tag) => {
          const trimmed = tag.trim()
          if (
            trimmed.includes('/') &&
            !trimmed.startsWith('http') &&
            !trimmed.includes('://') &&
            !trimmed.includes(' ')
          ) {
            const options = trimmed
              .split('/')
              .map((o) => o.trim())
              .filter((o) => o.length > 0)
            if (options.length > 1) return options[Math.floor(rng() * options.length)]
          }
          return trimmed
        })
        .join(', ')
    )
    .join('\n')
}

export function processWildcards(
  prompt: string,
  source: FragmentSource,
  rng: () => number = Math.random,
  /** true면 순차 카운터를 소모하지 않는 미리보기 치환 (토큰 카운트용) */
  peek = false
): string {
  if (!prompt) return prompt
  let result = processFileWildcards(prompt, source, rng, 0, peek)
  result = processParenthesisWildcards(result, rng)
  result = processSimpleWildcards(result, rng)
  return result
}
