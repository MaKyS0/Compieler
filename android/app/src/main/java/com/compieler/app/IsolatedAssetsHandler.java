package com.compieler.app;

import android.content.Context;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Serves the bundled web app from assets/www and marks every response cross-origin isolated
 * (COOP/COEP). That makes SharedArrayBuffer available, which the on-device engines need to block on
 * stdin (Python's input(), C++'s cin) while the Worker keeps its own call stack.
 */
final class IsolatedAssetsHandler implements WebViewAssetLoader.PathHandler {
    private final Context context;
    private final StdinChannel stdin;

    IsolatedAssetsHandler(Context context, StdinChannel stdin) {
        this.context = context.getApplicationContext();
        this.stdin = stdin;
    }

    @Nullable
    @Override
    public WebResourceResponse handle(@NonNull String path) {
        if (path.isEmpty() || path.endsWith("/")) path = path + "index.html";
        if (path.contains("..")) return null;
        if (path.startsWith("__stdin/")) return handleStdin(path.substring("__stdin/".length()));
        try {
            InputStream stream = context.getAssets().open("www/" + path);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cross-Origin-Opener-Policy", "same-origin");
            headers.put("Cross-Origin-Embedder-Policy", "require-corp");
            headers.put("Cross-Origin-Resource-Policy", "same-origin");
            headers.put("Cache-Control", "no-cache");
            headers.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse(mimeOf(path), mimeOf(path).startsWith("text/") || mimeOf(path).contains("javascript") || mimeOf(path).contains("json") ? "utf-8" : null, 200, "OK", headers, stream);
        } catch (IOException e) {
            return null;
        }
    }

    /** Answers a Worker's blocking read of stdin (see StdinChannel). */
    private WebResourceResponse handleStdin(String genText) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        byte[] data;
        try {
            data = stdin.await(Integer.parseInt(genText));
        } catch (NumberFormatException | InterruptedException e) {
            data = null;
        }
        if (data == null || data.length == 0) headers.put("X-Stdin-Eof", "1");
        return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers,
                new java.io.ByteArrayInputStream(data == null ? new byte[0] : data));
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".zip") || p.endsWith(".whl")) return "application/zip";
        return "application/octet-stream";
    }
}
