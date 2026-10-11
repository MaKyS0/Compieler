import { ArrowLeft, ArrowRight, Redo2, Undo2 } from "lucide-react";
import { editorBus } from "../lib/editorBus";

const SYMBOLS = ["{", "}", "(", ")", "[", "]", "<", ">", ";", ":", '"', "'", "=", "+", "-", "*", "/", "\\", "_", "&", "|", "!", "#", "%", "$", ",", ".", "?", "~", "^", "@", "`"];

/** Programming-symbol row for phones, whose soft keyboards hide most of these characters. */
export function SymbolBar() {
  // pointerdown + preventDefault keeps the editor focused so the soft keyboard stays open
  const keep = (e: React.PointerEvent) => e.preventDefault();
  const cls = "flex h-9 min-w-[34px] shrink-0 items-center justify-center rounded border border-line bg-raised px-2 font-mono text-[15px] active:bg-accent/30";
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-line bg-panel px-1.5 py-1" role="toolbar" aria-label="Programming symbols">
      <button className={cls} onPointerDown={keep} onClick={() => editorBus.key("tab")} aria-label="Tab">
        Tab
      </button>
      <button className={cls} onPointerDown={keep} onClick={() => editorBus.key("left")} aria-label="Cursor left">
        <ArrowLeft size={15} />
      </button>
      <button className={cls} onPointerDown={keep} onClick={() => editorBus.key("right")} aria-label="Cursor right">
        <ArrowRight size={15} />
      </button>
      <button className={cls} onPointerDown={keep} onClick={() => editorBus.key("undo")} aria-label="Undo">
        <Undo2 size={15} />
      </button>
      <button className={cls} onPointerDown={keep} onClick={() => editorBus.key("redo")} aria-label="Redo">
        <Redo2 size={15} />
      </button>
      {SYMBOLS.map((s) => (
        <button key={s} className={cls} onPointerDown={keep} onClick={() => editorBus.insert(s)} aria-label={`Insert ${s}`}>
          {s}
        </button>
      ))}
    </div>
  );
}
