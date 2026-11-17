// Les typings d'Orca n'embarquent pas les types Node : on ne déclare que les membres réellement utilisés.
declare module 'node:fs/promises' {
  export type Stats = { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; mtimeMs: number }
  export type DirEntry = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }
  export function stat(path: string): Promise<Stats>
  export function lstat(path: string): Promise<Stats>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function mkdtemp(prefix: string): Promise<string>
  export function readdir(path: string): Promise<string[]>
  export function readdir(path: string, options: { withFileTypes: true }): Promise<DirEntry[]>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  export function rmdir(path: string): Promise<void>
  export function unlink(path: string): Promise<void>
  export function symlink(target: string, path: string): Promise<void>
  export function rename(from: string, to: string): Promise<void>
  export function chmod(path: string, mode: number): Promise<void>
}

declare module 'node:path' {
  export const sep: string
  export function join(...parts: string[]): string
  export function dirname(path: string): string
  export function relative(from: string, to: string): string
  export function resolve(...parts: string[]): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): {
    update(data: string): { digest(encoding: 'hex'): string }
  }
}

declare module 'node:os' {
  export function tmpdir(): string
  export function homedir(): string
}

declare module 'node:child_process' {
  export type ChildProcess = {
    stdout: { on(event: 'data', listener: (chunk: { toString(): string }) => void): void } | null
    /** Flux d'erreur du processus : `null` si le stdio correspondant n'est pas en `pipe`. */
    stderr: { on(event: 'data', listener: (chunk: { toString(): string }) => void): void; destroy(): void } | null
    /** Entrée du processus : `null` si le stdio correspondant n'est pas en `pipe`. */
    stdin: {
      write(data: string): boolean
      end(): void
      on(event: 'error', listener: (error: Error) => void): void
    } | null
    on(event: 'close', listener: (code: number | null) => void): void
    on(event: 'exit', listener: (code: number | null) => void): void
    on(event: 'error', listener: (error: Error) => void): void
    kill(signal?: string): boolean
  }
  export type ExecFileOptions = { timeout?: number; killSignal?: string; maxBuffer?: number; encoding: 'utf8' }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (failure: Error | null, stdout: string, stderr: string) => void
  ): ChildProcess
  export function spawn(
    command: string,
    args: readonly string[],
    options: { stdio: readonly ('ignore' | 'pipe')[] }
  ): ChildProcess
}

declare const process: { env: Record<string, string | undefined>; execPath: string; platform: string }

declare module 'node:fs' {
  export function existsSync(path: string): boolean
}

declare module 'node:test' {
  /** Horloge simulée de node:test : seulement ce que les tests du panneau en utilisent. */
  export const mock: {
    timers: {
      enable(options: { apis: readonly ('setInterval' | 'setTimeout' | 'setImmediate' | 'Date')[] }): void
      tick(milliseconds: number): void
      reset(): void
    }
  }
}
