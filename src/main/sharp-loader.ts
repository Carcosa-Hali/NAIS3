import Module from 'node:module'
import type SharpModule from 'sharp'

type Sharp = typeof SharpModule
type ResolveFilename = (request: string, ...rest: unknown[]) => string
type ModuleInternals = {
  _resolveFilename: ResolveFilename
  _cache: Record<string, unknown>
}

// Electron on Linux links the system GLib, while sharp's prebuilt libvips bundles its own.
// Two GLib type systems in one process print GLib-GObject-CRITICAL spam and may misbehave,
// so on Linux Electron we hide the native binary and sharp falls back to @img/sharp-wasm32.
export const NATIVE_LINUX_BINARY = /^@img\/sharp-linux(musl)?-[^/]+\/sharp\.node$/

// sharp itself, its platform binaries and libvips. Cleared before retrying with the native build.
const SHARP_MODULE_PATH = /[\\/]node_modules[\\/](sharp|@img[\\/]sharp-[^\\/]+)[\\/]/

export function isSharpModulePath(path: string): boolean {
  return SHARP_MODULE_PATH.test(path)
}

export function shouldUseWasm(
  platform: NodeJS.Platform,
  versions: NodeJS.ProcessVersions
): boolean {
  return platform === 'linux' && Boolean(versions.electron)
}

export interface SharpLoaderOptions {
  /** `require` bound to the caller, so `sharp` resolves from its node_modules */
  load: (id: string) => unknown
  useWasm: boolean
  /** Requests to hide from sharp's loader. Only tests override this. */
  nativeBinary?: RegExp
  log?: Pick<Console, 'info' | 'warn'>
}

export function loadSharp({
  load,
  useWasm,
  nativeBinary = NATIVE_LINUX_BINARY,
  log = console
}: SharpLoaderOptions): Sharp {
  if (!useWasm) return load('sharp') as Sharp

  const internal = Module as unknown as ModuleInternals
  const resolveFilename = internal._resolveFilename
  internal._resolveFilename = function (request, ...rest) {
    if (nativeBinary.test(request)) {
      throw Object.assign(new Error(`Cannot find module '${request}'`), {
        code: 'MODULE_NOT_FOUND'
      })
    }
    return resolveFilename.call(this, request, ...rest)
  }
  try {
    const sharp = load('sharp') as Sharp
    log.info('[sharp] Linux Electron: using the WebAssembly build (@img/sharp-wasm32)')
    return sharp
  } catch (error) {
    // A missing or broken WebAssembly build must not stop the app from starting:
    // the native build still works, only with GLib warnings.
    log.warn('[sharp] WebAssembly build failed to load, falling back to the native build', error)
  } finally {
    internal._resolveFilename = resolveFilename
  }

  for (const path of Object.keys(internal._cache)) {
    if (isSharpModulePath(path)) delete internal._cache[path]
  }
  return load('sharp') as Sharp
}
