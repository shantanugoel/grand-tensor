/** The browser-side transport: a Stockfish wasm build in a Web Worker.
 *
 *  The wasm builds all speak the same shape — one UCI line per `postMessage`,
 *  in both directions — so the transport is mostly framing and a death sentinel.
 *  A worker that fails to load (no wasm, blocked by CSP, bad URL) fires `error`
 *  rather than throwing at the call site, so that is translated into the empty
 *  line `Engine` reads as "the engine is gone". */

import type { UciTransport } from './engine'

export class WorkerTransport implements UciTransport {
  private sink: ((line: string) => void) | null = null
  private pending: string[] = []
  private closed = false

  constructor(private worker: Worker) {
    this.worker.addEventListener('message', (ev: MessageEvent) => {
      // Some builds post `{data: "..."}`-wrapped payloads; take the string either way.
      const raw = typeof ev.data === 'string' ? ev.data : (ev.data?.data ?? '')
      if (typeof raw !== 'string') return
      // A build may emit several lines in one message.
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) this.emit(trimmed)
      }
    })
    const die = () => this.emit('')
    this.worker.addEventListener('error', die)
    this.worker.addEventListener('messageerror', die)
  }

  private emit(line: string): void {
    if (this.closed) return
    if (line === '') this.closed = true
    if (this.sink) this.sink(line)
    else this.pending.push(line)
  }

  onLine(cb: (line: string) => void): void {
    this.sink = cb
    for (const line of this.pending.splice(0)) cb(line)
  }

  send(line: string): void {
    if (this.closed) return
    this.worker.postMessage(line)
  }

  close(): void {
    this.closed = true
    this.worker.terminate()
  }
}
