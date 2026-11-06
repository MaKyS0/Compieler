package org.teavm.classlib.java.util;

import java.io.Closeable;
import java.io.Flushable;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.UnsupportedEncodingException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.Calendar;
import java.util.Date;
import java.util.DuplicateFormatFlagsException;
import java.util.Locale;
import java.util.MissingFormatArgumentException;
import java.util.UnknownFormatConversionException;

/**
 * java.util.Formatter for the Compieler app. Replaces TeaVM's version, whose floating point
 * conversions crash in the WebAssembly GC runtime. Supports %b %h %s %c %d %o %x %e %f %g %a(%e) %% %n
 * with argument indexes, flags (-#+ 0,( ), width and precision. Numbers use '.' as decimal separator.
 */
public final class TFormatter implements Closeable, Flushable {
    private Locale locale;
    private Appendable out;
    private IOException ioException;
    private boolean closed;

    public TFormatter() {
        this(new StringBuilder(), Locale.getDefault());
    }

    public TFormatter(Appendable a) {
        this(a, Locale.getDefault());
    }

    public TFormatter(Locale l) {
        this(new StringBuilder(), l);
    }

    public TFormatter(Appendable a, Locale l) {
        this.out = a != null ? a : new StringBuilder();
        this.locale = l;
    }

    public TFormatter(PrintStream ps) {
        this((Appendable) ps, Locale.getDefault());
    }

    public TFormatter(OutputStream os) {
        this((Appendable) new PrintStream(os), Locale.getDefault());
    }

    public TFormatter(OutputStream os, String csn) throws UnsupportedEncodingException {
        this(os);
    }

    public TFormatter(OutputStream os, String csn, Locale l) throws UnsupportedEncodingException {
        this((Appendable) new PrintStream(os), l);
    }

    public Locale locale() {
        requireOpen();
        return locale;
    }

    public Appendable out() {
        requireOpen();
        return out;
    }

    private void requireOpen() {
        if (closed) {
            throw new java.util.FormatterClosedException();
        }
    }

    @Override
    public String toString() {
        requireOpen();
        return out.toString();
    }

    @Override
    public void flush() {
        requireOpen();
        if (out instanceof Flushable) {
            try {
                ((Flushable) out).flush();
            } catch (IOException e) {
                ioException = e;
            }
        }
    }

    @Override
    public void close() {
        if (!closed) {
            closed = true;
            if (out instanceof Closeable) {
                try {
                    ((Closeable) out).close();
                } catch (IOException e) {
                    ioException = e;
                }
            }
        }
    }

    public IOException ioException() {
        return ioException;
    }

    public TFormatter format(String format, Object... args) {
        return format(locale, format, args);
    }

    public TFormatter format(Locale l, String format, Object... args) {
        requireOpen();
        try {
            out.append(render(format, args));
        } catch (IOException e) {
            ioException = e;
        }
        return this;
    }

