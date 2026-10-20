import { readFileSync } from 'fs'
import Module, { createRequire } from 'node:module'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_LINUX_BINARY,
  isSharpModulePath,
  loadSharp,
  shouldUseWasm
} from '../src/main/sharp-loader'

type ResolveFilename = (request: string, ...rest: unknown[]) => string
type ModuleInternals = { _resolveFilename: ResolveFilename; _cache: Record<string, unknown> }

const internal = Module as unknown as ModuleInternals

const installedVersion = (name: string): string =>
  JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version

const silentLog = (): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } => ({
  info: vi.fn(),
  warn: vi.fn()
})

/** Asks Node to resolve a request the way sharp's loader does, reporting whether it was hidden */
const resolves = (request: string): boolean => {
  try {
    internal._resolveFilename(request, null)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'MODULE_NOT_FOUND') return false
    throw error
  }
}

describe('sharp WebAssembly fallback', () => {
  // src/main/sharp.ts loads @img/sharp-wasm32 under Electron on Linux; sharp expects its own version.
  it('matches the installed sharp version', () => {
    expect(installedVersion('@img/sharp-wasm32')).toBe(installedVersion('sharp'))
  })

  it('uses WebAssembly only under Electron on Linux', () => {
    const electron = { ...process.versions, electron: '39.0.0' }
    const node = { ...process.versions, electron: undefined } as unknown as NodeJS.ProcessVersions
    expect(shouldUseWasm('linux', electron)).toBe(true)
    expect(shouldUseWasm('linux', node)).toBe(false)
    expect(shouldUseWasm('darwin', electron)).toBe(false)
    expect(shouldUseWasm('win32', electron)).toBe(false)
  })

  it('recognises sharp and @img module paths for cache clearing', () => {
    expect(isSharpModulePath('/app/node_modules/sharp/dist/index.cjs')).toBe(true)
    expect(isSharpModulePath('/app/node_modules/@img/sharp-wasm32/index.cjs')).toBe(true)
    expect(isSharpModulePath('C:\\app\\node_modules\\@img\\sharp-win32-x64\\sharp.node')).toBe(true)
    expect(isSharpModulePath('/app/node_modules/@img/colour/index.cjs')).toBe(false)
    expect(isSharpModulePath('/app/node_modules/sharpie/index.js')).toBe(false)
  })
})

