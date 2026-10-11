import { expect, test } from "@playwright/test";
import { editorText, openApp, run, setCode } from "./helpers";

test.describe("phone layout", () => {
  test("bottom navigation switches panels and the symbol bar types into the editor", async ({ page }) => {
    await openApp(page);
    const nav = page.getByRole("navigation", { name: "Panels" });
    await expect(nav).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "Programming symbols" })).toBeVisible();
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Control+End");
    await page.getByRole("button", { name: "Insert {" }).tap();
    await page.getByRole("button", { name: "Insert ;" }).tap();
    expect(await editorText(page)).toContain("{;");
    await nav.getByRole("button", { name: "Files" }).tap();
    await expect(page.getByRole("treeitem", { name: /main\.py/ })).toBeVisible();
    await page.getByRole("treeitem", { name: /main\.py/ }).tap();
    await expect(page.locator(".monaco-editor")).toBeVisible();
    // no horizontal page scroll
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("running on a phone shows the console with real output", async ({ page }) => {
    await openApp(page);
    await setCode(page, "print('hello from phone')\n");
    await run(page);
    await expect(page.locator("pre").first()).toContainText("hello from phone", { timeout: 30_000 });
    await expect(page.getByRole("status")).toContainText("exit code 0");
  });
});
