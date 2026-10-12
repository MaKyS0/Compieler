import { useEffect, useState } from "react";
import { localApi } from "../api/local";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp" };
export const imageMime = (path: string) => MIME[path.split(".").pop()?.toLowerCase() ?? ""];

/** Shows images a program wrote (e.g. matplotlib's savefig) from the on-device project storage. */
export function ImagePreview({ projectId, path }: { projectId: number; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = "";
    let alive = true;
    void localApi.readBytes(projectId, path).then((b) => {
      if (!alive || !b) return;
      revoked = URL.createObjectURL(new Blob([b as BlobPart], { type: imageMime(path) }));
      setUrl(revoked);
    });
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [projectId, path]);
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(rgb(var(--raised))_0%_25%,rgb(var(--panel))_0%_50%)] bg-[length:16px_16px] p-4">
      {url ? <img src={url} alt={path} className="max-h-full max-w-full object-contain" /> : null}
    </div>
  );
}
