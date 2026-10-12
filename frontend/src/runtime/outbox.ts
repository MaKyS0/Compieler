import type { FromWorker } from "./protocol";

type Phase = Extract<FromWorker, { type: "out" }>["phase"];
type Stream = Extract<FromWorker, { type: "out" }>["stream"];

/**
 * Programs print in tiny pieces (one write per printf / console.log). A write that arrives after a quiet moment
 * is posted at once (so progress, prompts and the last line before an endless loop are never held back);
 * only rapid bursts are coalesced. Pending text is always flushed right before the program blocks waiting for
 * input and when it ends. (A synchronous worker cannot flush on a timer, hence the burst rule.)
 */
export class Outbox {
  private key: string | null = null;
  private phase: Phase = "run";
  private stream: Stream = "stdout";
  private parts: string[] = [];
  private size = 0;
  private t1 = 0; // time of the previous write
  private t2 = 0; // time of the write before that

  constructor(private post: (m: FromWorker) => void) {}

  write(phase: Phase, stream: Stream, data: string) {
    if (!data) return;
    const k = `${phase}:${stream}`;
    if (this.key !== k) {
      this.flush();
      this.key = k;
      this.phase = phase;
      this.stream = stream;
    }
    this.parts.push(data);
    this.size += data.length;
    const now = performance.now();
    // a burst = three writes within 4 ms; anything sparser is posted immediately
    const burst = now - this.t2 < 4;
    this.t2 = this.t1;
    this.t1 = now;
    if (this.size > 16384 || !burst) this.flush();
  }

  flush() {
    if (this.parts.length) this.post({ type: "out", phase: this.phase, stream: this.stream, data: this.parts.join("") });
    this.parts = [];
    this.size = 0;
  }
}
