/** localStorage that never throws (private mode, blocked storage, quota). */
export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
export function lsGetNum(key: string, fallback: number): number {
  const v = Number(lsGet(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
