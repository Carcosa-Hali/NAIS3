import { createRequire } from 'node:module'
import { loadSharp, shouldUseWasm } from './sharp-loader'

// Required at runtime rather than imported, so the loader's hook is in place before sharp loads.
const sharp = loadSharp({
  load: createRequire(__filename),
  useWasm: shouldUseWasm(process.platform, process.versions)
})
export default sharp