    // ------------------------------------------------------------------ rendering
    private static String render(String format, Object[] args) {
        if (args == null) {
            args = new Object[] {null};
        }
        StringBuilder sb = new StringBuilder();
        int ordinary = 0;
        int last = -1;
        int i = 0;
        int n = format.length();
        while (i < n) {
            char c = format.charAt(i);
            if (c != '%') {
                sb.append(c);
                i++;
                continue;
            }
            int start = i;
            i++;
            if (i >= n) {
                throw new UnknownFormatConversionException("%");
            }
            // argument index
            int argIndex = -1;
            int j = i;
            while (j < n && Character.isDigit(format.charAt(j))) {
                j++;
            }
            if (j < n && j > i && format.charAt(j) == '$') {
                argIndex = Integer.parseInt(format.substring(i, j)) - 1;
                i = j + 1;
            } else if (i < n && format.charAt(i) == '<') {
                argIndex = -2;
                i++;
            }
            // flags
            String flags = "";
            while (i < n && "-#+ 0,(".indexOf(format.charAt(i)) >= 0) {
                char f = format.charAt(i);
                if (flags.indexOf(f) >= 0) {
                    throw new DuplicateFormatFlagsException(String.valueOf(f));
                }
                flags += f;
                i++;
            }
            int width = -1;
            j = i;
            while (j < n && Character.isDigit(format.charAt(j))) {
                j++;
            }
            if (j > i) {
                width = Integer.parseInt(format.substring(i, j));
                i = j;
            }
            int precision = -1;
            if (i < n && format.charAt(i) == '.') {
                i++;
                j = i;
                while (j < n && Character.isDigit(format.charAt(j))) {
                    j++;
                }
                if (j == i) {
                    throw new UnknownFormatConversionException(format.substring(start, Math.min(n, i + 1)));
                }
                precision = Integer.parseInt(format.substring(i, j));
                i = j;
            }
            if (i >= n) {
                throw new UnknownFormatConversionException(format.substring(start));
            }
            char conv = format.charAt(i);
            i++;
            if (conv == 't' || conv == 'T') {
                if (i >= n) {
                    throw new UnknownFormatConversionException(format.substring(start));
                }
                char sub = format.charAt(i);
                i++;
                Object arg = pick(args, argIndex, ordinary, last);
                if (argIndex == -1) {
                    ordinary++;
                }
                last = argIndex >= 0 ? argIndex : argIndex == -2 ? last : ordinary - 1;
                String s = formatTime(arg, sub);
                sb.append(pad(conv == 'T' ? s.toUpperCase() : s, flags, width));
                continue;
            }
            if (conv == 'n') {
                sb.append('\n');
                continue;
            }
            if (conv == '%') {
                sb.append(pad("%", flags, width));
                continue;
            }
            Object arg = pick(args, argIndex, ordinary, last);
            if (argIndex == -1) {
                last = ordinary;
                ordinary++;
            } else if (argIndex >= 0) {
                last = argIndex;
            }
            boolean upper = Character.isUpperCase(conv);
            String s;
            switch (Character.toLowerCase(conv)) {
                case 'b':
                    s = String.valueOf(arg == null ? false : arg instanceof Boolean ? (Boolean) arg : true);
                    if (precision >= 0 && precision < s.length()) {
                        s = s.substring(0, precision);
                    }
                    break;
                case 'h':
                    s = arg == null ? "null" : Integer.toHexString(arg.hashCode());
                    break;
                case 's':
                    s = String.valueOf(arg);
                    if (precision >= 0 && precision < s.length()) {
                        s = s.substring(0, precision);
                    }
                    break;
                case 'c':
                    if (arg == null) {
                        s = "null";
                    } else if (arg instanceof Character) {
                        s = String.valueOf((char) (Character) arg);
                    } else if (arg instanceof Number) {
                        s = new String(Character.toChars(((Number) arg).intValue()));
                    } else {
                        throw new java.util.IllegalFormatConversionException(conv, arg.getClass());
                    }
                    break;
                case 'd':
                    s = arg == null ? "null" : integer(arg, flags, conv);
                    break;
                case 'o':
                    s = arg == null ? "null" : radix(arg, 8, flags.indexOf('#') >= 0 ? "0" : "", conv);
                    break;
                case 'x':
                    s = arg == null ? "null" : radix(arg, 16, flags.indexOf('#') >= 0 ? "0x" : "", conv);
                    break;
                case 'f':
                case 'e':
                case 'g':
                case 'a':
                    s = arg == null ? "null" : floating(arg, flags, precision, Character.toLowerCase(conv), conv);
                    break;
                default:
                    throw new UnknownFormatConversionException(String.valueOf(conv));
            }
            if (upper) {
                s = s.toUpperCase();
            }
            if (flags.indexOf('0') >= 0 && width > s.length() && isNumeric(conv) && arg != null) {
                s = zeroPad(s, width);
            }
            sb.append(pad(s, flags, width));
        }
        return sb.toString();
    }

    private static boolean isNumeric(char conv) {
        return "dDoxXeEfgGaA".indexOf(conv) >= 0;
    }

    private static Object pick(Object[] args, int index, int ordinary, int last) {
        int k = index >= 0 ? index : index == -2 ? last : ordinary;
        if (k < 0 || k >= args.length) {
            throw new MissingFormatArgumentException("%" + (k + 1) + "$");
        }
        return args[k];
    }

