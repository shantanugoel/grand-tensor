/** The Bun-side transport: a native Stockfish binary over stdio.
 *
 *  Kept out of `engine.ts` so the UCI layer stays importable from browser code,
 *  which has no `Bun` global to spawn anything with. */

import { Engine, type EngineOptions, type UciTransport } from './engine'

export type StdioOptions = EngineOptions & {
  /** Binary to spawn. Defaults to whatever `stockfish` resolves to on PATH. */
  path?: string
}

export class StdioTransport implements UciTransport {
  private proc: ReturnType<typeof Bun.spawn>
  private stdin: import('bun').FileSink
  private buffer = ''
  private sink: ((line: string) => void) | null = null
  private pending: string[] = []
  private reading: Promise<void>

  constructor(path = 'stockfish') {
    this.proc = Bun.spawn([path], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    this.stdin = this.proc.stdin as import('bun').FileSink
    this.reading = this.pump()
  }

  /** Splits stdout into whole lines, which is the framing `Engine` expects. */
  private async pump(): Promise<void> {
    const decoder = new TextDecoder()
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      this.buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (line) this.emit(line)
      }
    }
    this.emit('') // The process died; unblock anyone waiting on it.
  }

  private emit(line: string): void {
    if (this.sink) this.sink(line)
    else this.pending.push(line)
  }

  onLine(cb: (line: string) => void): void {
    this.sink = cb
    for (const line of this.pending.splice(0)) cb(line)
  }

  /** Flushed on every command: a UCI engine that never sees the newline reach it
   *  simply sits there, which reads exactly like a hung search. */
  send(line: string): void {
    this.stdin.write(line + '\n')
    this.stdin.flush()
  }

  async close(): Promise<void> {
    try {
      await this.stdin.end()
    } catch {
      // Already gone; nothing to shut down.
    }
    this.proc.kill()
    await this.reading.catch(() => {})
  }
}

/** An `Engine` backed by a local Stockfish binary. */
export function stockfishEngine(opts: StdioOptions = {}): Engine {
  return new Engine(new StdioTransport(opts.path), opts)
}

/** How long the probe waits for `uciok` before calling it not an engine. */
const PROBE_MS = 5000

/** Whether a usable engine is on PATH, so the runner can fail with a useful
 *  install hint instead of a spawn stack trace — and so the tests that need one
 *  skip rather than fail on a machine without it.
 *
 *  This asks for a UCI handshake rather than merely checking that something
 *  spawns, because something usually does. `bun install` puts a `stockfish`
 *  shim in node_modules/.bin, and on a machine with no engine that shim is what
 *  a bare name resolves to: it spawns happily, exits immediately, and used to
 *  be reported as an engine. What followed was every engine test failing on CI
 *  with "engine exited while waiting for uciok" — the right error, from the
 *  wrong place, because the question had already been answered wrongly here. */
export async function engineAvailable(path = 'stockfish'): Promise<boolean> {
  let engine: Engine | null = null
  try {
    engine = stockfishEngine({ path })
    return await Promise.race([
      engine.ready().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROBE_MS)),
    ])
  } catch {
    // Nothing to spawn, or something that spawned and died. Either way, no engine.
    return false
  } finally {
    await engine?.close().catch(() => {})
  }
}
