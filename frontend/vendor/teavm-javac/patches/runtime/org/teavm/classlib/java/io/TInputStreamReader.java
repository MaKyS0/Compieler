package org.teavm.classlib.java.io;

import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.io.UnsupportedEncodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;

/**
 * InputStreamReader for the Compieler app: decodes UTF-8 (and Latin-1 / ASCII) without NIO buffers,
 * which TeaVM's WebAssembly GC backend cannot compile. Reading System.in uses the app's stdin channel.
 */
public class TInputStreamReader extends Reader {
    private final InputStream stream;
    private final boolean latin1;
    private int pendingLow = -1;

    public TInputStreamReader(InputStream in, String charsetName) throws UnsupportedEncodingException {
        this(in, isLatin1(charsetName));
    }

    public TInputStreamReader(InputStream in, Charset charset) {
        this(in, isLatin1(charset.name()));
    }

    public TInputStreamReader(InputStream in, CharsetDecoder decoder) {
        this(in, isLatin1(decoder.charset().name()));
    }

    public TInputStreamReader(InputStream in) {
        this(in, false);
    }

    private TInputStreamReader(InputStream in, boolean latin1) {
        this.stream = in == System.in ? org.compieler.IO.STDIN : in;
        this.latin1 = latin1;
    }

    private static boolean isLatin1(String name) {
        String n = name.toUpperCase();
        return n.equals("ISO-8859-1") || n.equals("LATIN1") || n.equals("US-ASCII") || n.equals("ASCII");
    }

    public String getEncoding() {
        return latin1 ? "ISO8859_1" : "UTF8";
    }

    @Override
    public void close() throws IOException {
        stream.close();
    }

    @Override
    public int read() throws IOException {
        if (pendingLow >= 0) {
            int c = pendingLow;
            pendingLow = -1;
            return c;
        }
        int b = stream.read();
        if (b < 0 || latin1 || b < 0x80) {
            return b;
        }
        int extra = b >= 0xF0 ? 3 : b >= 0xE0 ? 2 : b >= 0xC0 ? 1 : 0;
        int cp = b & (0x3F >> extra);
        for (int i = 0; i < extra; i++) {
            int c = stream.read();
            if (c < 0) {
                break;
            }
            cp = (cp << 6) | (c & 0x3F);
        }
        if (cp >= 0x10000) {
            char[] pair = Character.toChars(cp);
            pendingLow = pair[1];
            return pair[0];
        }
        return cp;
    }

    @Override
    public int read(char[] cbuf, int off, int len) throws IOException {
        if (len == 0) {
            return 0;
        }
        int count = 0;
        while (count < len) {
            int c = read();
            if (c < 0) {
                return count == 0 ? -1 : count;
            }
            cbuf[off + count++] = (char) c;
            // hand over whole lines: interactive programs must not wait for more input than typed
            if (c == '\n' || (count > 0 && !ready())) {
                break;
            }
        }
        return count;
    }

    @Override
    public boolean ready() throws IOException {
        return pendingLow >= 0 || stream.available() > 0;
    }
}
