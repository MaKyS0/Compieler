/** Standalone = no backend: projects live in IndexedDB and code runs in WebAssembly engines on the device. */
export const STANDALONE = import.meta.env.VITE_STANDALONE === "1";

/** Absolute URL of the engines folder (served next to the app). */
export function engineBase(): string {
  return new URL("engines/", document.baseURI).href;
}
