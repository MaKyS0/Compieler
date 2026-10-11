import { getToken } from "./client";
import type { RunRequest, ServerEvent } from "./types";

type Listener = (ev: ServerEvent) => void;
type StateListener = (state: "connecting" | "open" | "closed") => void;

/** One WebSocket per open project. Connects lazily, pings to keep proxies happy and
 *  reports closes so the UI can tell the user that the program was terminated. */
export class RunSocket {
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private ping: number | undefined;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  state: "connecting" | "open" | "closed" = "closed";

  constructor(private projectId: number) {}

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  onState(l: StateListener) {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }
  private setState(s: RunSocket["state"]) {
    this.state = s;
    this.stateListeners.forEach((l) => l(s));
  }

  ensureOpen(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    this.setState("connecting");
    this.opening = new Promise<void>((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/ws/projects/${this.projectId}`);
      this.ws = ws;
      let ready = false;
      const fail = (msg: string) => {
        this.opening = null;
        reject(new Error(msg));
      };
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: getToken() }));
      ws.onmessage = (m) => {
        let ev: ServerEvent;
        try {
          ev = JSON.parse(m.data);
        } catch {
          return;
        }
        if (ev.type === "ready" && !ready) {
          ready = true;
          this.opening = null;
          this.setState("open");
          window.clearInterval(this.ping);
          this.ping = window.setInterval(() => this.send({ type: "ping" }), 25000);
          resolve();
        }
        this.listeners.forEach((l) => l(ev));
      };
      ws.onerror = () => {
        if (!ready) fail("Cannot connect to the execution service.");
      };
      ws.onclose = (e) => {
        window.clearInterval(this.ping);
        const wasReady = ready;
        this.ws = null;
        this.setState("closed");
        if (!wasReady) fail(e.code === 4401 ? "Session expired - reload the page." : e.code === 4404 ? "Project not found." : "Cannot connect to the execution service.");
        else this.listeners.forEach((l) => l({ type: "error", code: "disconnected", message: "Connection to the server was lost. A running program was terminated." }));
      };
    });
    return this.opening;
  }

  send(msg: Record<string, unknown>): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  run(req: RunRequest) {
    return this.send({ type: "run", ...req });
  }
  shell(command: string) {
    return this.send({ type: "shell", command });
  }
  install(packages: string[]) {
    return this.send({ type: "install", packages });
  }
  stdin(data: string) {
    return this.send({ type: "stdin", data });
  }
  eof() {
    return this.send({ type: "eof" });
  }
  stop() {
    return this.send({ type: "stop" });
  }
  close() {
    window.clearInterval(this.ping);
    this.listeners.clear();
    this.stateListeners.clear();
    this.ws?.close();
    this.ws = null;
  }
}
