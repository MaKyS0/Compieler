/* Adds the cross-origin isolation headers (COOP/COEP) that SharedArrayBuffer needs, for hosts that cannot
 * send them (e.g. GitHub Pages). Inside the Android app the WebView layer sets them directly.
 * Minimal re-implementation of the well-known "coi-serviceworker" technique. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const r = event.request;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  event.respondWith(
    fetch(r)
      .then((res) => {
        if (res.status === 0) return res;
        const headers = new Headers(res.headers);
        headers.set("Cross-Origin-Embedder-Policy", "credentialless");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      })
      .catch((e) => console.error(e)),
  );
});
