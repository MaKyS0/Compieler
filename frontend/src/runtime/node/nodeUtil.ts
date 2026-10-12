/* eslint-disable @typescript-eslint/no-explicit-any */
// `util` with Node's real inspect/format (the old npm `util` port prints Map/Set/class instances wrongly).
import { format, formatWithOptions, inspect } from "node-inspect-extracted";
import * as utilPkg from "util";

const base: any = { ...(utilPkg as any) };
base.inspect = inspect;
base.format = format;
base.formatWithOptions = formatWithOptions;
base.stripVTControlCharacters = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // eslint-disable-line no-control-regex
base.isDeepStrictEqual = (a: unknown, b: unknown) => inspect(a, { depth: null, sorted: true }) === inspect(b, { depth: null, sorted: true });
base.TextEncoder = TextEncoder;
base.TextDecoder = TextDecoder;
export const util = base;
export { format, inspect };
