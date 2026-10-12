import { create } from "zustand";
import { lsGet, lsGetNum, lsSet } from "../lib/storage";

export type Theme = "dark" | "light";
export type SidebarTab = "files" | "packages" | "settings";
export type BottomTab = "output" | "errors" | "terminal" | "input" | "problems";
export type PanelPos = "bottom" | "right";
export type MobileView = "files" | "editor" | "console";

interface PromptReq {
  title: string;
  label?: string;
  initial?: string;
  confirmText?: string;
  resolve: (v: string | null) => void;
}
interface ConfirmReq {
  title: string;
  message: string;
  danger?: boolean;
  confirmText?: string;
  resolve: (v: boolean) => void;
}
export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "ok";
}

interface UIState {
  theme: Theme;
  sidebarWidth: number;
  bottomHeight: number;
  panelPos: PanelPos;
  rightWidth: number;
  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  mobileView: MobileView;
  fontSize: number;
  cursor: { line: number; col: number };
  modal: "projects" | "auth" | "shortcuts" | null;
  promptReq: PromptReq | null;
  confirmReq: ConfirmReq | null;
  toasts: Toast[];
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setSidebarWidth: (w: number) => void;
  setBottomHeight: (h: number) => void;
  setPanelPos: (p: PanelPos) => void;
  setRightWidth: (w: number) => void;
  setSidebarTab: (t: SidebarTab) => void;
  toggleSidebar: () => void;
  toggleBottom: () => void;
  setBottomTab: (t: BottomTab) => void;
  setMobileView: (v: MobileView) => void;
  setFontSize: (n: number) => void;
  setCursor: (line: number, col: number) => void;
  openModal: (m: UIState["modal"]) => void;
  prompt: (o: Omit<PromptReq, "resolve">) => Promise<string | null>;
  confirm: (o: Omit<ConfirmReq, "resolve">) => Promise<boolean>;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

const initialTheme = (): Theme => (lsGet("compieler.theme") === "light" ? "light" : "dark");
let toastId = 1;

export const useUI = create<UIState>((set, get) => ({
  theme: initialTheme(),
  sidebarWidth: lsGetNum("compieler.sidebarW", 250),
  bottomHeight: lsGetNum("compieler.bottomH", 280),
  panelPos: lsGet("compieler.panelPos") === "right" ? "right" : "bottom",
  rightWidth: lsGetNum("compieler.rightW", Math.round(window.innerWidth / 2)), // half of the screen by default
  sidebarTab: "files",
  sidebarOpen: true,
  bottomOpen: true,
  bottomTab: "output",
  mobileView: "editor",
  fontSize: lsGetNum("compieler.fontSize", 14),
  cursor: { line: 1, col: 1 },
  modal: null,
  promptReq: null,
  confirmReq: null,
  toasts: [],

  setTheme: (theme) => {
    lsSet("compieler.theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  setSidebarWidth: (w) => {
    const v = Math.max(160, Math.min(520, w));
    lsSet("compieler.sidebarW", String(v));
    set({ sidebarWidth: v });
  },
  setBottomHeight: (h) => {
    const v = Math.max(80, Math.min(window.innerHeight - 160, h));
    lsSet("compieler.bottomH", String(v));
    set({ bottomHeight: v });
  },
  setPanelPos: (panelPos) => {
    lsSet("compieler.panelPos", panelPos);
    set({ panelPos, bottomOpen: true });
  },
  setRightWidth: (w) => {
    const v = Math.max(260, Math.min(window.innerWidth - 360, w));
    lsSet("compieler.rightW", String(v));
    set({ rightWidth: v });
  },
  setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarOpen: true }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleBottom: () => set((s) => ({ bottomOpen: !s.bottomOpen })),
  setBottomTab: (bottomTab) => set({ bottomTab, bottomOpen: true }),
  setMobileView: (mobileView) => set({ mobileView }),
  setFontSize: (n) => {
    const v = Math.max(10, Math.min(28, n));
    lsSet("compieler.fontSize", String(v));
    set({ fontSize: v });
  },
  setCursor: (line, col) => set({ cursor: { line, col } }),
  openModal: (modal) => set({ modal }),
  prompt: (o) =>
    new Promise((resolve) => {
      get().promptReq?.resolve(null);
      set({ promptReq: { ...o, resolve: (v) => (set({ promptReq: null }), resolve(v)) } });
    }),
  confirm: (o) =>
    new Promise((resolve) => {
      get().confirmReq?.resolve(false);
      set({ confirmReq: { ...o, resolve: (v) => (set({ confirmReq: null }), resolve(v)) } });
    }),
  toast: (text, kind = "info") => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
    window.setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
