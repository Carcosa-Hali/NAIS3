import { AlertCircle, Dices, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { RollPreviewResult } from '@shared/types'
import { cn } from '../lib/utils'
import { useT } from '../lib/i18n'
import { enabledCharacters } from '../stores/characters-store'
import { useGenerationStore } from '../stores/generation-store'
import { RolledVariablesList } from './rolled-variables'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

/** One random roll of the current prompts (fragments, sheets, variables) without generating. */
export function RollPreviewDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const [result, setResult] = useState<RollPreviewResult | null>(null)
  const [loading, setLoading] = useState(false)

  const roll = useCallback(async () => {
    setLoading(true)
    const request = useGenerationStore.getState().request
    try {
      setResult(
        await window.nais.invoke('fragments:rollPreview', {
          prompt: request.prompt,
          negativePrompt: request.negativePrompt,
          characters: enabledCharacters().map((c) => ({
            prompt: c.prompt,
            negativePrompt: c.negativePrompt
          }))
        })
      )
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        variables: [],
        picks: []
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => void roll())
    return () => clearTimeout(timer)
  }, [open, roll])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-[760px] flex-col p-0">
        <DialogTitle className="border-b border-line px-5 py-3.5 text-[15px]">
          {t('ui.rollPreview')}{' '}
          <span className="text-[12px] font-normal text-faint">{t('ui.rollPreviewHint')}</span>
        </DialogTitle>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
          {result === null ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : (
            <>
              {!result.ok && (
                <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 p-2.5 text-[12.5px] text-danger-ink">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <span className="select-text whitespace-pre-wrap break-words">
                    {t('ui.rollPreviewFailed', result.error)}
                  </span>
                </div>
              )}
              <RolledVariablesList variables={result.variables} />
              {result.ok && (
                <>
                  <Text label={t('ui.prompt')} value={result.prompt} tall />
                  <Text label={t('ui.negative')} value={result.negativePrompt} />
                  {result.characters.map((c, i) => (
                    <div key={i} className="flex flex-col gap-1.5">
                      <Text label={t('ui.characterValue', i + 1)} value={c.prompt} />
                      {c.negativePrompt && <Text label="uc" value={c.negativePrompt} small />}
                    </div>
                  ))}
                </>
              )}
              {result.picks.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="text-[12px] font-medium text-ink">{t('ui.pickedEntries')}</p>
                  <ul className="max-h-48 overflow-y-auto rounded-md border border-line bg-surface-2/40 text-[11.5px]">
                    {result.picks.map((pick, i) => (
                      <li
                        key={i}
                        className="flex select-text gap-2 border-b border-line/60 px-2 py-1 last:border-b-0"
                      >
                        <span className="shrink-0 font-mono text-accent-ink">
                          &lt;{pick.path}&gt;
                          {pick.row !== undefined && (
                            <span className="text-faint"> {t('ui.rowValue', pick.row)}</span>
                          )}
                        </span>
                        <span className="min-w-0 truncate font-mono text-muted">{pick.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('ui.close')}
          </Button>
          <Button variant="accent" disabled={loading} onClick={() => void roll()}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Dices size={14} />}
            {t('ui.rollAgain')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Text({
  label,
  value,
  tall,
  small
}: {
  label: string
  value: string
  tall?: boolean
  small?: boolean
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-medium text-faint">{label}</p>
      {/* body의 user-select:none 때문에 textarea여야 선택·스크롤 가능 */}
      <textarea
        readOnly
        value={value}
        placeholder={t('ui.none')}
        className={cn(
          'block w-full resize-y cursor-text select-text whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2/40 p-2 font-mono leading-relaxed text-ink outline-none placeholder:font-sans placeholder:text-muted',
          tall ? 'h-32 text-[12.5px]' : small ? 'h-12 text-[11px]' : 'h-20 text-[12px]'
        )}
      />
    </div>
  )
}
