import { useRef } from "react";

interface Props {
  direction: "col" | "row"; // col: vertical bar resizing widths; row: horizontal bar resizing heights
  onDrag: (delta: number) => void;
  onEnd?: () => void;
}

/** Thin draggable divider using pointer events (mouse, touch and pen). */
export function Splitter({ direction, onDrag, onEnd }: Props) {
  const last = useRef(0);
  const vertical = direction === "col";
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      tabIndex={0}
      className={`group relative shrink-0 bg-line ${vertical ? "w-px cursor-col-resize" : "h-px cursor-row-resize"}`}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        last.current = vertical ? e.clientX : e.clientY;
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => {
        if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
        const pos = vertical ? e.clientX : e.clientY;
        const d = pos - last.current;
        last.current = pos;
        if (d) onDrag(d);
      }}
      onPointerUp={(e) => {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        document.body.style.userSelect = "";
        onEnd?.();
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (vertical && (e.key === "ArrowLeft" || e.key === "ArrowRight")) onDrag(e.key === "ArrowLeft" ? -step : step);
        if (!vertical && (e.key === "ArrowUp" || e.key === "ArrowDown")) onDrag(e.key === "ArrowUp" ? -step : step);
      }}
    >
      <div
        className={`absolute z-20 transition-colors group-hover:bg-accent/60 group-active:bg-accent ${
          vertical ? "-left-1 top-0 h-full w-2" : "-top-1 left-0 h-2 w-full"
        }`}
      />
    </div>
  );
}
