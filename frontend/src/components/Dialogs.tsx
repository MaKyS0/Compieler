import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUI } from "../store/ui";

export function Modal({ title, onClose, children, width = 460 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[80vh] w-full overflow-hidden rounded-md border border-line bg-panel shadow-2xl" style={{ maxWidth: width }}>
        <div className="flex h-9 items-center justify-between border-b border-line px-3">
          <span className="text-[12px] font-medium">{title}</span>
          <button className="btn !h-6 !px-1" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[calc(80vh-2.25rem)] overflow-auto">{children}</div>
      </div>
    </div>
  );
}

function PromptDialog() {
  const req = useUI((s) => s.promptReq);
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (req) {
      setValue(req.initial ?? "");
      setTimeout(() => {
        ref.current?.focus();
        const dot = (req.initial ?? "").lastIndexOf(".");
        ref.current?.setSelectionRange(0, dot > 0 ? dot : (req.initial ?? "").length);
      }, 30);
    }
  }, [req]);
  if (!req) return null;
  return (
    <Modal title={req.title} onClose={() => req.resolve(null)} width={380}>
      <form
        className="flex flex-col gap-3 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          req.resolve(value.trim() || null);
        }}
      >
        {req.label && <label className="text-[12px] text-dim">{req.label}</label>}
        <input ref={ref} className="field !h-8" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-solid" onClick={() => req.resolve(null)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-solid !border-accent/60 !bg-accent/20">
            {req.confirmText ?? "OK"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog() {
  const req = useUI((s) => s.confirmReq);
  if (!req) return null;
  return (
    <Modal title={req.title} onClose={() => req.resolve(false)} width={380}>
      <div className="flex flex-col gap-4 p-3">
        <p className="text-[12.5px] leading-relaxed">{req.message}</p>
        <div className="flex justify-end gap-2">
          <button className="btn btn-solid" onClick={() => req.resolve(false)}>
            Cancel
          </button>
          <button className={`btn ${req.danger ? "btn-stop" : "btn-solid"}`} onClick={() => req.resolve(true)} autoFocus>
            {req.confirmText ?? "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-12 right-3 z-[60] flex max-w-[min(420px,calc(100vw-1.5rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto flex items-start gap-2 rounded border border-line bg-raised px-3 py-2 text-[12px] shadow-lg" role="status">
          {t.kind === "error" ? <AlertCircle size={14} className="mt-px shrink-0 text-err" /> : t.kind === "ok" ? <CheckCircle2 size={14} className="mt-px shrink-0 text-ok" /> : <Info size={14} className="mt-px shrink-0 text-accent" />}
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-dim hover:text-fg">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Dialogs() {
  return (
    <>
      <PromptDialog />
      <ConfirmDialog />
      <Toasts />
    </>
  );
}
