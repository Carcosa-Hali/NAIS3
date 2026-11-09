import { ChevronDown, ChevronUp, Paintbrush } from 'lucide-react'
import { useGenerationStore } from '../stores/generation-store'
import { useStyleStore } from '../stores/style-store'
import { promptTokenLimit } from '@shared/nai-models'
import { cn } from '../lib/utils'
import { useT } from '../lib/i18n'
import { PromptEditor } from './prompt-editor'
import { Switch } from './ui/switch'

/**
 * Style layer: extra main-prompt and negative text sent with every image, on top of whatever the prompt boxes
 * hold. Modes and prompt presets replace the prompt boxes, never this, so artist sets and composition tags can
 * be tried on any mode. The style text is placed before the main prompt's `Text:` block.
 */
export function StyleLayerPanel(): React.JSX.Element {
  const t = useT()
  const model = useGenerationStore((s) => s.request.model)
  const prompt = useStyleStore((s) => s.prompt)
  const negativePrompt = useStyleStore((s) => s.negativePrompt)
  const enabled = useStyleStore((s) => s.enabled)
  const expanded = useStyleStore((s) => s.expanded)
  const patch = useStyleStore((s) => s.patch)
  const summary = [prompt, negativePrompt]
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ')

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <div
        className={cn(
          'no-drag flex h-8 w-full items-center gap-1.5 rounded-md border border-line bg-surface-2/50 px-2.5 text-[13px] font-medium',
          !enabled && 'opacity-60'
        )}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-ink"
          title={t('ui.styleLayerHint')}
          onClick={() => patch({ expanded: !expanded })}
        >
          <Paintbrush size={13} className="shrink-0 text-muted" />
          <span className="shrink-0 text-faint">{t('ui.styleLayer')}:</span>
          <span className="min-w-0 flex-1 truncate font-normal">
            {summary || <span className="text-faint">{t('ui.styleLayerEmpty')}</span>}
          </span>
          {expanded ? (
            <ChevronUp size={14} className="shrink-0 text-muted" />
          ) : (
            <ChevronDown size={14} className="shrink-0 text-muted" />
          )}
        </button>
        <Switch
          checked={enabled}
          onCheckedChange={(checked: boolean) => patch({ enabled: checked })}
          title={enabled ? t('ui.styleLayerOn') : t('ui.styleLayerOff')}
        />
      </div>
      {expanded && (
        <div className="flex flex-col gap-1">
          <PromptEditor
            className="h-16"
            value={prompt}
            tokenModel={model}
            tokenLimit={promptTokenLimit(model)}
            placeholder={t('ui.styleLayerPromptPlaceholder')}
            ariaLabel={t('ui.styleLayer')}
            onValueChange={(v) => patch({ prompt: v })}
          />
          <PromptEditor
            negative
            className="h-12"
            value={negativePrompt}
            tokenModel={model}
            tokenLimit={promptTokenLimit(model)}
            placeholder={t('ui.styleLayerNegativePlaceholder')}
            ariaLabel={t('ui.styleLayerNegative')}
            onValueChange={(v) => patch({ negativePrompt: v })}
          />
        </div>
      )}
    </div>
  )
}
