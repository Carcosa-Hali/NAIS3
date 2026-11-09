import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Dices,
  SlidersHorizontal,
  Loader2,
  Pin,
  PinOff,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ControlRow, RolledVariable, SheetColumnValues } from '@shared/types'
import { usePinsStore } from '../stores/pins-store'
import { cn } from '../lib/utils'
import { useT } from '../lib/i18n'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const shorten = (text: string, limit = 60): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** Pin button for the prompt header: opens the pin panel; the badge counts the active pins. */
export function PinButton(): React.JSX.Element {
  const t = useT()
  const count = usePinsStore((s) => s.pins.length)
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'relative grid size-5 place-items-center rounded transition-colors hover:text-ink',
            count > 0 ? 'text-accent-ink' : 'text-faint'
          )}
          title={t('ui.pinPanel')}
        >
          <Pin size={13} />
          {count > 0 && (
            <span className="absolute -right-1 -top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-0.5 text-[9px] font-semibold leading-none text-paper">
              {count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[440px] p-0">
        {open && <PinPanel />}
      </PopoverContent>
    </Popover>
  )
}

/** Active pins as small chips (shown above the prompt while any pin is set). */
export function PinChips(): React.JSX.Element | null {
  const t = useT()
  const pins = usePinsStore((s) => s.pins)
  const unpin = usePinsStore((s) => s.unpin)
  if (pins.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Pin size={11} className="text-accent-ink" />
      {pins.map((pin) => (
        <span
          key={pin.name}
          title={`$${pin.name} := ${pin.lock}`}
          className="flex max-w-full items-center gap-1 rounded-full border border-accent/30 bg-accent/10 py-0.5 pl-2 pr-1 font-mono text-[10.5px] text-accent-ink"
        >
          <span className="truncate">
            ${pin.name}: {shorten(pin.label, 28)}
          </span>
          <button
            className="grid size-3.5 place-items-center rounded-full hover:bg-accent/20"
            title={t('ui.unpin')}
            onClick={() => unpin(pin.name)}
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  )
}

/** Column values per sheet, fetched once per panel session (the sheet may change between openings). */
const columnCache = new Map<string, Promise<SheetColumnValues[]>>()

function columnValues(sheet: string): Promise<SheetColumnValues[]> {
  const key = sheet.toLowerCase()
  let pending = columnCache.get(key)
  if (!pending) {
    pending = window.nais.invoke('workbook:columnValues', { sheet }).catch(() => [])
    columnCache.set(key, pending)
  }
  return pending
}

/** `random(<a#1>)` -> `<a#1>`; a literal option stays as it is. */
function optionItem(lock: string): string {
  const match = /^random\(([\s\S]*)\)$/.exec(lock.trim())
  return match ? match[1] : lock
}

function PinPanel(): React.JSX.Element {
  const t = useT()
  const pins = usePinsStore((s) => s.pins)
  const lastRoll = usePinsStore((s) => s.lastRoll)
  const rolling = usePinsStore((s) => s.rolling)
  const roll = usePinsStore((s) => s.roll)
  const unpin = usePinsStore((s) => s.unpin)
  const clear = usePinsStore((s) => s.clear)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [controls, setControls] = useState<ControlRow[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Fresh list of variables (and their values) and of the controls sheet every time the panel opens.
  useEffect(() => {
    columnCache.clear()
    void roll()
    void window.nais
      .invoke('workbook:controls', undefined)
      .then(setControls)
      .catch(() => setControls([]))
  }, [roll])

  const variables = useMemo(() => lastRoll?.variables ?? [], [lastRoll])
  const pinnedNames = new Set(pins.map((p) => p.name.toLowerCase()))
  // pins whose variable did not come up in this roll (renamed, or the mode changed)
  const stray = pins.filter(
    (p) => !variables.some((v) => v.name.toLowerCase() === p.name.toLowerCase())
  )

  // Variables with a visible controls row come first, grouped in sheet order; the rest is "advanced".
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
  const showAdvanced = groups.length === 0 || advancedOpen

  const row = (variable: RolledVariable, control?: ControlRow): React.JSX.Element => (
    <VariableRow
      key={variable.name}
      variable={variable}
      control={control}
      pinned={pinnedNames.has(variable.name.toLowerCase())}
      expanded={expanded === variable.name}
      onToggle={() => setExpanded(expanded === variable.name ? null : variable.name)}
    />
  )

  return (
    <div className="flex max-h-[75vh] flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <p className="text-[12.5px] font-medium text-ink">{t('ui.pinPanel')}</p>
        <div className="flex items-center gap-1">
          {pins.length > 0 && (
            <button
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-surface-2 hover:text-ink"
              onClick={clear}
            >
              <PinOff size={12} /> {t('ui.unpinAll')}
            </button>
          )}
          <button
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-surface-2 hover:text-ink"
            title={t('ui.rollAgain')}
            disabled={rolling}
            onClick={() => void roll()}
          >
            {rolling ? <Loader2 size={12} className="animate-spin" /> : <Dices size={12} />}
            {t('ui.rollAgain')}
          </button>
        </div>
      </div>
      <p className="border-b border-line/60 px-3 py-1.5 text-[11px] text-faint">
        {t('ui.pinPanelHint')}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {lastRoll && !lastRoll.ok && (
          <div className="m-2 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-[11.5px] text-danger-ink">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span className="select-text whitespace-pre-wrap break-words">{lastRoll.error}</span>
          </div>
        )}
        {lastRoll === null && (
          <div className="flex justify-center py-8 text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
        {lastRoll && variables.length === 0 && lastRoll.ok && (
          <p className="px-3 py-6 text-center text-[12px] text-faint">{t('ui.noVariables')}</p>
        )}
        {groups.map(({ group, items }) => (
          <div key={group}>
            {group && (
              <p className="border-b border-line/60 bg-surface-2/40 px-3 py-1 text-[10.5px] font-medium uppercase tracking-wide text-faint">
                {group}
              </p>
            )}
            <ul>{items.map(({ variable, control }) => row(variable, control))}</ul>
          </div>
        ))}
        {groups.length > 0 && advanced.length > 0 && (
          <button
            className="flex w-full items-center gap-1 border-b border-line/60 bg-surface-2/40 px-3 py-1 text-left text-[10.5px] font-medium uppercase tracking-wide text-faint hover:text-ink"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {t('ui.controlsAdvanced', advanced.length)}
          </button>
        )}
        {showAdvanced && <ul>{advanced.map(({ variable, control }) => row(variable, control))}</ul>}
        {stray.length > 0 && (
          <div className="border-t border-line px-3 py-1.5">
            <p className="pb-1 text-[11px] text-faint">{t('ui.pinsNotInPrompt')}</p>
            {stray.map((pin) => (
              <div key={pin.name} className="flex items-center gap-2 py-0.5 font-mono text-[11px]">
                <span className="text-accent-ink">${pin.name}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{pin.label}</span>
                <button className="text-faint hover:text-ink" onClick={() => unpin(pin.name)}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function VariableRow({
  variable,
  control,
  pinned,
  expanded,
  onToggle
}: {
  variable: RolledVariable
  control?: ControlRow
  pinned: boolean
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useT()
  const pin = usePinsStore((s) => s.pin)
  const unpin = usePinsStore((s) => s.unpin)
  const pinRecord = usePinsStore((s) =>
    s.pins.find((p) => p.name.toLowerCase() === variable.name.toLowerCase())
  )
  const [query, setQuery] = useState('')
  const [custom, setCustom] = useState('')
  const [chosen, setChosen] = useState<string[]>([])

  const options = useMemo(() => {
    const all = variable.options ?? []
    const q = query.trim().toLowerCase()
    const hits = q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all
    return hits.slice(0, 200)
  }, [variable.options, query])
  const total = variable.options?.length ?? 0
  const subset = variable.kind === 'random' && total > 1
  const filterable = (variable.kind === 'row' || variable.kind === 'deal') && !!variable.sheet

  const pinSubset = (): void => {
    const picked = (variable.options ?? []).filter((o) => chosen.includes(o.lock))
    if (picked.length === 0) return
    pin({
      name: variable.name,
      lock: `random(${picked.map((o) => optionItem(o.lock)).join(', ')})`,
      label: t('ui.controlsAnyOf', picked.map((o) => shorten(o.label, 24)).join(', '))
    })
    setChosen([])
  }

  const shown = pinRecord?.label ?? variable.value
  return (
    <li className="border-b border-line/60 last:border-b-0">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button className="text-faint hover:text-ink" onClick={onToggle}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          onClick={onToggle}
          title={control?.note || undefined}
        >
          {control && control.label !== variable.name ? (
            <span className="shrink-0 text-[12px] font-medium text-ink">
              {control.label}{' '}
              <span className="font-mono text-[10.5px] font-normal text-faint">
                ${variable.name}
              </span>
            </span>
          ) : (
            <span className="shrink-0 font-mono text-[11.5px] text-accent-ink">
              ${variable.name}
            </span>
          )}
          <span className="min-w-0 truncate font-mono text-[11px] text-muted" title={shown}>
            {shown ? shorten(shown, 80) : t('ui.none')}
          </span>
        </button>
        <button
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-md transition-colors',
            pinned
              ? 'bg-accent/15 text-accent-ink hover:bg-accent/25'
              : 'text-faint hover:bg-surface-2 hover:text-ink'
          )}
          title={pinned ? t('ui.unpin') : t('ui.pinThisValue')}
          onClick={() =>
            pinned
              ? unpin(variable.name)
              : pin({
                  name: variable.name,
                  lock: variable.lock,
                  label: shorten(variable.value, 120) || variable.lock
                })
          }
        >
          {pinned ? <Pin size={12} /> : <Pin size={12} className="opacity-60" />}
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-1.5 bg-surface-2/40 px-3 pb-2 pt-1">
          {pinned && (
            <button
              className="self-start rounded-md border border-line bg-paper px-2 py-0.5 text-[11.5px] text-ink hover:bg-surface-2"
              onClick={() => unpin(variable.name)}
            >
              <Dices size={11} className="mr-1 inline" />
              {t('ui.controlsRandomAsDefined')}
            </button>
          )}
          {filterable && (
            <FilterPicker
              sheet={variable.sheet!}
              fn={variable.kind as 'row' | 'deal'}
              allowed={control?.filters ?? []}
              onPin={(lock, label) => pin({ name: variable.name, lock, label })}
            />
          )}
          {total > 0 && (
            <>
              <input
                autoFocus={!filterable}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('ui.searchValuesValue', total)}
                className="h-7 w-full rounded-md border border-line bg-paper px-2 text-[12px] text-ink outline-none placeholder:text-muted focus:border-accent/50"
              />
              {subset && <p className="text-[10.5px] text-faint">{t('ui.controlsSubsetHint')}</p>}
              <ul className="max-h-48 overflow-y-auto rounded-md border border-line bg-paper">
                {options.map((option) => {
                  const current = pinRecord?.lock === option.lock
                  const checked = chosen.includes(option.lock)
                  return (
                    <li key={option.lock} className="flex items-center">
                      {subset && (
                        <input
                          type="checkbox"
                          className="ml-2 size-3 shrink-0 accent-[var(--accent)]"
                          checked={checked}
                          onChange={() =>
                            setChosen(
                              checked
                                ? chosen.filter((c) => c !== option.lock)
                                : [...chosen, option.lock]
                            )
                          }
                        />
                      )}
                      <button
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left font-mono text-[11px] hover:bg-surface-2',
                          current ? 'text-accent-ink' : 'text-ink'
                        )}
                        title={option.lock}
                        onClick={() =>
                          pin({ name: variable.name, lock: option.lock, label: option.label })
                        }
                      >
                        {current ? (
                          <Pin size={10} className="shrink-0" />
                        ) : (
                          <span className="w-2.5" />
                        )}
                        <span className="truncate">{option.label}</span>
                      </button>
                    </li>
                  )
                })}
                {options.length === 0 && (
                  <li className="px-2 py-2 text-center text-[11px] text-faint">
                    {t('ui.noMatches')}
                  </li>
                )}
              </ul>
              {subset && chosen.length > 0 && (
                <button
                  className="self-start rounded-md bg-accent px-2 py-0.5 text-[11.5px] font-medium text-paper hover:opacity-90"
                  onClick={pinSubset}
                >
                  {t('ui.controlsPinSubset', chosen.length)}
                </button>
              )}
            </>
          )}
          <form
            className="flex gap-1"
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
              className="h-7 min-w-0 flex-1 rounded-md border border-line bg-paper px-2 font-mono text-[11.5px] text-ink outline-none placeholder:font-sans placeholder:text-muted focus:border-accent/50"
            />
            <button
              type="submit"
              className="rounded-md border border-line px-2 text-[11.5px] text-ink hover:bg-surface-2"
            >
              {t('ui.pin')}
            </button>
          </form>
        </div>
      )}
    </li>
  )
}

/**
 * "Random among the rows where <column> is one of …": pins `row(<sheet/*[column=a,b]>)` (or `deal(...)`, or
 * `~=` for a comma-list column), so the variable keeps rolling, but only within the chosen subset.
 */
function FilterPicker({
  sheet,
  fn,
  allowed,
  onPin
}: {
  sheet: string
  fn: 'row' | 'deal'
  allowed: string[]
  onPin: (lock: string, label: string) => void
}): React.JSX.Element | null {
  const t = useT()
  const [columns, setColumns] = useState<SheetColumnValues[] | null>(null)
  const [column, setColumn] = useState('')
  const [values, setValues] = useState<string[]>([])
  const [query, setQuery] = useState('')

  // a fresh array arrives on every render: depend on its contents
  const allowedKey = allowed.join('|')
  useEffect(() => {
    let cancelled = false
    void columnValues(sheet).then((all) => {
      if (cancelled) return
      const wanted = allowedKey
        .split('|')
        .filter(Boolean)
        .map((a) => a.toLowerCase().replace(/[^a-z0-9]+/g, '_'))
      const usable = wanted.length > 0 ? all.filter((c) => wanted.includes(c.column)) : all
      setColumns(usable)
      setColumn(usable[0]?.column ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [sheet, allowedKey])

  if (columns === null) return null
  if (columns.length === 0) return null
  const current = columns.find((c) => c.column === column)
  const q = query.trim().toLowerCase()
  const shownValues = (current?.values ?? []).filter((v) => !q || v.value.includes(q)).slice(0, 200)

  const apply = (): void => {
    if (!current || values.length === 0) return
    const op = current.list ? '~=' : '='
    onPin(
      `${fn}(<${sheet}/*[${current.column}${op}${values.join(', ')}]>)`,
      t('ui.controlsWhere', current.column, values.join(', '))
    )
    setValues([])
  }

  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-paper p-1.5">
      <div className="flex items-center gap-1 text-[11px] text-muted">
        <SlidersHorizontal size={11} className="shrink-0" />
        <span className="shrink-0">{t('ui.controlsFilterBy')}</span>
        <select
          className="h-6 min-w-0 flex-1 rounded border border-line bg-paper px-1 text-[11.5px] text-ink"
          value={column}
          onChange={(e) => {
            setColumn(e.target.value)
            setValues([])
          }}
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
          className="h-6 w-full rounded border border-line bg-paper px-1.5 text-[11.5px] text-ink outline-none placeholder:text-muted focus:border-accent/50"
        />
      )}
      <ul className="max-h-36 overflow-y-auto">
        {shownValues.map((v) => {
          const checked = values.includes(v.value)
          return (
            <li key={v.value}>
              <label className="flex cursor-pointer items-center gap-1.5 px-1 py-0.5 text-[11px] text-ink hover:bg-surface-2">
                <input
                  type="checkbox"
                  className="size-3 accent-[var(--accent)]"
                  checked={checked}
                  onChange={() =>
                    setValues(checked ? values.filter((x) => x !== v.value) : [...values, v.value])
                  }
                />
                <span className="min-w-0 flex-1 truncate font-mono">{v.value}</span>
                <span className="text-faint">{v.count}</span>
              </label>
            </li>
          )
        })}
      </ul>
      {values.length > 0 && (
        <button
          className="self-start rounded-md bg-accent px-2 py-0.5 text-[11.5px] font-medium text-paper hover:opacity-90"
          onClick={apply}
        >
          {t('ui.controlsPinFilter', values.length)}
        </button>
      )}
    </div>
  )
}