    private static String pad(String s, String flags, int width) {
        if (width <= s.length()) {
            return s;
        }
        StringBuilder sb = new StringBuilder();
        boolean left = flags.indexOf('-') >= 0;
        if (left) {
            sb.append(s);
        }
        for (int k = s.length(); k < width; k++) {
            sb.append(' ');
        }
        if (!left) {
            sb.append(s);
        }
        return sb.toString();
    }

    private static String zeroPad(String s, int width) {
        int signEnd = 0;
        while (signEnd < s.length() && "+- (".indexOf(s.charAt(signEnd)) >= 0) {
            signEnd++;
        }
        if (s.startsWith("0x", signEnd) || s.startsWith("0X", signEnd)) {
            signEnd += 2;
        }
        StringBuilder sb = new StringBuilder(s.substring(0, signEnd));
        for (int k = s.length(); k < width; k++) {
            sb.append('0');
        }
        sb.append(s.substring(signEnd));
        return sb.toString();
    }

    private static String sign(boolean negative, String body, String flags) {
        if (negative) {
            return flags.indexOf('(') >= 0 ? "(" + body + ")" : "-" + body;
        }
        if (flags.indexOf('+') >= 0) {
            return "+" + body;
        }
        if (flags.indexOf(' ') >= 0) {
            return " " + body;
        }
        return body;
    }

    private static String group(String digits) {
        StringBuilder sb = new StringBuilder();
        int len = digits.length();
        for (int k = 0; k < len; k++) {
            if (k > 0 && (len - k) % 3 == 0) {
                sb.append(',');
            }
            sb.append(digits.charAt(k));
        }
        return sb.toString();
    }

    private static String integer(Object arg, String flags, char conv) {
        BigInteger v;
        if (arg instanceof Byte || arg instanceof Short || arg instanceof Integer || arg instanceof Long) {
            v = BigInteger.valueOf(((Number) arg).longValue());
        } else if (arg instanceof BigInteger) {
            v = (BigInteger) arg;
        } else {
            throw new java.util.IllegalFormatConversionException(conv, arg.getClass());
        }
        String digits = v.abs().toString();
        if (flags.indexOf(',') >= 0) {
            digits = group(digits);
        }
        return sign(v.signum() < 0, digits, flags);
    }

    private static String radix(Object arg, int radix, String prefix, char conv) {
        String s;
        if (arg instanceof Byte) {
            s = Integer.toString(((Byte) arg) & 0xFF, radix);
        } else if (arg instanceof Short) {
            s = Integer.toString(((Short) arg) & 0xFFFF, radix);
        } else if (arg instanceof Integer) {
            s = radix == 16 ? Integer.toHexString((Integer) arg) : Integer.toOctalString((Integer) arg);
        } else if (arg instanceof Long) {
            s = radix == 16 ? Long.toHexString((Long) arg) : Long.toOctalString((Long) arg);
        } else if (arg instanceof BigInteger) {
            BigInteger b = (BigInteger) arg;
            return (b.signum() < 0 ? "-" : "") + prefix + b.abs().toString(radix);
        } else {
            throw new java.util.IllegalFormatConversionException(conv, arg.getClass());
        }
        return prefix + s;
    }

