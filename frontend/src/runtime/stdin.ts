/**
 * Blocking stdin for programs running in a Worker.
 *
 * The worker calls ``read()`` synchronously (from inside Python's ``input()``, C++'s ``cin``, ...).
 * It asks the main thread for data and sleeps with ``Atomics.wait`` until the UI delivers a chunk
 * (user typed a line) or EOF through a SharedArrayBuffer. Requires cross-origin isolation; without
 * it only the pre-filled text of the Input tab is available.
 */
const HEADER = 16; // Int32[0]=state, Int32[1]=length
const CAPACITY = 1 << 16;
const IDLE = 0,
  DATA = 1,
  EOF = 2,
  WAITING = 3;

export const canShare = () => typeof SharedArrayBuffer !== "undefined" && (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

export function createStdinBuffer(): SharedArrayBuffer | null {
  return canShare() ? new SharedArrayBuffer(HEADER + CAPACITY) : null;
}

/** Main-thread side: queues what the user types and hands it to the worker when it asks. */
export class StdinFeeder {
  private queue: Uint8Array[] = [];
  private ended = false;
  private waiting = false;
  private ctrl: Int32Array | null;
  private data: Uint8Array | null;

  constructor(sab: SharedArrayBuffer | null) {
    this.ctrl = sab ? new Int32Array(sab, 0, 2) : null;
    this.data = sab ? new Uint8Array(sab, HEADER, CAPACITY) : null;
  }
  push(text: string) {
    if (this.ended) return;
    this.queue.push(new TextEncoder().encode(text));
    this.pump();
  }
  end() {
    this.ended = true;
    this.pump();
  }
  /** Called when the worker reports that it is blocked waiting for input. */
  needInput() {
    this.waiting = true;
    this.pump();
  }
  private pump() {
    if (!this.ctrl || !this.data || !this.waiting) return;
    if (this.queue.length) {
      const first = this.queue[0];
      const n = Math.min(first.length, CAPACITY);
      this.data.set(first.subarray(0, n));
      if (n < first.length) this.queue[0] = first.subarray(n);
      else this.queue.shift();
      this.ctrl[1] = n;
      this.waiting = false;
      Atomics.store(this.ctrl, 0, DATA);
      Atomics.notify(this.ctrl, 0);
    } else if (this.ended) {
      this.waiting = false;
      Atomics.store(this.ctrl, 0, EOF);
      Atomics.notify(this.ctrl, 0);
    }
  }
}

/** Worker side. */
export class StdinReader {
  private ctrl: Int32Array | null;
  private data: Uint8Array | null;
  private pending: Uint8Array = new Uint8Array(0);
  private eof = false;

  constructor(
    sab: SharedArrayBuffer | null,
    private prefill: string,
    closed: boolean,
    private requestInput: () => void,
  ) {
    this.ctrl = sab ? new Int32Array(sab, 0, 2) : null;
    this.data = sab ? new Uint8Array(sab, HEADER, CAPACITY) : null;
    if (this.prefill) this.pending = new TextEncoder().encode(this.prefill);
    if (!sab) this.eof = true; // nothing else will ever arrive
    else if (closed) this.eof = true;
  }

  /** Reads up to ``max`` bytes. Returns an empty array at EOF. Blocks while waiting for the user. */
  read(max: number): Uint8Array {
    while (this.pending.length === 0) {
      if (this.eof || !this.ctrl || !this.data) return new Uint8Array(0);
      Atomics.store(this.ctrl, 0, WAITING);
      this.requestInput();
      Atomics.wait(this.ctrl, 0, WAITING);
      const state = Atomics.load(this.ctrl, 0);
      if (state === DATA) {
        this.pending = this.data.slice(0, this.ctrl[1]);
        Atomics.store(this.ctrl, 0, IDLE);
      } else if (state === EOF) {
        this.eof = true;
        Atomics.store(this.ctrl, 0, IDLE);
      }
    }
    const n = Math.min(max, this.pending.length);
    const out = this.pending.slice(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }

  /** Everything until EOF (used by fs.readFileSync(0) style code). */
  readAll(): Uint8Array {
    const parts: Uint8Array[] = [];
    for (;;) {
      const chunk = this.read(CAPACITY);
      if (!chunk.length) break;
      parts.push(chunk);
    }
    const total = parts.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.length));
    return out;
  }
}
