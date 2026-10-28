// finding a command the way the shell would, on linux and on windows.
//
// linux looks for the bare name in each `:`-separated PATH entry. windows
// separates PATH with `;` and never runs a bare name: `codex` is `codex.exe`
// or an npm `codex.cmd` shim, so the lookup tries the extensions the caller
// can actually start. `node:path` is picked by the platform asked about rather
// than the one running, so a test can ask about either from either.
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export interface LookupOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /**
   * windows only: the extensions tried, in order. `execFile` and `spawn` start
   * a `.exe` or `.com` directly; a `.cmd` or `.bat` needs a shell, so only a
   * caller that spawns through `spawnTarget` should list those.
   */
  extensions?: string[]
  exists?: (path: string) => boolean
}

/** what `execFile` and a plain `spawn` can start on windows */
export const DIRECT_EXTENSIONS = ['.exe', '.com']

/** a windows batch shim (npm and bun install these): it only runs through a shell */
export function isBatchShim(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path)
}

/** the file names `name` can have on disk: itself on posix, itself with each extension on windows */
export function executableNames(name: string, platform: NodeJS.Platform = process.platform, extensions = DIRECT_EXTENSIONS): string[] {
  if (platform !== 'win32') return [name]
  // a name that already carries one of the extensions is taken as it is
  if (extensions.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()))) return [name]
  return extensions.map((ext) => `${name}${ext}`)
}

/** the PATH entries in order; windows spells the variable `Path` as often as `PATH` */
export function pathDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return (env.PATH ?? '').split(':').filter(Boolean)
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  return ((key ? env[key] : undefined) ?? '').split(';').filter(Boolean)
}

/** every path `name` could be found at in `dir` */
export function candidatesIn(dir: string, name: string, options: LookupOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  return executableNames(name, platform, options.extensions).map((file) => path.join(dir, file))
}

/**
 * `command` as a path on disk, or null when this machine does not have it. a
 * command with a directory in it is checked where it says; a bare name is
 * looked up on the PATH.
 */
export function findExecutable(command: string, options: LookupOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const hasDir = platform === 'win32' ? /[\\/]/.test(command) : command.includes('/')
  // kept as written, so `./agy` stays relative to the cwd and is not turned into a PATH lookup
  if (hasDir) return executableNames(command, platform, options.extensions).find(exists) ?? null
  for (const dir of pathDirs(options.env, platform)) {
    const found = candidatesIn(dir, command, options).find(exists)
    if (found) return found
  }
  return null
}

/**
 * how to spawn a found executable: directly, or through cmd.exe for a `.cmd`
 * shim, quoted because `shell: true` joins the command line unescaped.
 */
export function spawnTarget(path: string): { command: string; shell: boolean } {
  return isBatchShim(path) ? { command: `"${path}"`, shell: true } : { command: path, shell: false }
}
