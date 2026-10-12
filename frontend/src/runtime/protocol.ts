/** Messages between the main thread and the engine workers (Python / JavaScript / C++). */
export type FileMap = Record<string, Uint8Array>;

export interface StdinInit {
  /** Shared ring for interactive input; null when the page is not cross-origin isolated. */
  sab: SharedArrayBuffer | null;
  /** Text available immediately (Input tab). Used as the only input when `sab` is null. */
  prefill: string;
  /** True when `prefill` is everything (EOF follows); false = more may arrive through `sab`. */
  closed: boolean;
  /** Android app: blocking reads go through a synchronous XHR answered by native code (no SharedArrayBuffer needed). */
  native?: { gen: number } | null;
}

export type ToWorker =
  | { type: "init"; engineBase: string }
  | {
      type: "run";
      engineBase: string;
      files: FileMap;
      entry: string;
      args: string[];
      stdin: StdinInit;
      std?: string;
      opt?: string;
      requirements?: string[];
      /** Real device information (DEVICE_* variables) merged into the program environment. */
      env?: Record<string, string>;
    }
  | { type: "install"; engineBase: string; packages: string[] };

export type FromWorker =
  | { type: "ready" }
  | { type: "phase"; phase: "install" | "compile" | "run" }
  | { type: "out"; phase: "install" | "compile" | "run" | "system"; stream: "stdout" | "stderr" | "system"; data: string }
  | { type: "need-input" }
  | {
      type: "done";
      code: number | null;
      reason: "ok" | "error" | "compile_error" | "install_failed";
      changed: FileMap;
      deleted: string[];
      durationMs: number;
      detail?: string;
    };
