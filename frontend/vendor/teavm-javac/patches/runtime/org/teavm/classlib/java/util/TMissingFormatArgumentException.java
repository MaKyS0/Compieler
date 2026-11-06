package org.teavm.classlib.java.util;

/** java.util.MissingFormatArgumentException (missing from TeaVM's class library). */
public class TMissingFormatArgumentException extends IllegalArgumentException {
    private final String specifier;

    public TMissingFormatArgumentException(String specifier) {
        super("Format specifier '" + specifier + "'");
        this.specifier = specifier;
    }

    public String getFormatSpecifier() {
        return specifier;
    }
}
