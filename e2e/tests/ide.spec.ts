import { expect, test } from "@playwright/test";
import { createProjectVia, editorText, openApp, outputText, run, runButton, setCode, stopButton, tab, terminalText } from "./helpers";

test.describe("online IDE (real backend, real sandbox)", () => {
  test("loads the editor as the main screen with a starter project", async ({ page }) => {
    await openApp(page);
    await expect(page.getByLabel("Project name")).toHaveValue("My first project");
    expect(await editorText(page)).toContain("Enter your name");
    for (const name of ["Output", "Errors", "Terminal", "Input", "Problems"]) await expect(tab(page, name)).toBeVisible();
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  });

  test("Python: stdin from the Input tab produces real output and exit code", async ({ page }) => {
    await openApp(page);
    await tab(page, "Input").click();
    await page.getByLabel("Standard input").fill("Ada\n");
    await run(page);
    await tab(page, "Output").click();
    await expect(page.locator("pre").first()).toContainText("Hello, Ada!", { timeout: 30_000 });
    await expect(page.locator("pre").first()).toContainText("Python 3.");
    await expect(page.getByRole("status")).toContainText("exit code 0");
  });

  test("Python: interactive input typed into the Terminal while the program runs", async ({ page }) => {
    await openApp(page);
    await tab(page, "Input").click();
    await page.getByLabel("Standard input").fill("");
    await tab(page, "Terminal").click();
    await run(page);
    await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("Enter your name:");
    await page.locator(".xterm").click();
    await page.keyboard.type("Grace");
    await page.keyboard.press("Enter");
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).toContain("Hello, Grace!");
    await expect(page.getByRole("status")).toContainText("exit code 0");
  });

  test("Python: exceptions land in Errors and Problems and mark the editor line", async ({ page }) => {
    await openApp(page);
    await setCode(page, "print('start')\nx = 1 / 0\n");
    await run(page);
    await expect(tab(page, "Problems")).toContainText("1", { timeout: 30_000 });
    await tab(page, "Errors").click();
    await expect(page.locator("pre").first()).toContainText("ZeroDivisionError");
    await tab(page, "Problems").click();
    await expect(page.getByRole("button", { name: /ZeroDivisionError.*main\.py:2/ })).toBeVisible();
    await expect(page.locator(".squiggly-error").first()).toBeVisible();
    await expect(page.getByRole("status")).toContainText("exit code 1");
  });

  test("Stop button terminates an infinite loop", async ({ page }) => {
    await openApp(page);
    await setCode(page, "import time\nprint('looping', flush=True)\nwhile True:\n    time.sleep(0.05)\n");
    await run(page);
    await expect(stopButton(page)).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Running");
    await expect(page.locator("pre").first()).toContainText("looping", { timeout: 20_000 });
    await stopButton(page).click();
    await expect(runButton(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("status")).toContainText("stopped");
  });

  test("C++: compile error shows diagnostics, fixed code runs with cin/cout", async ({ page }) => {
    await openApp(page);
    await createProjectVia(page, "C++");
    await expect.poll(() => editorText(page)).toContain("#include");
    await setCode(page, '#include <iostream>\nint main() {\n  int a;\n  std::cin >> a;\n  std::cout << a * 2 << std::endl\n}\n');
    await run(page);
    await expect(tab(page, "Problems")).toContainText(/\d/, { timeout: 40_000 });
    await expect(page.getByRole("status")).toContainText("compile error");
    await tab(page, "Problems").click();
    await expect(page.getByText(/expected .;. before/)).toBeVisible();
    await setCode(page, '#include <iostream>\nint main() {\n  int a;\n  std::cin >> a;\n  std::cout << a * 2 << std::endl;\n}\n');
    await tab(page, "Input").click();
    await page.getByLabel("Standard input").fill("21\n");
    await run(page);
    await tab(page, "Output").click();
    await expect(page.locator("pre").first()).toContainText("42", { timeout: 40_000 });
  });

  test("JavaScript runs on Node.js", async ({ page }) => {
    await openApp(page);
    await createProjectVia(page, "JavaScript");
    await setCode(page, "const os = require('os');\nconsole.log('node', process.version.split('.')[0], typeof os.cpus);\nconsole.error('warn-line');\n");
    await run(page);
    await expect(page.locator("pre").first()).toContainText(/node v\d+ function/, { timeout: 30_000 });
    await tab(page, "Errors").click();
    await expect(page.locator("pre").first()).toContainText("warn-line");
  });

  test("files: create, edit, autosave, rename, delete and survive a reload", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "New file" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("helper.py");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("treeitem", { name: /helper\.py/ })).toBeVisible();
    await setCode(page, "VALUE = 'persisted-after-reload'\n");
    await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 });
    await page.reload();
    await page.waitForSelector(".monaco-editor .view-lines");
    await expect(page.getByRole("treeitem", { name: /helper\.py/ })).toBeVisible();
    await expect.poll(() => editorText(page)).toContain("persisted-after-reload");
    // rename
    await page.getByRole("treeitem", { name: /helper\.py/ }).click();
    await page.getByRole("button", { name: "Rename helper.py" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("tools.py");
    await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
    await expect(page.getByRole("treeitem", { name: /tools\.py/ })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /helper\.py/ })).toHaveCount(0);
    // delete
    await page.getByRole("treeitem", { name: /tools\.py/ }).click();
    await page.getByRole("button", { name: "Delete tools.py" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("treeitem", { name: /tools\.py/ })).toHaveCount(0);
  });

  test("multi-file Python project: import between files", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "New file" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("util.py");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await setCode(page, "def twice(x):\n    return x * 2\n");
    await page.getByRole("tab", { name: /main\.py/ }).click();
    await setCode(page, "from util import twice\nprint('result', twice(21))\n");
    await run(page);
    await expect(page.locator("pre").first()).toContainText("result 42", { timeout: 30_000 });
  });

  test("Terminal executes shell commands in the project sandbox", async ({ page }) => {
    await openApp(page);
    await tab(page, "Terminal").click();
    await page.locator(".xterm").click();
    await page.keyboard.type("ls && python3 -c \"print(6*7)\"");
    await page.keyboard.press("Enter");
    await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("main.py");
    await expect.poll(() => terminalText(page)).toContain("42");
  });

  test("Format button formats Python with black", async ({ page }) => {
    await openApp(page);
    await setCode(page, "x=[1,2,\n 3]\ndef f( a,b ):\n  return a+b\n");
    await page.getByRole("button", { name: "Format" }).click();
    await expect.poll(() => editorText(page), { timeout: 15_000 }).toContain("def f(a, b):");
    expect(await editorText(page)).toContain("x = [1, 2, 3]");
  });

  test("theme toggle switches between dark and light", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("panels are resizable by dragging the splitter", async ({ page }) => {
    await openApp(page);
    const panel = page.getByRole("tablist").last().locator("xpath=ancestor::div[contains(@class,'bg-panel')][1]");
    const before = (await panel.boundingBox())!.height;
    const sep = page.getByRole("separator").last();
    const box = (await sep.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 6 });
    await page.mouse.up();
    const after = (await panel.boundingBox())!.height;
    expect(after).toBeGreaterThan(before + 80);
  });

  test("projects: create, list, switch, export and import ZIP", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Projects" }).click();
    await page.getByLabel("New project name").fill("Second one");
    await page.getByLabel("Language").selectOption("javascript");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await expect(page.getByLabel("Project name")).toHaveValue("Second one");
    await expect(page.getByRole("radio", { name: "JavaScript" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Projects" }).click();
    await expect(page.getByRole("dialog").getByText("My first project")).toBeVisible();
    // export
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Export current as ZIP/ }).click()]);
    expect(download.suggestedFilename()).toBe("Second_one.zip");
    const path = await download.path();
    // import it back
    await page.locator('input[type="file"][accept*="zip"]').setInputFiles(path!);
    await expect(page.getByLabel("Project name")).toHaveValue("Second_one", { timeout: 15_000 });
    await expect(page.getByRole("treeitem", { name: /index\.js/ })).toBeVisible();
  });

  test("guest can register and keep the project", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Account" }).click();
    const email = `e2e${Date.now()}@example.com`;
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel(/^Password/).fill("a-long-password");
    await page.getByRole("dialog").getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Account created")).toBeVisible();
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("dialog")).toContainText(email);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Project name")).toBeVisible();
    // log back in; the original project is there
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("button", { name: /Already registered/ }).click();
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel(/^Password/).fill("a-long-password");
    await page.getByRole("dialog").getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
    await expect(page.getByLabel("Project name")).toHaveValue("My first project");
  });

  test("Packages panel installs a pip package and it can be imported", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Packages" }).click();
    await page.getByLabel("Package names").fill("six");
    await page.getByRole("button", { name: "Add" }).click();
    await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain("Successfully installed six");
    await expect(page.getByRole("complementary").getByText("six").first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Files" }).first().click();
    await setCode(page, "import six\nprint('six', six.__version__)\n");
    await run(page);
    await tab(page, "Output").click();
    await expect(page.locator("pre").first()).toContainText(/six \d+\.\d+/, { timeout: 40_000 });
  });

  test("a missing library gives a clear hint", async ({ page }) => {
    await openApp(page);
    await setCode(page, "import not_a_real_library_zz\n");
    await run(page);
    await tab(page, "Output").click();
    await expect(page.locator("pre").first()).toContainText("is not installed", { timeout: 30_000 });
    await expect(page.locator("pre").first()).toContainText("requirements.txt");
  });
});
