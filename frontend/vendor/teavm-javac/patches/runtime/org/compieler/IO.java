package org.compieler;

import org.teavm.jso.JSBody;

/** Bridge between Java programs and the Compieler worker (stdin, exit status). */
public final class IO {
    private IO() {
    }

    /** Next byte of standard input, blocking until the user typed a line; -1 at end of input. */
    @JSBody(script = "return __compieler_stdin();")
    public static native int read();

    @JSBody(params = "code", script = "__compieler_exit(code);")
    public static native void exit(int code);

    public static final java.io.InputStream STDIN = new java.io.InputStream() {
        @Override
        public int read() {
            return IO.read();
        }
    };
}
