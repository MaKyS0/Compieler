// Small helpers for Java class files and teavm-javac's class archives (used by the Java worker).

/** teavm-javac archive: gzip of [u16 name length][name][u32 size][bytes] entries. */
export async function readArchive(gz: Uint8Array): Promise<[string, Uint8Array][]> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const b = new Uint8Array(await new Response(stream).arrayBuffer());
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dec = new TextDecoder();
  const out: [string, Uint8Array][] = [];
  for (let i = 0; i < b.length; ) {
    const n = view.getUint16(i);
    i += 2;
    const name = dec.decode(b.subarray(i, i + n));
    i += n;
    const len = view.getUint32(i);
    i += 4;
    out.push([name, b.slice(i, i + len)]);
    i += len;
  }
  return out;
}

export interface Redirect {
  /** Internal name of the class whose static method is called, e.g. java/lang/System. */
  owner: string;
  name: string;
  desc: string;
  /** Class that provides a static method with the same name and descriptor. */
  to: string;
}

/**
 * Points calls of static methods to another class (e.g. System.exit, which TeaVM lacks, to the app's own
 * implementation). Only the constant pool changes: two entries are appended and the matching method
 * references are re-pointed, so no bytecode offsets move. Returns null when the class has no such call.
 */
export function redirectStaticCalls(data: Uint8Array, redirects: Redirect[]): Uint8Array | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0) !== 0xcafebabe) return null;
  const count = view.getUint16(8);
  const dec = new TextDecoder();
  const utf8: (string | null)[] = new Array(count).fill(null);
  const classNameIdx: number[] = new Array(count).fill(0);
  const nameAndType: [number, number][] = new Array(count);
  const methodRefs: { at: number; classIdx: number; natIdx: number }[] = [];
  let i = 10;
  for (let k = 1; k < count; k++) {
    const tag = data[i++];
    switch (tag) {
      case 1: {
        const len = view.getUint16(i);
        utf8[k] = dec.decode(data.subarray(i + 2, i + 2 + len));
        i += 2 + len;
        break;
      }
      case 7:
        classNameIdx[k] = view.getUint16(i);
        i += 2;
        break;
      case 12:
        nameAndType[k] = [view.getUint16(i), view.getUint16(i + 2)];
        i += 4;
        break;
      case 10:
        methodRefs.push({ at: i, classIdx: view.getUint16(i), natIdx: view.getUint16(i + 2) });
        i += 4;
        break;
      case 3:
      case 4:
      case 9:
      case 11:
      case 17:
      case 18:
        i += 4;
        break;
      case 5:
      case 6:
        i += 8;
        k++;
        break;
      case 8:
      case 16:
      case 19:
      case 20:
        i += 2;
        break;
      case 15:
        i += 3;
        break;
      default:
        return null; // unknown tag: leave the class alone
    }
  }
  const poolEnd = i;
  const enc = new TextEncoder();
  const added: number[] = [];
  const targetClass = new Map<string, number>();
  let next = count;
  const patches: { at: number; classIdx: number }[] = [];
  for (const ref of methodRefs) {
    const owner = utf8[classNameIdx[ref.classIdx]];
    const nat = nameAndType[ref.natIdx];
    if (!owner || !nat) continue;
    const r = redirects.find((x) => x.owner === owner && x.name === utf8[nat[0]] && x.desc === utf8[nat[1]]);
    if (!r) continue;
    let idx = targetClass.get(r.to);
    if (idx === undefined) {
      const nameBytes = enc.encode(r.to);
      added.push(1, nameBytes.length >> 8, nameBytes.length & 0xff, ...nameBytes); // Utf8
      added.push(7, next >> 8, next & 0xff); // Class -> that Utf8
      idx = next + 1;
      next += 2;
      targetClass.set(r.to, idx);
    }
    patches.push({ at: ref.at, classIdx: idx });
  }
  if (!patches.length) return null;
  const outBytes = new Uint8Array(data.length + added.length);
  outBytes.set(data.subarray(0, poolEnd));
  outBytes.set(added, poolEnd);
  outBytes.set(data.subarray(poolEnd), poolEnd + added.length);
  const ov = new DataView(outBytes.buffer);
  ov.setUint16(8, next);
  for (const p of patches) ov.setUint16(p.at, p.classIdx);
  return outBytes;
}
