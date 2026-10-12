package com.compieler.app;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * stdin for programs running in the WebView's Workers.
 *
 * Where the page is not cross-origin isolated (no SharedArrayBuffer) a Worker cannot block on shared memory.
 * Instead it issues a synchronous XHR to {@code /__stdin/<generation>}; {@link IsolatedAssetsHandler} parks that
 * request here until the UI thread pushes a line through the JavaScript bridge, then answers it.
 */
final class StdinChannel {
    private final LinkedBlockingQueue<byte[]> queue = new LinkedBlockingQueue<>();
    private volatile int generation = 0;

    /** Starts a new program: drops pending input and releases any request waiting for the previous one. */
    synchronized int reset() {
        queue.clear();
        return ++generation;
    }

    void push(byte[] data) {
        if (data.length > 0) queue.offer(data);
    }

    void eof() {
        queue.offer(new byte[0]);
    }

    /** Blocks until input (or EOF = empty array) is available; returns null when {@code gen} is stale. */
    byte[] await(int gen) throws InterruptedException {
        while (true) {
            if (gen != generation) return null;
            byte[] data = queue.poll(300, TimeUnit.MILLISECONDS);
            if (data != null) return data;
        }
    }
}
