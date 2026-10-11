import type * as Monaco from "monaco-editor";

/** Tiny bridge so non-editor components (problems list, toolbar, mobile keys) can drive Monaco. */
type Editor = Monaco.editor.IStandaloneCodeEditor;
let editor: Editor | null = null;
let monacoRef: typeof Monaco | null = null;

export const editorBus = {
  set(e: Editor | null, m: typeof Monaco | null) {
    editor = e;
    monacoRef = m;
  },
  get editor() {
    return editor;
  },
  get monaco() {
    return monacoRef;
  },
  focus() {
    editor?.focus();
  },
  reveal(line: number, col = 1) {
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: col });
    editor.focus();
  },
  insert(text: string) {
    if (!editor) return;
    editor.focus();
    editor.trigger("keyboard", "type", { text });
  },
  key(command: "tab" | "left" | "right" | "up" | "down" | "undo" | "redo" | "home" | "end") {
    if (!editor) return;
    editor.focus();
    const map: Record<string, string> = {
      tab: "tab",
      left: "cursorLeft",
      right: "cursorRight",
      up: "cursorUp",
      down: "cursorDown",
      undo: "undo",
      redo: "redo",
      home: "cursorHome",
      end: "cursorEnd",
    };
    editor.trigger("keyboard", map[command], null);
  },
  /** Replace the whole document as a single undoable edit (used by Format). */
  replaceAll(text: string) {
    if (!editor) return false;
    const model = editor.getModel();
    if (!model) return false;
    editor.pushUndoStop();
    editor.executeEdits("format", [{ range: model.getFullModelRange(), text }]);
    editor.pushUndoStop();
    return true;
  },
  find() {
    editor?.getAction("actions.find")?.run();
  },
  replace() {
    editor?.getAction("editor.action.startFindReplace")?.run();
  },
};
