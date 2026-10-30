import { Check, ClipboardCopy } from 'lucide-react'
import { useState } from 'react'
import type { RolledVariable } from '@shared/types'
import { useT } from '../lib/i18n'

/** `$name := lock` lines: pasted into the main prompt they reproduce exactly these values. */
export function fixedValueLines(variables: RolledVariable[]): string {
  return variables.map((v) => `$${v.name} := ${v.lock}`).join('\n')
}

/** Rolled prompt variables (name → value) with a button that copies them as fixed values. */
export function RolledVariablesList({
  variables
}: {
  variables: RolledVariable[]
}): React.JSX.Element | null {
  const t = useT()
  const [copied, setCopied] = useState(false)
  if (variables.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-ink">{t('ui.rolledVariables')}</p>
        <button
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint transition-colors hover:bg-surface-2 hover:text-ink"
          title={t('ui.copyAsFixedValuesHint')}
          onClick={() => {
            void navigator.clipboard.writeText(fixedValueLines(variables))
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? <Check size={12} /> : <ClipboardCopy size={12} />}
          {t('ui.copyAsFixedValues')}
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto rounded-md border border-line bg-surface-2/40">
        <table className="w-full table-fixed border-collapse text-[11.5px]">
          <tbody>
            {variables.map((v) => (
              <tr key={v.name} className="border-b border-line/60 last:border-b-0 align-top">
                <td className="w-1/3 select-text truncate px-2 py-1 font-mono text-accent-ink">
                  ${v.name}
                </td>
                <td className="select-text whitespace-pre-wrap break-words px-2 py-1 font-mono text-ink">
                  {v.value || <span className="font-sans text-muted">{t('ui.none')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
