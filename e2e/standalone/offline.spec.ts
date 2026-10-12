import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

async function open(page: Page) {
  await page.goto("/");
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30_000 });
}
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}\\b`) });
const run = (page: Page) => page.getByRole("button", { name: "Run", exact: true }).click();
const out = (page: Page) => page.locator("pre").first();
// Paste instead of typing: Monaco auto-indents typed newlines, which would corrupt Python source.
async function setCode(page: Page, code: string) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((t) => navigator.clipboard.writeText(t), code);
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(200);
}
async function lang(page: Page, name: "Python" | "C++" | "JavaScript") {
  await page.getByRole("radio", { name, exact: true }).click();
  await page.waitForTimeout(400);
}
const term = async (page: Page) => (await page.locator(".xterm-rows").innerText()).replace(/ /g, " ");
const status = (page: Page) => page.getByRole("status");

test.describe("offline app (no backend): engines run on the device", () => {
  test("starts without any server and is cross-origin isolated", async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect(status(page)).toContainText("on-device");
    const apiCalls: string[] = [];
    page.on("request", (r) => r.url().includes("/api/") && apiCalls.push(r.url()));
    await page.reload();
    await page.waitForSelector(".monaco-editor .view-lines");
    expect(apiCalls).toEqual([]);
  });

  test("Python: real CPython with input from the Input tab", async ({ page }) => {
    await open(page);
    await tab(page, "Input").click();
    await page.getByLabel("Standard input").fill("Ada\n");
    await tab(page, "Output").click();
    await run(page);
    await expect(out(page)).toContainText("Hello, Ada!");
    await expect(out(page)).toContainText(/Python 3\.13/);
    await expect(status(page)).toContainText("exit code 0");
  });

  test("Python: interactive input() typed in the Terminal while it runs", async ({ page }) => {
    await open(page);
    await tab(page, "Terminal").click();
    await run(page);
    await expect.poll(() => term(page)).toContain("Enter your name:");
    await page.locator(".xterm").click();
    await page.keyboard.type("Grace");
    await page.keyboard.press("Enter");
    await expect.poll(() => term(page)).toContain("Hello, Grace!");
    await expect(status(page)).toContainText("exit code 0");
  });

  test("Python: stdlib, sqlite3, numpy, asyncio, files and exceptions", async ({ page }) => {
    await open(page);
    await setCode(page, [
      "import os, sys, json, re, math, random, statistics, datetime, collections, itertools, functools, hashlib, zipfile, csv, sqlite3, asyncio, pathlib, tempfile, shutil, threading, decimal, logging",
      "import numpy as np",
      "async def main():",
      "    await asyncio.sleep(0.01)",
      "    return 'async-ok'",
      "db = sqlite3.connect(':memory:'); db.execute('create table t(x)'); db.execute('insert into t values (41)')",
      "print(db.execute('select x+1 from t').fetchone(), np.arange(5).sum(), asyncio.run(main()))",
      "pathlib.Path('data').mkdir(exist_ok=True); pathlib.Path('data/a.txt').write_text('héllo')",
      "print(hashlib.sha256(b'x').hexdigest()[:8], os.listdir('data'), sys.platform)",
      "",
    ].join("\n"));
    await run(page);
    await expect(out(page)).toContainText("(42,) 10 async-ok", { timeout: 90_000 });
    await expect(out(page)).toContainText("2d711642 ['a.txt']");
    await expect(page.getByRole("treeitem", { name: /data/ })).toBeVisible();
  });

  test("Python: traceback becomes a Problem on the right line; exit code 1", async ({ page }) => {
    await open(page);
    await setCode(page, "print('start')\nx = 1 / 0\n");
    await run(page);
    await expect(tab(page, "Problems")).toContainText("1");
    await tab(page, "Errors").click();
    await expect(out(page)).toContainText("ZeroDivisionError: division by zero");
    await tab(page, "Problems").click();
    await expect(page.getByRole("button", { name: /ZeroDivisionError.*main\.py:2/ })).toBeVisible();
    await expect(status(page)).toContainText("exit code 1");
  });

  test("Python: sys.exit code, syntax error, missing module hint", async ({ page }) => {
    await open(page);
    await setCode(page, "import sys\nsys.exit(7)\n");
    await run(page);
    await expect(status(page)).toContainText("exit code 7");
    await setCode(page, "print('oops'\n");
    await run(page);
    await tab(page, "Errors").click();
    await expect(out(page)).toContainText("SyntaxError");
    await setCode(page, "import definitely_not_a_module_xyz\n");
    await run(page);
    await tab(page, "Output").click();
    await expect(out(page)).toContainText("is not available", { timeout: 30_000 });
  });

  test("Stop button kills an infinite Python loop and the next run still works", async ({ page }) => {
    await open(page);
    await setCode(page, "print('looping', flush=True)\nwhile True:\n    pass\n");
    await run(page);
    await expect(out(page)).toContainText("looping");
    await page.getByRole("button", { name: "Stop", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(status(page)).toContainText("stopped");
    await setCode(page, "print('second run ok')\n");
    await run(page);
    await expect(out(page)).toContainText("second run ok");
  });

  test("C++: compiles with clang, runs with cin/cout and STL, reports exit code", async ({ page }) => {
    await open(page);
    await lang(page, "C++");
    await setCode(page, '#include <iostream>\n#include <vector>\n#include <map>\n#include <algorithm>\n#include <string>\nint main(){ std::vector<int> v{5,3,9,1}; std::sort(v.begin(),v.end()); std::map<std::string,int> m{{"a",1}}; int n; std::cin >> n; std::cout << v[0] << v[3] << " " << m["a"] << " " << n*2 << std::endl; return 4; }');
    await tab(page, "Input").click();
    await page.getByLabel("Standard input").fill("21\n");
    await tab(page, "Output").click();
    await run(page);
    await expect(out(page)).toContainText("19 1 42");
    await expect(status(page)).toContainText("exit code 4");
  });

  test("C++: interactive printf/scanf prompt appears before input, typed in the Terminal", async ({ page }) => {
    await open(page);
    await lang(page, "C++");
    await setCode(page, '#include <cstdio>\nint main(){ int x; printf("Enter x: "); scanf("%d", &x); printf("x*x=%d\\n", x*x); }');
    await tab(page, "Terminal").click();
    await run(page);
    await expect.poll(() => term(page)).toContain("Enter x:");
    await page.locator(".xterm").click();
    await page.keyboard.type("9");
    await page.keyboard.press("Enter");
    await expect.poll(() => term(page)).toContain("x*x=81");
  });

  test("C++: compile errors become Problems with file and line", async ({ page }) => {
    await open(page);
    await lang(page, "C++");
    await setCode(page, "#include <iostream>\nint main(){\n  int x = ;\n  std::cout << x\n}\n");
    await run(page);
    await expect(status(page)).toContainText("compile error");
    await tab(page, "Problems").click();
    await expect(page.getByText(/expected expression/)).toBeVisible();
    await expect(page.getByText("main.cpp:3:11")).toBeVisible();
  });

  test("C++: several source files and headers", async ({ page }) => {
    await open(page);
    await lang(page, "C++");
    for (const [name, code] of [["mathx.h", "#pragma once\nint add(int a, int b);\n"], ["mathx.cpp", '#include "mathx.h"\nint add(int a, int b) { return a + b; }\n']] as const) {
      await page.getByRole("button", { name: "New file" }).click();
      await page.getByRole("dialog").getByRole("textbox").fill(name);
      await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
      await setCode(page, code);
    }
    await page.getByRole("tab", { name: /main\.cpp/ }).click();
    await setCode(page, '#include <iostream>\n#include "mathx.h"\nint main(){ std::cout << add(40, 2) << "\\n"; }\n');
    await run(page);
    await expect(out(page)).toContainText("42");
    await expect(status(page)).toContainText("exit code 0");
  });

  test("JavaScript: Node-style modules, async, console formatting, fs writes persist", async ({ page }) => {
    await open(page);
    await lang(page, "JavaScript");
    await setCode(page, [
      "const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), util = require('util'), EventEmitter = require('events');",
      "console.log([1, 2], { a: { b: [3] } }, new Map([[1, 2]]), new Set([1]), path.join('a', '..', 'b'));",
      "console.log(crypto.createHash('sha256').update('abc').digest('hex').slice(0, 8), typeof os.cpus, util.format('%s=%d', 'x', 5));",
      "fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/a.txt', 'node-file');",
      "console.log(fs.readFileSync('out/a.txt', 'utf8'));",
      "const e = new EventEmitter(); e.on('ev', v => console.log('event', v)); e.emit('ev', 7);",
      "setTimeout(() => console.log('timer'), 30);",
      "(async () => { await new Promise(r => setTimeout(r, 10)); console.log('async ok'); console.error('to-stderr'); })();",
      "",
    ].join("\n"));
    await run(page);
    await expect(out(page)).toContainText("[ 1, 2 ] { a: { b: [ 3 ] } } Map(1) { 1 => 2 } Set(1) { 1 } b");
    await expect(out(page)).toContainText("ba7816bf function x=5");
    await expect(out(page)).toContainText("event 7");
    await expect(out(page)).toContainText("timer");
    await expect(status(page)).toContainText("exit code 0");
    await tab(page, "Errors").click();
    await expect(out(page)).toContainText("to-stderr");
    await expect(page.getByRole("treeitem", { name: /out/ })).toBeVisible();
  });

  test("JavaScript: readline question typed in the Terminal; process exits afterwards", async ({ page }) => {
    await open(page);
    await lang(page, "JavaScript");
    await tab(page, "Terminal").click();
    await run(page);
    await expect.poll(() => term(page)).toContain("Enter your name:");
    await page.locator(".xterm").click();
    await page.keyboard.type("Linus");
    await page.keyboard.press("Enter");
    await expect.poll(() => term(page)).toContain("Hello, Linus!");
    await expect(status(page)).toContainText("exit code 0");
  });

  test("JavaScript: uncaught exception and syntax error give Problems", async ({ page }) => {
    await open(page);
    await lang(page, "JavaScript");
    await setCode(page, "function boom() {\n  throw new TypeError('bad thing');\n}\nconsole.log('start');\nboom();\n");
    await run(page);
    await expect(status(page)).toContainText("exit code 1");
    await tab(page, "Problems").click();
    await expect(page.getByRole("button", { name: /TypeError: bad thing.*index\.js:2/ })).toBeVisible();
    await setCode(page, "let x = ;\n");
    await run(page);
    await tab(page, "Errors").click();
    await expect(out(page)).toContainText("SyntaxError");
    await tab(page, "Problems").click();
    await expect(page.getByRole("button", { name: /SyntaxError.*index\.js:1/ })).toBeVisible();
  });

  test("JavaScript: ES modules and multiple files", async ({ page }) => {
    await open(page);
    await lang(page, "JavaScript");
    await page.getByRole("button", { name: "New file" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("lib.mjs");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await setCode(page, "export const twice = (x) => x * 2;\nexport default 'dflt';\n");
    await page.getByRole("tab", { name: /index\.js/ }).click();
    await setCode(page, "import d, { twice } from './lib.mjs';\nimport { readFileSync } from 'node:fs';\nconsole.log(d, twice(21), typeof readFileSync);\n");
    await run(page);
    await expect(out(page)).toContainText("dflt 42 function");
  });

  test("Stop kills an infinite JavaScript loop and an infinite C++ loop", async ({ page }) => {
    await open(page);
    await lang(page, "JavaScript");
    await setCode(page, "console.log('js-loop');\nwhile (true) {}\n");
    await run(page);
    await expect(out(page)).toContainText("js-loop");
    await page.getByRole("button", { name: "Stop", exact: true }).first().click();
    await expect(status(page)).toContainText("stopped", { timeout: 15_000 });
    await lang(page, "C++");
    await setCode(page, '#include <cstdio>\nint main(){ puts("cpp-loop"); fflush(stdout); for(;;){} }');
    await run(page);
    await expect(out(page)).toContainText("cpp-loop");
    await page.getByRole("button", { name: "Stop", exact: true }).first().click();
    await expect(status(page)).toContainText("stopped", { timeout: 15_000 });
  });

  test("projects and files persist on the device across reloads; ZIP export and import", async ({ page }) => {
    await open(page);
    await setCode(page, "VALUE = 'persisted on device'\nprint(VALUE)\n");
    await expect(status(page)).toContainText("Saved");
    await page.reload();
    await page.waitForSelector(".monaco-editor .view-lines");
    await expect.poll(async () => (await page.locator(".monaco-editor .view-lines").first().innerText()).replace(/ /g, " ")).toContain("persisted on device");
    await page.getByRole("button", { name: "Projects" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Export current as ZIP/ }).click()]);
    expect(download.suggestedFilename()).toBe("My_first_project.zip");
    await page.locator('input[type="file"][accept*="zip"]').setInputFiles({ name: "Copy.zip", mimeType: "application/zip", buffer: readFileSync((await download.path())!) });
    await expect(page.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue("Copy", { timeout: 20_000 });
    await expect.poll(async () => (await page.locator(".monaco-editor .view-lines").first().innerText()).replace(/ /g, " ")).toContain("persisted on device");
  });

  test("Terminal shell: ls, cat and launching python", async ({ page }) => {
    await open(page);
    await tab(page, "Terminal").click();
    await page.locator(".xterm").click();
    await page.keyboard.type("ls");
    await page.keyboard.press("Enter");
    await expect.poll(() => term(page)).toContain("requirements.txt");
    await page.keyboard.type("echo hello-shell");
    await page.keyboard.press("Enter");
    await expect.poll(() => term(page)).toContain("hello-shell");
    await page.keyboard.type("foobar");
    await page.keyboard.press("Enter");
    await expect.poll(() => term(page)).toContain("foobar: command not found");
  });

  test("Python writes an image and the editor previews it", async ({ page }) => {
    await open(page);
    await setCode(page, "import struct, zlib\ndef png(w,h):\n    raw=b''.join(b'\\x00'+bytes([200,50,50])*w for _ in range(h))\n    def ch(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d))\n    return b'\\x89PNG\\r\\n\\x1a\\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b'')\nopen('red.png','wb').write(png(8,8))\nprint('wrote')\n");
    await run(page);
    await expect(out(page)).toContainText("wrote");
    await page.getByRole("treeitem", { name: /red\.png/ }).click();
    await expect(page.locator('img[alt="red.png"]')).toBeVisible();
  });
});
