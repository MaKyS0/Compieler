// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "").replace(/\r(?!\n)/g, "\n");
