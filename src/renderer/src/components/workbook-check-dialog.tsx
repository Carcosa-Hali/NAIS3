import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { WorkbookCheckReport } from '@shared/types'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const ROLL_CHOICES = [50, 200, 500]

/**
 * Workbook check: literal references that resolve to nothing, and for every mode a number of sampled rolls
 * (failures, subject-count mismatches and how often each variable took each value). Nothing is generated.
 */
export function WorkbookCheckDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const [rolls, setRolls] = useState(ROLL_CHOICES[0])
  const [report, setReport] = useState<WorkbookCheckReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [openMode, setOpenMode] = useState<string | null>(null)

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      setReport(await window.nais.invoke('workbook:check', { rolls }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }, [rolls])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-[820px] flex-col p-0">
        <DialogTitle className="border-b border-line px-5 py-3.5 text-[15px]">
          {t('ui.workbookCheck')}{' '}
          <span className="text-[12px] font-normal text-faint">{t('ui.workbookCheckHint')}</span>
        </DialogTitle>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5 text-[12.5px]">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 p-2.5 text-danger-ink">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span className="select-text whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}
          {!report && !running && <p className="text-muted">{t('ui.workbookCheckIntro')}</p>}
          {running && (
            <div className="flex items-center justify-center gap-2 py-16 text-muted">
              <Loader2 size={18} className="animate-spin" />
            </div>
          )}
          {report && !running && (
            <>
              <section className="flex flex-col gap-1">
                <p className="font-medium text-ink">
                  {t('ui.workbookCheckMissing', report.missing.length)}
                </p>
                {report.missing.length > 0 && (
                  <ul className="max-h-48 overflow-y-auto rounded-md border border-line bg-surface-2/40 text-[11.5px]">
                    {report.missing.map((m, i) => (
                      <li
                        key={i}
                        className="flex select-text gap-2 border-b border-line/60 px-2 py-1 last:border-b-0"
                      >
                        <span className="shrink-0 font-mono text-danger-ink">
                          &lt;{m.reference}&gt;
                        </span>
                        <span className="min-w-0 truncate text-muted">{m.place}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {report.modes.map((mode) => {
                const bad = mode.failed > 0 || mode.countMismatch > 0
                const expanded = openMode === mode.id
                return (
                  <section key={mode.id} className="rounded-md border border-line">
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
                      onClick={() => setOpenMode(expanded ? null : mode.id)}
                    >
                      {bad ? (
                        <AlertCircle size={14} className="shrink-0 text-danger-ink" />
                      ) : (
                        <CheckCircle2 size={14} className="shrink-0 text-accent-ink" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">{mode.name}</span>
                      <span className={cn('text-[11.5px]', bad ? 'text-danger-ink' : 'text-faint')}>
                        {t(
                          'ui.workbookCheckModeSummary',
                          mode.failed,
                          mode.rolls,
                          mode.countMismatch
                        )}
                      </span>
                    </button>
                    {expanded && (
                      <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
                        {mode.errors.map((e, i) => (
                          <p key={i} className="select-text whitespace-pre-wrap text-danger-ink">
                            {e.count}× {e.message}
                          </p>
                        ))}
                        {mode.countExample && (
                          <p className="text-danger-ink">
                            {t('ui.workbookCheckCountExample', mode.countExample)}
                          </p>
                        )}
                        {mode.variables.map((v) => (
                          <div key={v.name} className="flex flex-col gap-0.5">
                            <p className="font-mono text-[11.5px] text-ink">
                              ${v.name}{' '}
                              <span className="text-faint">
                                {t('ui.workbookCheckDistinct', v.distinct)}
                              </span>
                            </p>
                            <p className="select-text break-words font-mono text-[11px] text-muted">
                              {v.top.map((x) => `${x.value} ×${x.count}`).join(' · ')}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )
              })}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <div className="flex items-center gap-1 text-[12px] text-muted">
            {t('ui.workbookCheckRolls')}
            {ROLL_CHOICES.map((n) => (
              <button
                key={n}
                className={cn(
                  'rounded px-1.5 py-0.5 hover:bg-surface-2',
                  n === rolls && 'bg-surface-2 font-semibold text-ink'
                )}
                onClick={() => setRolls(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('ui.close')}
            </Button>
            <Button variant="accent" disabled={running} onClick={() => void run()}>
              {running ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              {t('ui.workbookCheckRun')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
