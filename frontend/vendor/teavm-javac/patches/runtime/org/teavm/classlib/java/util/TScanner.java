package org.teavm.classlib.java.util;

import java.util.Iterator;
import java.util.NoSuchElementException;

import java.io.IOException;
import java.io.InputStream;

/**
 * java.util.Scanner for the Compieler app (TeaVM has none): tokens separated by whitespace, lines,
 * numbers and booleans, read from an InputStream (System.in) or a String. UTF-8 input.
 */
public final class TScanner implements java.io.Closeable, Iterator<String> {
    private final InputStream in;
    private final String text;
    private int textPos;
    private final StringBuilder buf = new StringBuilder();
    private int pos;
    private boolean eof;
    private boolean closed;

    public TScanner(InputStream source) {
        // System.in cannot be read in TeaVM's WebAssembly runtime: read the app's stdin channel instead
        this.in = source == System.in ? org.compieler.IO.STDIN : source;
        this.text = null;
    }

    public TScanner(InputStream source, String charsetName) {
        this(source);
    }

    public TScanner(String source) {
        this.in = null;
        this.text = source;
    }

    // ------------------------------------------------------------------ input
    private int readCodePoint() {
        if (text != null) {
            if (textPos >= text.length()) {
                return -1;
            }
            int cp = text.codePointAt(textPos);
            textPos += Character.charCount(cp);
            return cp;
        }
        try {
            int b = in.read();
            if (b < 0) {
                return -1;
            }
            if (b < 0x80) {
                return b;
            }
            int extra = b >= 0xF0 ? 3 : b >= 0xE0 ? 2 : b >= 0xC0 ? 1 : 0;
            int cp = b & (0x3F >> extra);
            for (int i = 0; i < extra; i++) {
                int c = in.read();
                if (c < 0) {
                    break;
                }
                cp = (cp << 6) | (c & 0x3F);
            }
            return cp;
        } catch (IOException e) {
            return -1;
        }
    }

    /** Makes sure at least one more char is buffered; false at end of input. */
    private boolean fill() {
        if (eof) {
            return false;
        }
        int cp = readCodePoint();
        if (cp < 0) {
            eof = true;
            return false;
        }
        buf.appendCodePoint(cp);
        return true;
    }

    private void compact() {
        if (pos > 4096) {
            buf.delete(0, pos);
            pos = 0;
        }
    }

    private void ensureOpen() {
        if (closed) {
            throw new IllegalStateException("Scanner closed");
        }
    }

    // ------------------------------------------------------------------ tokens
    /** Returns the next token without consuming it, or null at end of input. */
    private String peekToken() {
        ensureOpen();
        int i = pos;
        while (true) {
            if (i >= buf.length() && !fill()) {
                return null;
            }
            if (!Character.isWhitespace(buf.charAt(i))) {
                break;
            }
            i++;
        }
        int start = i;
        while (true) {
            if (i >= buf.length() && !fill()) {
                break;
            }
            if (Character.isWhitespace(buf.charAt(i))) {
                break;
            }
            i++;
        }
        return buf.substring(start, i);
    }

    private String takeToken() {
        String token = peekToken();
        if (token == null) {
            throw new NoSuchElementException();
        }
        int i = pos;
        while (Character.isWhitespace(buf.charAt(i))) {
            i++;
        }
        pos = i + token.length();
        compact();
        return token;
    }

    @Override
    public boolean hasNext() {
        return peekToken() != null;
    }

    @Override
    public String next() {
        return takeToken();
    }

    public boolean hasNextLine() {
        ensureOpen();
        return pos < buf.length() || fill();
    }

    public String nextLine() {
        ensureOpen();
        int i = pos;
        while (true) {
            if (i >= buf.length() && !fill()) {
                if (i == pos) {
                    throw new NoSuchElementException("No line found");
                }
                String line = buf.substring(pos, i);
                pos = i;
                compact();
                return line;
            }
            char c = buf.charAt(i);
            if (c == '\n') {
                String line = buf.substring(pos, i);
                pos = i + 1;
                compact();
                return line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
            }
            i++;
        }
    }

    // ------------------------------------------------------------------ numbers
    private static String clean(String token) {
        return token.startsWith("+") ? token.substring(1) : token;
    }

    public boolean hasNextInt() {
        String t = peekToken();
        if (t == null) {
            return false;
        }
        try {
            Integer.parseInt(clean(t));
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public int nextInt() {
        String t = peekToken();
        if (t == null) {
            throw new NoSuchElementException();
        }
        int value;
        try {
            value = Integer.parseInt(clean(t));
        } catch (NumberFormatException e) {
            throw new TInputMismatchException("For input string: \"" + t + "\"");
        }
        takeToken();
        return value;
    }

    public int nextInt(int radix) {
        String t = takeToken();
        try {
            return Integer.parseInt(clean(t), radix);
        } catch (NumberFormatException e) {
            throw new TInputMismatchException("For input string: \"" + t + "\"");
        }
    }

    public boolean hasNextLong() {
        String t = peekToken();
        if (t == null) {
            return false;
        }
        try {
            Long.parseLong(clean(t));
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public long nextLong() {
        String t = peekToken();
        if (t == null) {
            throw new NoSuchElementException();
        }
        long value;
        try {
            value = Long.parseLong(clean(t));
        } catch (NumberFormatException e) {
            throw new TInputMismatchException("For input string: \"" + t + "\"");
        }
        takeToken();
        return value;
    }

    public short nextShort() {
        return (short) nextInt();
    }

    public byte nextByte() {
        return (byte) nextInt();
    }

    public boolean hasNextDouble() {
        String t = peekToken();
        if (t == null) {
            return false;
        }
        try {
            Double.parseDouble(t.replace(',', '.'));
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public double nextDouble() {
        String t = peekToken();
        if (t == null) {
            throw new NoSuchElementException();
        }
        double value;
        try {
            value = Double.parseDouble(t.replace(',', '.'));
        } catch (NumberFormatException e) {
            throw new TInputMismatchException("For input string: \"" + t + "\"");
        }
        takeToken();
        return value;
    }

    public float nextFloat() {
        return (float) nextDouble();
    }

    public boolean hasNextBoolean() {
        String t = peekToken();
        return t != null && (t.equalsIgnoreCase("true") || t.equalsIgnoreCase("false"));
    }

    public boolean nextBoolean() {
        String t = peekToken();
        if (t == null) {
            throw new NoSuchElementException();
        }
        if (!t.equalsIgnoreCase("true") && !t.equalsIgnoreCase("false")) {
            throw new TInputMismatchException("For input string: \"" + t + "\"");
        }
        takeToken();
        return t.equalsIgnoreCase("true");
    }

    public java.math.BigInteger nextBigInteger() {
        String t = takeToken();
        return new java.math.BigInteger(clean(t));
    }

    public java.math.BigDecimal nextBigDecimal() {
        String t = takeToken();
        return new java.math.BigDecimal(t.replace(',', '.'));
    }

    @Override
    public void close() {
        closed = true;
    }

    @Override
    public String toString() {
        return "java.util.Scanner";
    }
}
