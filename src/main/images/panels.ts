import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { extname, join, sep } from 'path'
import type { PanelImage, PanelTarget } from '../../shared/types'
import { getDb } from '../db'
import { sceneDir, storedThumbnailUrl } from './storage'

/**
 * Doujin panel images. A panel's images are saved like scene images, under
 * <scene folder>/doujin - <doujin>/<NNN panel name>/, so every panel has its own folder (named in reading order)
 * and the images can be found again by their path without any extra database column.
 */

const PREFIX = 'doujin - '

/** Folder names a panel's images are saved under (preset = doujin folder, scene = panel folder). */
export function panelFolderNames(target: PanelTarget): { presetName: string; sceneName: string } {
  return {
    presetName: `${PREFIX}${target.doujin}`,
    sceneName: `${String(target.index).padStart(3, '0')} ${target.name}`
  }
}

export function panelDir(target: PanelTarget): string {
  const { presetName, sceneName } = panelFolderNames(target)
  return sceneDir(presetName, sceneName)
}

const LIMIT = 200

export function panelImages(target: PanelTarget): PanelImage[] {
  const prefix = panelDir(target) + sep
  const rows = getDb()
    .prepare(
      `SELECT id, file_path, length(thumbnail) AS thumb_size, seed, favorite, created_at FROM images
       WHERE substr(file_path, 1, ?) = ? ORDER BY id DESC LIMIT ?`
    )
    .all(prefix.length, prefix, LIMIT) as {
    id: number
    file_path: string
    thumb_size: number | null
    seed: number | null
    favorite: number
    created_at: string
  }[]
  return rows
    .filter((r) => existsSync(r.file_path))
    .map((r) => ({
      id: r.id,
      filePath: r.file_path,
      thumbnailUrl: storedThumbnailUrl('image', r.id, r.created_at, r.thumb_size),
      seed: r.seed,
      favorite: r.favorite === 1
    }))
}

/**
 * Copies, in panel order, every panel's favourite images (or its newest image when it has none) into `target`,
 * as `NNN panel name.png`, `NNN panel name_2.png`, … Returns how many files were written.
 */
export function exportPanels(doujin: string, names: string[], target: string): number {
  mkdirSync(target, { recursive: true })
  const safe = (s: string): string => s.replace(/[/\\:*?"<>|]/g, '_').trim()
  let count = 0
  names.forEach((name, i) => {
    const images = panelImages({ doujin, index: i + 1, name })
    const favourites = images.filter((image) => image.favorite).reverse() // oldest first
    const chosen = favourites.length > 0 ? favourites : images.slice(0, 1)
    chosen.forEach((image, n) => {
      const base = `${String(i + 1).padStart(3, '0')} ${safe(name)}${n > 0 ? `_${n + 1}` : ''}`
      copyFileSync(image.filePath, join(target, `${base}${extname(image.filePath) || '.png'}`))
      count++
    })
  })
  return count
}
