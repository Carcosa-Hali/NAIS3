import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Layers,
  Loader2,
  Play,
  Star,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { imageUrl } from '../lib/constants'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import { useGenerationStore } from '../stores/generation-store'
import { bindPanelEvents, usePanelsStore } from '../stores/panels-store'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/**
 * Doujin panel stepper: pick a doujin (a workbook with a `panels` sheet), step through its panels in reading
 * order, and see / star the images generated for the current panel. While a panel is active, generated images
 * are saved into that panel's folder. Hidden while no workbook has a panels sheet.
 */
export function DoujinBar(): React.JSX.Element | null {
  const t = useT()
  const books = usePanelsStore((s) => s.books)
  const loaded = usePanelsStore((s) => s.loaded)
  const loading = usePanelsStore((s) => s.loading)
  const doujin = usePanelsStore((s) => s.doujin)
  const positions = usePanelsStore((s) => s.positions)
  const active = usePanelsStore((s) => s.active)
  const images = usePanelsStore((s) => s.images)
  const load = usePanelsStore((s) => s.load)
  const selectDoujin = usePanelsStore((s) => s.selectDoujin)
  const go = usePanelsStore((s) => s.go)
  const leave = usePanelsStore((s) => s.leave)
  const toggleFavorite = usePanelsStore((s) => s.toggleFavorite)
  const exportAll = usePanelsStore((s) => s.exportAll)
  const openFolder = usePanelsStore((s) => s.openFolder)
  const view = useGenerationStore((s) => s.view)
  const [listOpen, setListOpen] = useState(false)
  const [bookOpen, setBookOpen] = useState(false)

  useEffect(() => {
    if (!loaded) void load().catch(() => undefined)
  }, [loaded, load])
  useEffect(() => bindPanelEvents(), [])

  if (books.length === 0) return null
  const book = books.find((b) => b.doujin === doujin) ?? books[0]
  const index = positions[book.doujin] ?? 1
  const panel = book.panels[index - 1]
  const total = book.panels.length

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <div className="no-drag flex h-8 w-full items-center gap-1 rounded-md border border-line bg-surface-2/50 px-1.5 text-[13px] font-medium">
        <Popover
          open={bookOpen}
          onOpenChange={(next: boolean) => {
            setBookOpen(next)
            if (next) void load().catch(() => undefined)
          }}
        >
          <PopoverTrigger asChild>
            <button
              className="flex min-w-0 shrink items-center gap-1 rounded px-1 hover:bg-surface-2"
              title={t('ui.doujinChoose')}
            >
              <Layers size={13} className="shrink-0 text-muted" />
              <span className="truncate">{book.doujin}</span>
              <ChevronDown size={12} className="shrink-0 text-muted" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1">
            {books.map((b) => (
              <button
                key={b.doujin}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2',
                  b.doujin === book.doujin && 'font-semibold text-accent-ink'
                )}
                onClick={() => {
                  setBookOpen(false)
                  selectDoujin(b.doujin)
                }}
              >
                <span className="truncate">{b.doujin}</span>
                <span className="text-[11px] font-normal text-faint">
                  {t('ui.doujinPanelsValue', b.panels.length)}
                </span>
              </button>
            ))}
            <button
              className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-faint hover:bg-surface-2 hover:text-ink"
              onClick={() => void load()}
            >
              {loading && <Loader2 size={12} className="animate-spin" />}
              {t('ui.reloadModes')}
            </button>
          </PopoverContent>
        </Popover>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            className="grid size-6 place-items-center rounded hover:bg-surface-2 disabled:opacity-40"
            disabled={index <= 1}
            title={t('ui.doujinPrevious')}
            onClick={() => void go(index - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <Popover open={listOpen} onOpenChange={setListOpen}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[12px] hover:bg-surface-2',
                  active ? 'text-accent-ink' : 'text-muted'
                )}
                title={t('ui.doujinJump')}
              >
                {index} / {total}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-1">
              <div className="max-h-80 overflow-y-auto no-scrollbar">
                {book.panels.map((p, i) => (
                  <button
                    key={p.id}
                    className={cn(
                      'flex w-full min-w-0 flex-col items-start rounded-md px-2 py-1 text-left hover:bg-surface-2',
                      i + 1 === index && 'text-accent-ink'
                    )}
                    onClick={() => {
                      setListOpen(false)
                      void go(i + 1)
                    }}
                  >
                    <span
                      className={cn(
                        'w-full truncate text-[12.5px]',
                        i + 1 === index && 'font-semibold'
                      )}
                    >
                      <span className="mr-1.5 font-mono text-[11px] text-faint">{i + 1}</span>
                      {p.name}
                    </span>
                    {p.note && (
                      <span className="w-full truncate text-[11px] text-faint">{p.note}</span>
                    )}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <button
            className="grid size-6 place-items-center rounded hover:bg-surface-2 disabled:opacity-40"
            disabled={index >= total}
            title={t('ui.doujinNext')}
            onClick={() => void go(index + 1)}
          >
            <ChevronRight size={14} />
          </button>
          {active ? (
            <button
              className="grid size-6 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink"
              title={t('ui.doujinLeave')}
              onClick={leave}
            >
              <X size={13} />
            </button>
          ) : (
            <button
              className="grid size-6 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink"
              title={t('ui.doujinStart')}
              onClick={() => void go(index)}
            >
              <Play size={12} />
            </button>
          )}
        </div>
      </div>

      {active && panel && (
        <div className="flex flex-col gap-1 rounded-md border border-line/70 bg-surface-2/30 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[12px]">
            <span className="min-w-0 flex-1 truncate" title={panel.note || panel.name}>
              <span className="font-medium text-ink">{panel.name}</span>
              {panel.note && <span className="ml-1.5 text-faint">{panel.note}</span>}
            </span>
            <button
              className="grid size-6 shrink-0 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink"
              title={t('ui.doujinOpenFolder')}
              onClick={openFolder}
            >
              <FolderOpen size={13} />
            </button>
            <button
              className="grid size-6 shrink-0 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink"
              title={t('ui.doujinExport')}
              onClick={() => void exportAll()}
            >
              <Download size={13} />
            </button>
          </div>
          {images.length === 0 ? (
            <p className="text-[11px] text-faint">{t('ui.doujinNoImages')}</p>
          ) : (
            <div className="flex gap-1 overflow-x-auto pb-0.5">
              {images.map((image) => (
                <div key={image.id} className="relative shrink-0">
                  <button
                    className="block overflow-hidden rounded border border-line hover:border-accent/60"
                    title={image.seed != null ? `seed ${image.seed}` : undefined}
                    onClick={() => view(image.filePath)}
                  >
                    <img
                      src={image.thumbnailUrl || imageUrl(image.filePath)}
                      alt=""
                      className="h-14 w-14 object-cover"
                      loading="lazy"
                    />
                  </button>
                  <button
                    className={cn(
                      'absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-paper/80',
                      image.favorite ? 'text-accent' : 'text-faint hover:text-ink'
                    )}
                    title={t('ui.doujinFavorite')}
                    onClick={() => void toggleFavorite(image)}
                  >
                    <Star size={10} fill={image.favorite ? 'currentColor' : 'none'} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
