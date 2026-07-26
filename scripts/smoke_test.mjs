import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
const browserErrors = [];
const consoleLines = [];

page.on("pageerror", error => browserErrors.push(error.stack || String(error)));
page.on("console", message => consoleLines.push(`${message.type()}: ${message.text()}`));

const result = {
  page_loaded: false,
  vm_ready: false,
  mame_graphics: false,
  final_status: "",
  browser_errors: browserErrors,
  console: consoleLines
};

try {
  await page.goto("http://127.0.0.1:8000/index.html", {
    waitUntil: "networkidle",
    timeout: 60000
  });
  result.page_loaded = true;

  await page.check("#agree");
  await page.click("#start");

  await page.waitForFunction(() => {
    const text = document.querySelector("#status")?.textContent || "";
    return text.includes("준비 완료") || text.includes("실행 실패");
  }, { timeout: 120000 });

  result.final_status = await page.locator("#status").textContent();
  if (result.final_status.includes("실행 실패")) {
    throw new Error(await page.locator("#error").textContent());
  }
  result.vm_ready = true;

  await page.click("#run");
  await page.waitForFunction(() => {
    const canvas = document.querySelector("#screen_container canvas");
    return canvas && getComputedStyle(canvas).display !== "none" && canvas.width > 0;
  }, { timeout: 60000 });
  result.mame_graphics = true;

  await page.click('[data-key="o"]');
  await page.waitForTimeout(500);
  await page.click('[data-key="k"]');
  await page.waitForTimeout(2500);
  await page.click('[data-key="5"]');
  await page.waitForTimeout(500);
  await page.click('[data-key="1"]');
  await page.waitForTimeout(4000);

  await page.screenshot({ path: "smoke-mame.png", fullPage: true });
} catch (error) {
  result.error = error.stack || String(error);
  await page.screenshot({ path: "smoke-failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  result.final_status = await page.locator("#status").textContent().catch(() => result.final_status);
  await writeFile("smoke-result.json", JSON.stringify(result, null, 2) + "\n");
  await browser.close();
}
