import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Dices,
  Loader2,
  Pin,
  PinOff,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { RolledVariable } from '@shared/types'
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
      <PopoverContent align="end" className="w-[380px] p-0">
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

function PinPanel(): React.JSX.Element {
  const t = useT()
  const pins = usePinsStore((s) => s.pins)
  const lastRoll = usePinsStore((s) => s.lastRoll)
  const rolling = usePinsStore((s) => s.rolling)
  const roll = usePinsStore((s) => s.roll)
  const unpin = usePinsStore((s) => s.unpin)
  const clear = usePinsStore((s) => s.clear)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Fresh list of variables (and their values) every time the panel opens.
  useEffect(() => {
    void roll()
  }, [roll])

  const variables = lastRoll?.variables ?? []
  const pinnedNames = new Set(pins.map((p) => p.name.toLowerCase()))
  // pins whose variable did not come up in this roll (renamed, or the mode changed)
  const stray = pins.filter(
    (p) => !variables.some((v) => v.name.toLowerCase() === p.name.toLowerCase())
  )

  return (
    <div className="flex max-h-[70vh] flex-col">
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
        <ul>
          {variables.map((variable) => (
            <VariableRow
              key={variable.name}
              variable={variable}
              pinned={pinnedNames.has(variable.name.toLowerCase())}
              expanded={expanded === variable.name}
              onToggle={() => setExpanded(expanded === variable.name ? null : variable.name)}
            />
          ))}
        </ul>
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
  pinned,
  expanded,
  onToggle
}: {
  variable: RolledVariable
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

  const options = useMemo(() => {
    const all = variable.options ?? []
    const q = query.trim().toLowerCase()
    const hits = q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all
    return hits.slice(0, 200)
  }, [variable.options, query])
  const total = variable.options?.length ?? 0

  const shown = pinRecord?.label ?? variable.value
  return (
    <li className="border-b border-line/60 last:border-b-0">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button className="text-faint hover:text-ink" onClick={onToggle}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button className="flex min-w-0 flex-1 items-baseline gap-2 text-left" onClick={onToggle}>
          <span className="shrink-0 font-mono text-[11.5px] text-accent-ink">${variable.name}</span>
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
          {total > 0 && (
            <>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('ui.searchValuesValue', total)}
                className="h-7 w-full rounded-md border border-line bg-paper px-2 text-[12px] text-ink outline-none placeholder:text-muted focus:border-accent/50"
              />
              <ul className="max-h-48 overflow-y-auto rounded-md border border-line bg-paper">
                {options.map((option) => {
                  const current = pinRecord?.lock === option.lock
                  return (
                    <li key={option.lock}>
                      <button
                        className={cn(
                          'flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-[11px] hover:bg-surface-2',
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
