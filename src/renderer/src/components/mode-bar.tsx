import { ChevronDown, Layers, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PromptMode } from '@shared/types'
import { askConfirm } from '../stores/dialog-store'
import { useGenerationStore } from '../stores/generation-store'
import { useModesStore } from '../stores/modes-store'
import { toast } from '../stores/toast-store'
import { cn } from '../lib/utils'
import { useT } from '../lib/i18n'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { WorkbookCheckDialog } from './workbook-check-dialog'

/**
 * Mode picker: the rows of the workbook's `modes` sheets. Picking one fills the main prompt, the negative and
 * the character boxes in one go. Hidden while no workbook has a modes sheet.
 */
export function ModeBar(): React.JSX.Element | null {
  const t = useT()
  const modes = useModesStore((s) => s.modes)
  const loaded = useModesStore((s) => s.loaded)
  const loading = useModesStore((s) => s.loading)
  const activeId = useModesStore((s) => s.activeId)
  const load = useModesStore((s) => s.load)
  const applyMode = useModesStore((s) => s.apply)
  const [open, setOpen] = useState(false)
  const [checkOpen, setCheckOpen] = useState(false)

  useEffect(() => {
    if (!loaded) void load().catch(() => undefined)
  }, [loaded, load])

  // Grouped by workbook file (a folder of workbooks); a single workbook has one unnamed group.
  const groups = useMemo(() => {
    const byFile = new Map<string, PromptMode[]>()
    for (const mode of modes) {
      const key = mode.file ?? ''
      byFile.set(key, [...(byFile.get(key) ?? []), mode])
    }
    return [...byFile.entries()]
  }, [modes])

  if (loaded && modes.length === 0) return null
  const active = modes.find((m) => m.id === activeId)

  const apply = async (mode: PromptMode): Promise<void> => {
    setOpen(false)
    const current = useGenerationStore.getState().request.prompt
    const lastApplied = modes.find((m) => m.id === activeId)?.prompt
    if (current.trim() && current !== lastApplied && current !== mode.prompt) {
      const ok = await askConfirm(t('ui.applyModeConfirm', mode.name), {
        message: t('ui.applyModeConfirmHint')
      })
      if (!ok) return
    }
    try {
      await applyMode(mode)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next: boolean) => {
          setOpen(next)
          // the sheet may have been edited since: re-read when the list opens
          if (next) void load().catch(() => undefined)
        }}
      >
        <PopoverTrigger asChild>
          <button className="no-drag flex h-8 w-full items-center gap-1.5 rounded-md border border-line bg-surface-2/50 px-2.5 text-[13px] font-medium hover:bg-surface-2">
            <Layers size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-left">
              {active ? (
                <>
                  <span className="text-faint">{t('ui.mode')}: </span>
                  {active.name}
                </>
              ) : (
                t('ui.chooseMode')
              )}
            </span>
            <ChevronDown size={14} className="shrink-0 text-muted" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-1">
          <div className="max-h-80 overflow-y-auto overflow-x-hidden no-scrollbar">
            {groups.map(([file, items]) => (
              <div key={file}>
                {file && (
                  <p className="px-2 pb-0.5 pt-1.5 font-mono text-[10.5px] uppercase tracking-wide text-faint">
                    {file}
                  </p>
                )}
                {items.map((mode) => (
                  <button
                    key={mode.id}
                    onClick={() => void apply(mode)}
                    title={mode.note}
                    className={cn(
                      'flex w-full min-w-0 flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-surface-2',
                      mode.id === activeId && 'text-accent-ink'
                    )}
                  >
                    <span
                      className={cn(
                        'w-full truncate text-[13px]',
                        mode.id === activeId && 'font-semibold'
                      )}
                    >
                      {mode.name}
                      <span className="ml-1.5 text-[11px] font-normal text-faint">
                        {t('ui.modeCharactersValue', mode.characters.length)}
                        {mode.size && ` · ${mode.size.width}×${mode.size.height}`}
                      </span>
                    </span>
                    {mode.note && (
                      <span className="w-full truncate text-[11px] text-faint">{mode.note}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="my-1 h-px bg-line" />
          <div className="flex gap-1">
            {active && (
              <button
                className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-accent-ink hover:bg-surface-2"
                title={t('ui.reapplyModeHint')}
                onClick={() => {
                  const fresh = useModesStore.getState().modes.find((m) => m.id === active.id)
                  if (fresh) void apply(fresh)
                }}
              >
                <RefreshCw size={13} /> {t('ui.reapplyMode')}
              </button>
            )}
            <button
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-faint hover:bg-surface-2 hover:text-ink"
              title={t('ui.workbookCheck')}
              onClick={() => {
                setOpen(false)
                setCheckOpen(true)
              }}
            >
              <ShieldCheck size={13} />
            </button>
            <button
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-faint hover:bg-surface-2 hover:text-ink"
              onClick={() => void load().catch(() => undefined)}
              title={t('ui.reloadModes')}
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {!active && t('ui.reloadModes')}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <WorkbookCheckDialog open={checkOpen} onOpenChange={setCheckOpen} />
    </>
  )
}
