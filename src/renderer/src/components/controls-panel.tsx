import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Dices,
  ListChecks,
  Loader2,
  Pin,
  RotateCcw,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ControlChoice,
  ControlRow,
  PinPick,
  RolledVariable,
  SheetColumnValues
} from '@shared/types'
import { usePinsStore } from '../stores/pins-store'
import { useModesStore } from '../stores/modes-store'
import { cn } from '../lib/utils'
import { useT } from '../lib/i18n'

/**
 * The controls panel: docked in the prompt area (not a popover), collapsible, built from the workbook's
 * `controls` sheet. Each control lists the entries its variable can take; ticking entries (each with a relative
 * weight) pins the variable to roll among just those. Everything is stored as pins (`$name := …`), so the roll
 * preview, image metadata and "Pin all" keep working as before. Variables without a controls row are under
 * Advanced, with the typed-expression and keep-current-value pins of the old pin panel.
 */

const COLLAPSED_KEY = 'controls_panel_collapsed'
const GROUPS_KEY = 'controls_groups_collapsed'
const MAX_SHOWN = 200

const shorten = (text: string, limit = 60): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function loadGroups(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

/** Fetched once per sheet / choices text until the panel rolls again (the workbook may change in between). */
const columnCache = new Map<string, Promise<SheetColumnValues[]>>()
const choiceCache = new Map<string, Promise<ControlChoice[]>>()

function columnValues(sheet: string): Promise<SheetColumnValues[]> {
  const key = sheet.toLowerCase()
  let pending = columnCache.get(key)
  if (!pending) {
    pending = window.nais
      .invoke('workbook:columnValues', { sheet })
      .then((columns) => (Array.isArray(columns) ? columns : []))
      .catch(() => [])
    columnCache.set(key, pending)
  }
  return pending
}

function controlChoices(choices: string, show: string[]): Promise<ControlChoice[]> {
  const key = `${choices}|${show.join(',')}`.toLowerCase()
  let pending = choiceCache.get(key)
  if (!pending) {
    pending = window.nais
      .invoke('workbook:controlChoices', { choices, show })
      .then((rows) => (Array.isArray(rows) ? rows : []))
      .catch(() => [])
    choiceCache.set(key, pending)
  }
  return pending
}

/** Sheets named by a choices text (`<locations/*> <media/*>` -> locations, media). */
function choiceSheets(choices: string): string[] {
  const out: string[] = []
  for (const match of choices.matchAll(/<([^<>/]+)\//g)) {
    const sheet = match[1].trim()
    if (sheet && !out.some((s) => sameName(s, sheet))) out.push(sheet)
  }
  return out
}

type PickFn = 'random' | 'row' | 'deal'
const pickFn = (variable: RolledVariable): PickFn | null =>
  variable.kind === 'row' || variable.kind === 'deal'
    ? variable.kind
    : variable.kind === 'random' || variable.kind === 'chance'
      ? 'random'
      : null

/** `fill`: take the free height of the prompt area (the mode template is closed). */
export function ControlsPanel({ fill = false }: { fill?: boolean }): React.JSX.Element {
  const t = useT()
  const pins = usePinsStore((s) => s.pins)
  const lastRoll = usePinsStore((s) => s.lastRoll)
  const rolling = usePinsStore((s) => s.rolling)
  const roll = usePinsStore((s) => s.roll)
  const clear = usePinsStore((s) => s.clear)
  const unpin = usePinsStore((s) => s.unpin)
  const activeMode = useModesStore((s) => s.activeId)
  const [collapsed, setCollapsed] = useState(() => loadFlag(COLLAPSED_KEY))
  const [groupsCollapsed, setGroupsCollapsed] = useState(loadGroups)
  const [controls, setControls] = useState<ControlRow[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = (): void => {
    columnCache.clear()
    choiceCache.clear()
    void roll()
    void window.nais
      .invoke('workbook:controls', undefined)
      .then((rows) => setControls(Array.isArray(rows) ? rows : []))
      .catch(() => setControls([]))
  }

  // A fresh roll and controls sheet when the panel opens and whenever another mode is applied.
  useEffect(() => {
    if (!collapsed) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, activeMode])

  // Pins changed (a tick, a weight): roll again shortly after, so the values shown follow.
  const pinsKey = pins.map((p) => `${p.name}=${p.lock}`).join('\n')
  const firstPins = useRef(true)
  useEffect(() => {
    if (firstPins.current) {
      firstPins.current = false
      return
    }
    if (collapsed) return
    const timer = setTimeout(() => void roll(), 400)
    return () => clearTimeout(timer)
  }, [pinsKey, collapsed, roll])

  const toggleCollapsed = (): void => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      // storage unavailable: the state only lasts until the panel unmounts
    }
  }
  const toggleGroup = (group: string): void => {
    const next = { ...groupsCollapsed, [group]: !groupsCollapsed[group] }
    setGroupsCollapsed(next)
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(next))
    } catch {
      // as above
    }
  }

  const variables = useMemo(() => lastRoll?.variables ?? [], [lastRoll])
  const stray = pins.filter((p) => !variables.some((v) => sameName(v.name, p.name)))

  // Variables with a visible controls row first, grouped in sheet order; the rest is "Advanced".
  const { groups, advanced } = useMemo(() => {
    const byName = new Map(variables.map((v) => [v.name.toLowerCase(), v]))
    const used = new Set<string>()
    const groups: { group: string; items: { variable: RolledVariable; control: ControlRow }[] }[] =
      []
    for (const control of controls) {
      const variable = byName.get(control.variable.toLowerCase())
      if (!variable || control.hidden || used.has(variable.name.toLowerCase())) continue
      used.add(variable.name.toLowerCase())
      let group = groups.find((g) => g.group === control.group)
      if (!group) {
        group = { group: control.group, items: [] }
        groups.push(group)
      }
      group.items.push({ variable, control })
    }
    const hiddenControls = new Map(
      controls.filter((c) => c.hidden).map((c) => [c.variable.toLowerCase(), c])
    )
    const advanced = variables
      .filter((v) => !used.has(v.name.toLowerCase()))
      .map((variable) => ({ variable, control: hiddenControls.get(variable.name.toLowerCase()) }))
    return { groups, advanced }
  }, [variables, controls])

  // Opened by the sheet's `open` column the first time the controls arrive.
  const openedByDefault = useRef(false)
  useEffect(() => {
    if (openedByDefault.current || controls.length === 0) return
    openedByDefault.current = true
    const first = controls.find((c) => c.open && !c.hidden)
    if (first) setExpanded(first.variable)
  }, [controls])

  const ADVANCED = '\u0000advanced'
  const advancedOpen = groups.length === 0 ? true : groupsCollapsed[ADVANCED] === false

  const item = (variable: RolledVariable, control?: ControlRow): React.JSX.Element => (
    <ControlItem
      key={variable.name}
      variable={variable}
      control={control}
      expanded={expanded !== null && sameName(expanded, variable.name)}
      onToggle={() =>
        setExpanded(expanded !== null && sameName(expanded, variable.name) ? null : variable.name)
      }
    />
  )

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col rounded-lg border border-line bg-paper/40',
        collapsed ? 'shrink-0' : fill ? 'min-h-24 flex-1' : 'max-h-[45%] shrink-0'
      )}
      aria-label={t('ui.controlsPanel')}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-1">
        <button
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[12px] font-medium text-muted transition-colors hover:text-ink"
          aria-expanded={!collapsed}
          title={
            collapsed
              ? t('ui.expandValue', t('ui.controlsPanel'))
              : t('ui.collapseValue', t('ui.controlsPanel'))
          }
          onClick={toggleCollapsed}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <ListChecks size={13} className="shrink-0" />
          <span>{t('ui.controlsPanel')}</span>
          {pins.length > 0 && (
            <span className="ml-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-paper">
              {pins.length}
            </span>
          )}
        </button>
        {!collapsed && pins.length > 0 && (
          <button
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-surface-2 hover:text-ink"
            title={t('ui.controlsResetAllHint')}
            onClick={clear}
          >
            <RotateCcw size={11} /> {t('ui.controlsResetAll')}
          </button>
        )}
        {!collapsed && (
          <button
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-surface-2 hover:text-ink"
            title={t('ui.controlsRollHint')}
            disabled={rolling}
            onClick={refresh}
          >
            {rolling ? <Loader2 size={11} className="animate-spin" /> : <Dices size={11} />}
            {t('ui.rollAgain')}
          </button>
        )}
      </div>

      {collapsed ? (
        pins.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2 pb-1.5">
            {pins.map((pin) => (
              <span
                key={pin.name}
                title={`$${pin.name} := ${pin.lock}`}
                className="flex max-w-full items-center gap-1 rounded-full border border-accent/30 bg-accent/10 py-0.5 pl-2 pr-1 font-mono text-[10.5px] text-accent-ink"
              >
                <span className="truncate">
                  {controls.find((c) => sameName(c.variable, pin.name))?.label ?? `$${pin.name}`}:{' '}
                  {shorten(pin.label, 28)}
                </span>
                <button
                  className="grid size-3.5 place-items-center rounded-full hover:bg-accent/20"
                  title={t('ui.controlsRandomAsDefined')}
                  aria-label={t('ui.controlsRandomAsDefined')}
                  onClick={() => unpin(pin.name)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line/60">
          {lastRoll && !lastRoll.ok && (
            <div className="m-2 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-[11.5px] text-danger-ink">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span className="select-text whitespace-pre-wrap break-words">{lastRoll.error}</span>
            </div>
          )}
          {lastRoll === null && (
            <div className="flex justify-center py-6 text-muted">
              <Loader2 size={16} className="animate-spin" />
            </div>
          )}
          {lastRoll && lastRoll.ok && variables.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-faint">{t('ui.noVariables')}</p>
          )}
          {groups.map(({ group, items }) => {
            const closed = groupsCollapsed[group] === true
            return (
              <div key={group || '\u0000'}>
                {group && (
                  <button
                    className="flex w-full items-center gap-1 border-b border-line/60 bg-surface-2/40 px-2 py-0.5 text-left text-[10.5px] font-medium uppercase tracking-wide text-faint hover:text-ink"
                    aria-expanded={!closed}
                    onClick={() => toggleGroup(group)}
                  >
                    {closed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                    {group}
                  </button>
                )}
                {!closed && <ul>{items.map(({ variable, control }) => item(variable, control))}</ul>}
              </div>
            )
          })}
          {groups.length > 0 && advanced.length > 0 && (
            <button
              className="flex w-full items-center gap-1 border-b border-line/60 bg-surface-2/40 px-2 py-0.5 text-left text-[10.5px] font-medium uppercase tracking-wide text-faint hover:text-ink"
              aria-expanded={advancedOpen}
              onClick={() => {
                // Advanced starts closed: store it as open (false) / closed (true) explicitly
                const next = { ...groupsCollapsed, [ADVANCED]: advancedOpen }
                setGroupsCollapsed(next)
                try {
                  localStorage.setItem(GROUPS_KEY, JSON.stringify(next))
                } catch {
                  // storage unavailable
                }
              }}
            >
              {advancedOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {t('ui.controlsAdvanced', advanced.length)}
            </button>
          )}
          {advancedOpen && (
            <ul>{advanced.map(({ variable, control }) => item(variable, control))}</ul>
          )}
          {stray.length > 0 && (
            <div className="border-t border-line px-3 py-1.5">
              <p className="pb-1 text-[11px] text-faint">{t('ui.pinsNotInPrompt')}</p>
              {stray.map((pin) => (
                <div key={pin.name} className="flex items-center gap-2 py-0.5 font-mono text-[11px]">
                  <span className="text-accent-ink">${pin.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{pin.label}</span>
                  <button
                    className="text-faint hover:text-ink"
                    aria-label={t('ui.unpin')}
                    onClick={() => unpin(pin.name)}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function ControlItem({
  variable,
  control,
  expanded,
  onToggle
}: {
  variable: RolledVariable
  control?: ControlRow
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useT()
  const pin = usePinsStore((s) => s.pins.find((p) => sameName(p.name, variable.name)))
  const unpin = usePinsStore((s) => s.unpin)
  const label = control && control.label !== variable.name ? control.label : null
  const fn = pickFn(variable)

  return (
    <li className="border-b border-line/60 last:border-b-0">
      <button
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-surface-2/50"
        aria-expanded={expanded}
        title={control?.note || undefined}
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown size={12} className="shrink-0 text-faint" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-faint" />
        )}
        {label ? (
          <span className="w-28 shrink-0 truncate text-[12px] font-medium text-ink">{label}</span>
        ) : (
          <span className="w-28 shrink-0 truncate font-mono text-[11.5px] text-accent-ink">
            ${variable.name}
          </span>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {pin ? (
            <span className="min-w-0 truncate rounded bg-accent/10 px-1.5 font-mono text-[11px] text-accent-ink">
              {pin.picks && pin.picks.length > 1 ? (
                <Dices size={10} className="mr-1 inline" />
              ) : (
                <Pin size={10} className="mr-1 inline" />
              )}
              {shorten(pin.label, 70)}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-faint">{t('ui.controlsRandom')}</span>
          )}
          <span className="min-w-0 truncate font-mono text-[10.5px] text-faint" title={variable.value}>
            {variable.value ? `→ ${shorten(variable.value, 60)}` : ''}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-1.5 bg-surface-2/40 px-3 pb-2 pt-1">
          {fn ? (
            <PickEditor variable={variable} control={control} fn={fn} />
          ) : (
            <p className="text-[11px] text-faint">{t('ui.controlsNoChoices')}</p>
          )}
          <PinFooter variable={variable} pinned={!!pin} onUnpin={() => unpin(variable.name)} />
        </div>
      )}
    </li>
  )
}

/** Ticked entries with their weights, the entry list and, for rows, the by-column tab. */
function PickEditor({
  variable,
  control,
  fn
}: {
  variable: RolledVariable
  control?: ControlRow
  fn: PickFn
}): React.JSX.Element {
  const t = useT()
  const pin = usePinsStore((s) => s.pins.find((p) => sameName(p.name, variable.name)))
  const setPicks = usePinsStore((s) => s.setPicks)
  const rows = fn !== 'random'
  const input = control?.input ?? (rows ? 'both' : 'pick')
  const canFilter = rows && input !== 'pick'
  const canPick = input !== 'filter'
  const showWeights = control?.weights !== false
  const [tab, setTab] = useState<'pick' | 'filter'>(() =>
    pin?.pickMode === 'filter' || !canPick ? 'filter' : 'pick'
  )
  const picks: PinPick[] = pin?.picks && pin.pickMode === tab ? pin.picks : []

  const update = (next: PinPick[]): void => setPicks(variable.name, fn, next, tab)
  const toggle = (lock: string, label: string): void => {
    const has = picks.some((p) => p.lock === lock)
    update(has ? picks.filter((p) => p.lock !== lock) : [...picks, { lock, label, weight: 1 }])
  }
  const setWeight = (lock: string, weight: number): void =>
    update(picks.map((p) => (p.lock === lock ? { ...p, weight } : p)))

  return (
    <div className="flex flex-col gap-1.5">
      {canPick && canFilter && (
        <div className="flex gap-1" role="tablist">
          {(['pick', 'filter'] as const).map((mode) => (
            <button
              key={mode}
              role="tab"
              aria-selected={tab === mode}
              className={cn(
                'rounded-md px-2 py-0.5 text-[11px]',
                tab === mode
                  ? 'bg-accent/15 text-accent-ink'
                  : 'text-faint hover:bg-surface-2 hover:text-ink'
              )}
              onClick={() => setTab(mode)}
            >
              {mode === 'pick' ? t('ui.controlsTabEntries') : t('ui.controlsTabByColumn')}
            </button>
          ))}
        </div>
      )}
      {picks.length > 0 && (
        <ul className="flex flex-col gap-0.5 rounded-md border border-accent/30 bg-paper p-1">
          {picks.map((p) => (
            <li key={p.lock} className="flex items-center gap-1.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-mono text-ink" title={p.lock}>
                {p.label}
              </span>
              {showWeights && picks.length > 1 && (
                <>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.5}
                    value={p.weight}
                    aria-label={t('ui.controlsWeightOf', p.label)}
                    className="w-20 accent-[var(--accent)]"
                    onChange={(e) => setWeight(p.lock, Number(e.target.value))}
                  />
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={p.weight}
                    aria-label={t('ui.controlsWeightOf', p.label)}
                    className="h-5 w-12 rounded border border-line bg-paper px-1 text-right font-mono text-[11px] text-ink"
                    onChange={(e) => {
                      const value = Number(e.target.value)
                      if (Number.isFinite(value) && value >= 0) setWeight(p.lock, value)
                    }}
                  />
                </>
              )}
              <button
                className="grid size-4 place-items-center rounded text-faint hover:text-ink"
                aria-label={t('ui.controlsUntick', p.label)}
                title={t('ui.controlsUntick', p.label)}
                onClick={() => toggle(p.lock, p.label)}
              >
                <X size={10} />
              </button>
            </li>
          ))}
          {picks.length > 1 && (
            <li className="pt-0.5 text-[10.5px] text-faint">{t('ui.controlsRollsAmong', picks.length)}</li>
          )}
        </ul>
      )}
      {tab === 'pick' ? (
        <EntryList variable={variable} control={control} picks={picks} onToggle={toggle} />
      ) : (
        <ColumnFilter
          sheets={
            control?.choices ? choiceSheets(control.choices) : variable.sheet ? [variable.sheet] : []
          }
          allowed={control?.filters ?? []}
          picks={picks}
          onToggle={toggle}
        />
      )}
    </div>
  )
}

/** The entries a control can tick: its `choices` rows, or the options of the variable's definition. */
function EntryList({
  variable,
  control,
  picks,
  onToggle
}: {
  variable: RolledVariable
  control?: ControlRow
  picks: PinPick[]
  onToggle: (lock: string, label: string) => void
}): React.JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const [choices, setChoices] = useState<ControlChoice[] | null>(null)
  const fromSheet = !!control?.choices && (variable.kind === 'row' || variable.kind === 'deal')
  const showKey = (control?.show ?? []).join(',')

  useEffect(() => {
    if (!fromSheet || !control?.choices) return
    let cancelled = false
    void controlChoices(control.choices, showKey ? showKey.split(',') : []).then((rows) => {
      if (!cancelled) setChoices(rows)
    })
    return () => {
      cancelled = true
    }
  }, [fromSheet, control?.choices, showKey])

  const all: { label: string; lock: string; detail?: string }[] = fromSheet
    ? (choices ?? [])
    : (variable.options ?? []).map((o) => ({ label: o.label, lock: o.lock }))
  const q = query.trim().toLowerCase()
  const hits = q
    ? all.filter(
        (o) => o.label.toLowerCase().includes(q) || (o.detail ?? '').toLowerCase().includes(q)
      )
    : all
  const shown = hits.slice(0, MAX_SHOWN)
  const ticked = new Set(picks.map((p) => p.lock))
  // a row option's lock is `row(<…>)`; a choice's is the bare reference: compare both forms
  const isTicked = (lock: string): boolean =>
    ticked.has(lock) || ticked.has(lock.replace(/^(?:row|deal)\(([\s\S]*)\)$/, '$1'))

  if (fromSheet && choices === null) {
    return (
      <div className="flex justify-center py-2 text-muted">
        <Loader2 size={13} className="animate-spin" />
      </div>
    )
  }
  return (
    <>
      {all.length > 8 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('ui.searchValuesValue', all.length)}
          aria-label={t('ui.searchValuesValue', all.length)}
          className="h-6 w-full rounded-md border border-line bg-paper px-2 text-[11.5px] text-ink outline-none placeholder:text-muted focus:border-accent/50"
        />
      )}
      <ul className="max-h-52 overflow-y-auto rounded-md border border-line bg-paper">
        {shown.map((option) => {
          const checked = isTicked(option.lock)
          return (
            <li key={option.lock}>
              <label
                className="flex cursor-pointer items-center gap-1.5 px-2 py-0.5 text-[11px] text-ink hover:bg-surface-2"
                title={option.detail || option.lock}
              >
                <input
                  type="checkbox"
                  className="size-3 shrink-0 accent-[var(--accent)]"
                  checked={checked}
                  onChange={() => {
                    // untick by the form that was stored
                    const stored = picks.find(
                      (p) =>
                        p.lock === option.lock ||
                        p.lock === option.lock.replace(/^(?:row|deal)\(([\s\S]*)\)$/, '$1')
                    )
                    onToggle(stored?.lock ?? option.lock, shorten(option.label, 48))
                  }}
                />
                <span className={cn('min-w-0 flex-1 truncate font-mono', checked && 'text-accent-ink')}>
                  {option.label}
                </span>
              </label>
            </li>
          )
        })}
        {shown.length === 0 && (
          <li className="px-2 py-2 text-center text-[11px] text-faint">{t('ui.noMatches')}</li>
        )}
        {hits.length > shown.length && (
          <li className="px-2 py-1 text-center text-[10.5px] text-faint">
            {t('ui.controlsMoreEntries', hits.length - shown.length)}
          </li>
        )}
      </ul>
    </>
  )
}

/** "Rows whose <column> is …": each ticked value is a pool `<sheet/*[column=value]>`, with its own weight. */
function ColumnFilter({
  sheets,
  allowed,
  picks,
  onToggle
}: {
  sheets: string[]
  allowed: string[]
  picks: PinPick[]
  onToggle: (lock: string, label: string) => void
}): React.JSX.Element | null {
  const t = useT()
  const [sheet, setSheet] = useState(sheets[0] ?? '')
  const [columns, setColumns] = useState<SheetColumnValues[] | null>(null)
  const [column, setColumn] = useState('')
  const [query, setQuery] = useState('')
  const allowedKey = allowed.join('|')

  useEffect(() => {
    if (!sheet) return
    let cancelled = false
    void columnValues(sheet).then((all) => {
      if (cancelled) return
      const wanted = allowedKey
        .split('|')
        .filter(Boolean)
        .map((a) => a.toLowerCase().replace(/[^a-z0-9]+/g, '_'))
      const usable = wanted.length > 0 ? all.filter((c) => wanted.includes(c.column)) : all
      setColumns(usable)
      setColumn((current) => (usable.some((c) => c.column === current) ? current : (usable[0]?.column ?? '')))
    })
    return () => {
      cancelled = true
    }
  }, [sheet, allowedKey])

  if (!sheet) return <p className="text-[11px] text-faint">{t('ui.controlsNoColumns')}</p>
  if (columns === null) return null
  if (columns.length === 0) return <p className="text-[11px] text-faint">{t('ui.controlsNoColumns')}</p>
  const current = columns.find((c) => c.column === column)
  const q = query.trim().toLowerCase()
  const values = (current?.values ?? []).filter((v) => !q || v.value.includes(q)).slice(0, MAX_SHOWN)
  const lockFor = (value: string): string =>
    `<${sheet}/*[${current!.column}${current!.list ? '~=' : '='}${value}]>`

  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-paper p-1.5">
      <div className="flex items-center gap-1 text-[11px] text-muted">
        <SlidersHorizontal size={11} className="shrink-0" />
        {sheets.length > 1 && (
          <select
            className="h-6 min-w-0 rounded border border-line bg-paper px-1 text-[11.5px] text-ink"
            aria-label={t('ui.controlsSheet')}
            value={sheet}
            onChange={(e) => setSheet(e.target.value)}
          >
            {sheets.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <span className="shrink-0">{t('ui.controlsFilterBy')}</span>
        <select
          className="h-6 min-w-0 flex-1 rounded border border-line bg-paper px-1 text-[11.5px] text-ink"
          aria-label={t('ui.controlsFilterBy')}
          value={column}
          onChange={(e) => setColumn(e.target.value)}
        >
          {columns.map((c) => (
            <option key={c.column} value={c.column}>
              {c.column}
              {c.list ? ' (list)' : ''}
            </option>
          ))}
        </select>
      </div>
      {(current?.values.length ?? 0) > 12 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('ui.searchValuesValue', current?.values.length ?? 0)}
          aria-label={t('ui.searchValuesValue', current?.values.length ?? 0)}
          className="h-6 w-full rounded border border-line bg-paper px-1.5 text-[11.5px] text-ink outline-none placeholder:text-muted focus:border-accent/50"
        />
      )}
      <ul className="max-h-40 overflow-y-auto">
        {values.map((v) => {
          const lock = lockFor(v.value)
          const checked = picks.some((p) => p.lock === lock)
          return (
            <li key={v.value}>
              <label className="flex cursor-pointer items-center gap-1.5 px-1 py-0.5 text-[11px] text-ink hover:bg-surface-2">
                <input
                  type="checkbox"
                  className="size-3 accent-[var(--accent)]"
                  checked={checked}
                  onChange={() => onToggle(lock, `${current!.column} = ${v.value}`)}
                />
                <span className="min-w-0 flex-1 truncate font-mono">{v.value}</span>
                <span className="text-faint">{v.count}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Random as defined, keep the current value, or a typed value / expression. */
function PinFooter({
  variable,
  pinned,
  onUnpin
}: {
  variable: RolledVariable
  pinned: boolean
  onUnpin: () => void
}): React.JSX.Element {
  const t = useT()
  const pin = usePinsStore((s) => s.pin)
  const [custom, setCustom] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-1">
      {pinned && (
        <button
          className="rounded-md border border-line bg-paper px-2 py-0.5 text-[11px] text-ink hover:bg-surface-2"
          onClick={onUnpin}
        >
          <Dices size={11} className="mr-1 inline" />
          {t('ui.controlsRandomAsDefined')}
        </button>
      )}
      {variable.lock && (
        <button
          className="rounded-md border border-line bg-paper px-2 py-0.5 text-[11px] text-ink hover:bg-surface-2"
          title={variable.lock}
          onClick={() =>
            pin({
              name: variable.name,
              lock: variable.lock,
              label: shorten(variable.value, 120) || variable.lock
            })
          }
        >
          <Pin size={11} className="mr-1 inline" />
          {t('ui.controlsKeepCurrent')}
        </button>
      )}
      <form
        className="flex min-w-40 flex-1 gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          if (!custom.trim()) return
          pin({ name: variable.name, lock: custom.trim(), label: custom.trim() })
          setCustom('')
        }}
      >
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={t('ui.pinCustomValue')}
          aria-label={t('ui.pinCustomValue')}
          className="h-6 min-w-0 flex-1 rounded-md border border-line bg-paper px-2 font-mono text-[11px] text-ink outline-none placeholder:font-sans placeholder:text-muted focus:border-accent/50"
        />
        <button
          type="submit"
          className="rounded-md border border-line px-2 text-[11px] text-ink hover:bg-surface-2"
        >
          {t('ui.pin')}
        </button>
      </form>
    </div>
  )
}
