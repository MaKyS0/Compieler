import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

/**
 * The terminal is a singleton so scrollback survives tab switches. It speaks to the
 * sandboxed program over pipes (no TTY), so line editing is done here: characters are
 * echoed locally and whole lines are sent on Enter.
 */
const DARK = {
  background: "#1e1f23", foreground: "#d6d9de", cursor: "#60a5fa", selectionBackground: "#3b4a63",
  black: "#1e1f23", red: "#ee6363", green: "#4abe78", yellow: "#dda940", blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#d6d9de",
  brightBlack: "#6b7280", brightRed: "#f87171", brightGreen: "#6ee7a0", brightYellow: "#facc15", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#ffffff",
};
const LIGHT = {
  background: "#f4f5f7", foreground: "#202329", cursor: "#1c64dc", selectionBackground: "#bcd2f5",
  black: "#202329", red: "#c82828", green: "#168246", yellow: "#aa6e00", blue: "#1c64dc", magenta: "#8b3fd0", cyan: "#0e7490", white: "#6b7280",
  brightBlack: "#6b7280", brightRed: "#dc2626", brightGreen: "#15803d", brightYellow: "#a16207", brightBlue: "#2563eb", brightMagenta: "#9333ea", brightCyan: "#0891b2", brightWhite: "#111827",
};

export const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export interface TerminalHandlers {
  /** Called with a complete line (without newline) typed by the user. */
  onLine: (line: string) => void;
  onEof: () => void;
  onInterrupt: () => void;
  /** True while a program is running - decides between "stdin" and "shell prompt" behaviour. */
  isRunning: () => boolean;
  onHistory: (dir: -1 | 1) => string | null;
}

class TerminalHost {
  readonly el = document.createElement("div");
  private term: Terminal;
  private fit = new FitAddon();
  private line = "";
  private handlers: TerminalHandlers | null = null;
  private opened = false;
  private ro: ResizeObserver | null = null;

  constructor() {
    this.el.style.height = "100%";
    this.term = new Terminal({
      convertEol: true,
      fontFamily: '"JetBrains Mono","Cascadia Code",ui-monospace,Menlo,Consolas,monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 20000,
      allowProposedApi: true,
      theme: DARK,
    });
    this.term.loadAddon(this.fit);
    this.term.onData((d) => this.input(d));
  }

  setHandlers(h: TerminalHandlers) {
    this.handlers = h;
  }

  setTheme(theme: "dark" | "light") {
    this.term.options.theme = theme === "dark" ? DARK : LIGHT;
  }

  setFontSize(n: number) {
    this.term.options.fontSize = Math.max(11, n - 1);
    this.refit();
  }

  attach(container: HTMLElement) {
    container.appendChild(this.el);
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
    }
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(container);
    this.refit();
  }

  detach() {
    this.ro?.disconnect();
    this.ro = null;
  }

  refit() {
    if (!this.opened || !this.el.isConnected || this.el.clientWidth === 0) return;
    try {
      this.fit.fit();
    } catch {
      /* hidden */
    }
  }

  focus() {
    this.term.focus();
  }

  write(text: string, color?: string) {
    this.term.write(color ? `${color}${text}${C.reset}` : text);
  }
  writeln(text = "", color?: string) {
    this.write(text + "\n", color);
  }
  clear() {
    this.term.reset();
    this.line = "";
  }

  /** Show the shell prompt on a fresh line. */
  prompt() {
    this.line = "";
    this.term.write(`${C.green}$ ${C.reset}`);
  }

  private input(data: string) {
    const h = this.handlers;
    if (!h) return;
    // Escape sequences: history on arrows (idle only), ignore the rest.
    if (data.startsWith("\x1b")) {
      if (!h.isRunning() && (data === "\x1b[A" || data === "\x1b[B")) {
        const entry = h.onHistory(data === "\x1b[A" ? -1 : 1);
        if (entry !== null) this.replaceLine(entry);
      }
      return;
    }
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const line = this.line;
        this.line = "";
        this.term.write("\r\n");
        h.onLine(line);
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line.length) {
          this.line = this.line.slice(0, -1);
          this.term.write("\b \b");
        }
      } else if (ch === "\x03") {
        this.term.write("^C\r\n");
        this.line = "";
        h.onInterrupt();
      } else if (ch === "\x04") {
        if (!this.line && h.isRunning()) {
          this.term.write(`${C.dim}^D${C.reset}\r\n`);
          h.onEof();
        }
      } else if (ch === "\x15") {
        this.replaceLine("");
      } else if (ch >= " ") {
        this.line += ch;
        this.term.write(ch);
      }
    }
  }

  private replaceLine(text: string) {
    this.term.write("\b \b".repeat(this.line.length));
    this.line = text;
    this.term.write(text);
  }

  /** Send arbitrary text as if typed (mobile symbol keyboard). */
  type(text: string) {
    this.input(text);
  }
}

export const terminal = new TerminalHost();