describe('loadSharp hook', () => {
  let original: ResolveFilename

  beforeEach(() => {
    original = internal._resolveFilename
    internal._resolveFilename = vi.fn((request: string) => `/resolved/${request}`)
  })

  afterEach(() => {
    internal._resolveFilename = original
  })

  it('loads sharp untouched when WebAssembly is not wanted', () => {
    const stub = internal._resolveFilename
    const load = vi.fn(() => {
      expect(internal._resolveFilename).toBe(stub)
      return 'native'
    })
    expect(loadSharp({ load, useWasm: false, log: silentLog() })).toBe('native')
    expect(load).toHaveBeenCalledWith('sharp')
  })

  it('hides only the Linux native binaries while sharp loads, then restores the resolver', () => {
    const stub = internal._resolveFilename
    const seen: Record<string, boolean> = {}
    const load = vi.fn(() => {
      for (const request of [
        '@img/sharp-linux-x64/sharp.node',
        '@img/sharp-linux-arm64/sharp.node',
        '@img/sharp-linuxmusl-x64/sharp.node',
        '@img/sharp-wasm32/sharp.node',
        '@img/sharp-libvips-linux-x64/package',
        '@img/sharp-darwin-arm64/sharp.node',
        'detect-libc'
      ]) {
        seen[request] = resolves(request)
      }
      return 'wasm'
    })
    const log = silentLog()

    expect(loadSharp({ load, useWasm: true, log })).toBe('wasm')
    expect(seen).toEqual({
      '@img/sharp-linux-x64/sharp.node': false,
      '@img/sharp-linux-arm64/sharp.node': false,
      '@img/sharp-linuxmusl-x64/sharp.node': false,
      '@img/sharp-wasm32/sharp.node': true,
      '@img/sharp-libvips-linux-x64/package': true,
      '@img/sharp-darwin-arm64/sharp.node': true,
      'detect-libc': true
    })
    expect(internal._resolveFilename).toBe(stub)
    expect(log.info).toHaveBeenCalledOnce()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('falls back to the native build when the WebAssembly build fails to load', () => {
    const stub = internal._resolveFilename
    const sharpPath = '/app/node_modules/sharp/dist/libvips.cjs'
    const otherPath = '/app/node_modules/semver/index.js'
    internal._cache[sharpPath] = {}
    internal._cache[otherPath] = {}
    const failure = new Error('Could not load the "sharp" module')
    const load = vi
      .fn<(id: string) => unknown>()
      .mockImplementationOnce(() => {
        expect(resolves('@img/sharp-linux-x64/sharp.node')).toBe(false)
        throw failure
      })
      .mockImplementationOnce(() => {
        expect(internal._resolveFilename).toBe(stub)
        expect(resolves('@img/sharp-linux-x64/sharp.node')).toBe(true)
        return 'native'
      })
    const log = silentLog()

    try {
      expect(loadSharp({ load, useWasm: true, log })).toBe('native')
      expect(load).toHaveBeenCalledTimes(2)
      expect(internal._cache[sharpPath]).toBeUndefined()
      expect(internal._cache[otherPath]).toBeDefined()
      expect(log.warn).toHaveBeenCalledWith(expect.any(String), failure)
      expect(log.info).not.toHaveBeenCalled()
    } finally {
      delete internal._cache[sharpPath]
      delete internal._cache[otherPath]
    }
  })

  it('restores the resolver even when the native fallback also fails', () => {
    const stub = internal._resolveFilename
    const load = vi.fn(() => {
      throw new Error('no sharp at all')
    })
    expect(() => loadSharp({ load, useWasm: true, log: silentLog() })).toThrow('no sharp at all')
    expect(internal._resolveFilename).toBe(stub)
  })
})

describe('sharp WebAssembly build', () => {
  // Same mechanism as on Linux Electron, but hiding the native binary of whatever OS runs the tests.
  const ANY_NATIVE_BINARY = /^@img\/sharp-(darwin|linux|linuxmusl|win32)-[^/]+\/sharp\.node$/

  it('hides only Linux binaries by default', () => {
    expect(NATIVE_LINUX_BINARY.test('@img/sharp-linux-x64/sharp.node')).toBe(true)
    expect(NATIVE_LINUX_BINARY.test('@img/sharp-darwin-arm64/sharp.node')).toBe(false)
  })

  // The packaged-app smoke test repeats the loader's hook in a plain script.
  it('hides the same binaries in the packaged-app smoke test', () => {
    const script = readFileSync('scripts/verify-packaged-app.mjs', 'utf8')
    // Windows checkouts may use CRLF line endings.
    const copy = script.match(/^const NATIVE_LINUX_BINARY = \/(.+)\/\r?$/m)?.[1]
    expect(copy).toBe(NATIVE_LINUX_BINARY.source)
  })

  it('loads and processes images', async () => {
    const load = createRequire(join(process.cwd(), 'package.json'))
    for (const path of Object.keys(internal._cache)) {
      if (isSharpModulePath(path)) delete internal._cache[path]
    }
    const log = silentLog()
    const sharp = loadSharp({ load, useWasm: true, nativeBinary: ANY_NATIVE_BINARY, log })

    expect(log.warn).not.toHaveBeenCalled()
    expect(Object.keys(internal._cache).some((path) => path.includes('sharp-wasm32'))).toBe(true)

    const png = await sharp({
      create: { width: 64, height: 48, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } }
    })
      .png()
      .toBuffer()
    const webp = await sharp(png).resize(32).webp({ quality: 90 }).toBuffer({
      resolveWithObject: true
    })
    expect(webp.info).toMatchObject({ format: 'webp', width: 32, height: 24 })
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({
      resolveWithObject: true
    })
    expect(info.channels).toBe(4)
    expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 128])
  })
})
