export type Language = "python" | "cpp" | "javascript";

export interface User {
  id: number;
  email: string | null;
  name: string;
  is_guest: boolean;
}

export interface ProjectSettings {
  entry?: string;
  cpp_std?: "c++11" | "c++14" | "c++17" | "c++20" | "c++23";
  cpp_opt?: "-O0" | "-O1" | "-O2" | "-O3";
  args?: string;
}

export interface Project {
  id: number;
  name: string;
  language: Language;
  settings: ProjectSettings;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
}

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}

export interface Problem {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
}

export interface ServerConfig {
  languages: Language[];
  cpp_standards: string[];
  formatters: Record<Language, boolean>;
  limits: {
    run_wall_seconds: number;
    run_cpu_seconds: number;
    memory_mb: number;
    max_output_bytes: number;
    max_upload_bytes: number;
  };
  allow_runtime_network: boolean;
  allow_registration: boolean;
  sandbox: { backend: string; isolation?: string };
}

export type ExitReason =
  | "ok"
  | "error"
  | "timeout"
  | "cpu_limit"
  | "memory"
  | "output_limit"
  | "stopped"
  | "signal"
  | "compile_error"
  | "install_failed"
  | "sandbox_error";

export type ServerEvent =
  | { type: "ready"; sandbox: ServerConfig["sandbox"] }
  | { type: "start"; kind: "run" | "shell" | "install" }
  | { type: "status"; state: string }
  | { type: "output"; phase: string; stream: "stdout" | "stderr" | "system"; data: string }
  | { type: "problems"; items: Problem[]; phase?: string }
  | {
      type: "exit";
      kind: "run" | "shell" | "install";
      phase: string;
      code: number | null;
      signal: string | null;
      reason: ExitReason;
      duration_ms: number;
      detail: string;
    }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

export interface RunRequest {
  entry?: string;
  args?: string;
  stdin?: string;
  std?: string;
  opt?: string;
  timeout?: number;
}