    private static String floating(Object arg, String flags, int precision, char kind, char conv) {
        BigDecimal value;
        if (arg instanceof Double || arg instanceof Float) {
            double d = ((Number) arg).doubleValue();
            if (Double.isNaN(d)) {
                return "NaN";
            }
            if (Double.isInfinite(d)) {
                return sign(d < 0, "Infinity", flags);
            }
            value = arg instanceof Float ? new BigDecimal(Float.toString((Float) arg)) : new BigDecimal(Double.toString(d));
            if (d == 0 && 1 / d < 0) {
                return sign(true, fixed(BigDecimal.ZERO, precision < 0 ? 6 : precision, flags), flags);
            }
        } else if (arg instanceof BigDecimal) {
            value = (BigDecimal) arg;
        } else {
            throw new java.util.IllegalFormatConversionException(conv, arg.getClass());
        }
        boolean negative = value.signum() < 0;
        BigDecimal abs = value.abs();
        String body;
        if (kind == 'f') {
            body = fixed(abs, precision < 0 ? 6 : precision, flags);
        } else if (kind == 'e' || kind == 'a') {
            body = scientific(abs, precision < 0 ? 6 : precision, flags);
        } else {
            int p = precision < 0 ? 6 : precision == 0 ? 1 : precision;
            if (abs.signum() == 0) {
                body = fixed(abs, p - 1, flags);
            } else {
                BigDecimal rounded = abs.round(new MathContext(p, RoundingMode.HALF_UP));
                if (rounded.compareTo(new BigDecimal("0.0001")) >= 0 && rounded.compareTo(BigDecimal.TEN.pow(p)) < 0) {
                    int exponent = rounded.precision() - rounded.scale() - 1;
                    body = fixed(abs, Math.max(0, p - 1 - exponent), flags);
                } else {
                    body = scientific(abs, p - 1, flags);
                }
            }
        }
        return sign(negative, body, flags);
    }

    private static String fixed(BigDecimal abs, int precision, String flags) {
        String s = abs.setScale(precision, RoundingMode.HALF_UP).toPlainString();
        if (flags.indexOf(',') >= 0) {
            int dot = s.indexOf('.');
            String intPart = dot < 0 ? s : s.substring(0, dot);
            s = group(intPart) + (dot < 0 ? "" : s.substring(dot));
        }
        if (precision == 0 && flags.indexOf('#') >= 0) {
            s += ".";
        }
        return s;
    }

    private static String scientific(BigDecimal abs, int precision, String flags) {
        int exponent = 0;
        String mantissa;
        if (abs.signum() == 0) {
            mantissa = BigDecimal.ZERO.setScale(precision).toPlainString();
        } else {
            BigDecimal r = abs.round(new MathContext(precision + 1, RoundingMode.HALF_UP));
            exponent = r.precision() - r.scale() - 1;
            BigDecimal m = r.movePointLeft(exponent).setScale(precision, RoundingMode.HALF_UP);
            mantissa = m.toPlainString();
        }
        if (precision == 0 && flags.indexOf('#') >= 0) {
            mantissa += ".";
        }
        String e = String.valueOf(Math.abs(exponent));
        if (e.length() < 2) {
            e = "0" + e;
        }
        return mantissa + "e" + (exponent < 0 ? "-" : "+") + e;
    }

    private static String two(int v) {
        return v < 10 ? "0" + v : String.valueOf(v);
    }

    private static String formatTime(Object arg, char sub) {
        Calendar c = Calendar.getInstance();
        if (arg instanceof Date) {
            c.setTime((Date) arg);
        } else if (arg instanceof Long) {
            c.setTimeInMillis((Long) arg);
        } else if (arg instanceof Calendar) {
            c = (Calendar) arg;
        } else {
            throw new java.util.IllegalFormatConversionException('t', arg == null ? Object.class : arg.getClass());
        }
        switch (sub) {
            case 'H':
                return two(c.get(Calendar.HOUR_OF_DAY));
            case 'M':
                return two(c.get(Calendar.MINUTE));
            case 'S':
                return two(c.get(Calendar.SECOND));
            case 'Y':
                return String.valueOf(c.get(Calendar.YEAR));
            case 'm':
                return two(c.get(Calendar.MONTH) + 1);
            case 'd':
                return two(c.get(Calendar.DAY_OF_MONTH));
            case 'T':
                return two(c.get(Calendar.HOUR_OF_DAY)) + ":" + two(c.get(Calendar.MINUTE)) + ":" + two(c.get(Calendar.SECOND));
            case 'D':
                return two(c.get(Calendar.MONTH) + 1) + "/" + two(c.get(Calendar.DAY_OF_MONTH)) + "/" + two(c.get(Calendar.YEAR) % 100);
            case 'F':
                return c.get(Calendar.YEAR) + "-" + two(c.get(Calendar.MONTH) + 1) + "-" + two(c.get(Calendar.DAY_OF_MONTH));
            default:
                throw new UnknownFormatConversionException("t" + sub);
        }
    }
}
