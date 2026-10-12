/** Save a Blob to the device: through the Android bridge inside the APK, an <a download> elsewhere. */
interface AndroidBridge {
  saveFile(name: string, mime: string, base64: string): void;
}
export async function saveBlob(blob: Blob, filename: string) {
  const bridge = (window as unknown as { AndroidBridge?: AndroidBridge }).AndroidBridge;
  if (bridge) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    bridge.saveFile(filename, blob.type || "application/octet-stream", btoa(bin));
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
