# Java engine: teavm-javac

The offline app compiles and runs Java with [teavm-javac](https://github.com/konsoletyper/teavm-javac):
OpenJDK's `javac` and the [TeaVM](https://teavm.org) bytecode compiler, both compiled to one
WebAssembly module. A program is compiled to class files, then by TeaVM to a WebAssembly (GC) module
that runs in a Web Worker. Nothing is sent to a server.

## Files

| File | Origin |
|---|---|
| `upstream/compiler.wasm`, `upstream/compiler.wasm-runtime.js`, `upstream/runtime-classlib-teavm.bin`, `upstream/compile-classlib-teavm.bin` | Unmodified, downloaded from `https://teavm.org/playground/3/` on 2026-11-06 |
| `compile-classlib.bin` | `upstream/compile-classlib-teavm.bin` with the fixes below (generated) |
| `compieler-runtime.bin` | Classes added to every program (generated) |
| `patches/sdk/**` | Sources of the class-library fixes for javac |
| `patches/runtime/**` | Sources of the runtime additions |

Regenerate the two generated files after editing a patch (needs a JDK): `node scripts/build-java-runtime.mjs`.

## What the patches fix

* `java.lang.annotation.Annotation` in the upstream class library was marked as an annotation type that
  extends itself, so javac recursed forever on any annotation (`@Override` crashed the compiler). The
  standard annotations (`@Override`, `@SuppressWarnings`, `@FunctionalInterface`, `@Deprecated`, ...)
  are replaced by correct declarations.
* TeaVM has no `java.util.Scanner`; `TScanner` provides it (tokens, lines, numbers, booleans).
* TeaVM's `Formatter` crashes on `%f`/`%e`/`%g` in the WebAssembly GC runtime; `TFormatter` replaces it
  (`printf`, `String.format`, `formatted`), checked against the JDK's output.
* TeaVM's `InputStreamReader` needs NIO buffers that the WebAssembly GC backend cannot compile;
  `TInputStreamReader` decodes UTF-8 directly, so `BufferedReader(new InputStreamReader(System.in))` works.
* `System.in` cannot be read in TeaVM's WebAssembly runtime; `org.compieler.IO` reads the app's stdin
  channel (blocking, so `Scanner`/`readLine` wait for the user's input) and reports the exit status.
* `System.exit` is missing: it is declared for javac, and calls to it in compiled classes are redirected
  to `org.compieler.IO.exit` (`src/runtime/java/classfile.ts`).

## Limits

The language is OpenJDK's javac (records, sealed types, pattern matching, switch expressions, text
blocks, var, lambdas, generics). The class library is TeaVM's subset: `java.lang`, `java.util`
(collections, streams), `java.math`, basic `java.io`, `java.time` partially. Not available: reflection,
Swing/AWT, networking, files on disk, some newer methods (e.g. `String.lines()`); stack traces of
uncaught exceptions show only the exception. The generated code needs WebAssembly GC (Chrome / Android
System WebView 119 or newer).

## Licenses

TeaVM and teavm-javac: Apache License 2.0 (`upstream/LICENSE-TeaVM`). The `javac` compiled into
`compiler.wasm` is OpenJDK code under GPL v2 with the Classpath Exception (`upstream/LICENSE-OpenJDK`);
its source is available from the OpenJDK project and the teavm-javac repository.
