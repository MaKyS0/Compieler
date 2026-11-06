package org.teavm.classlib.java.util;

import java.util.NoSuchElementException;

public class TInputMismatchException extends NoSuchElementException {
    public TInputMismatchException() {
    }

    public TInputMismatchException(String message) {
        super(message);
    }
}
