import { expect, type Page } from "@playwright/test";

export async function openApp(page: Page) {
  await page.goto("/");
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30_000 });
}

/** Replace the whole content of the active editor. insertText avoids Monaco's auto-closing brackets. */
export async function setCode(page: Page, code: string) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(code);
  await page.waitForTimeout(150);
}

export async function editorText(page: Page): Promise<string> {
  return (await page.locator(".monaco-editor .view-lines").first().innerText()).replace(/ /g, " ");
}

export const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}\\b`) });
export const runButton = (page: Page) => page.getByRole("button", { name: "Run", exact: true });
export const stopButton = (page: Page) => page.getByRole("button", { name: "Stop", exact: true }).first();

export async function createProjectVia(page: Page, language: "Python" | "C++" | "JavaScript") {
  await page.getByRole("radio", { name: language, exact: true }).click();
}

export async function run(page: Page) {
  await runButton(page).click();
}

export async function outputText(page: Page): Promise<string> {
  await tab(page, "Output").click();
  return page.locator("pre").first().innerText().catch(() => "");
}

export async function waitForIdle(page: Page) {
  await expect(page.getByRole("status").filter({ hasText: /Ready|Finished|exit code/ })).toBeVisible({ timeout: 45_000 });
}

export async function terminalText(page: Page): Promise<string> {
  return (await page.locator(".xterm-rows").innerText()).replace(/ /g, " ");
}
