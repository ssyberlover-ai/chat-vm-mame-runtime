import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const targetUrl = process.env.SMOKE_URL || "http://127.0.0.1:8000/index.html";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
const browserErrors = [];
const consoleLines = [];

page.on("pageerror", error => browserErrors.push(error.stack || String(error)));
page.on("console", message => consoleLines.push(`${message.type()}: ${message.text()}`));

const result = {
  target_url: targetUrl,
  interstitial_passed: false,
  page_loaded: false,
  dos_prompt: false,
  vm_ready: false,
  mame_graphics: false,
  final_status: "",
  screen_before_launch: "",
  screen_after_launch: "",
  browser_errors: browserErrors,
  console: consoleLines
};

try {
  await page.goto(targetUrl, {
    waitUntil: "networkidle",
    timeout: 60000
  });

  const openPageLink = page.getByText("Open the page", { exact: true });
  if (await openPageLink.count()) {
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {}),
      openPageLink.first().click()
    ]);
    result.interstitial_passed = true;
  }

  result.page_loaded = true;
  await page.waitForSelector("#agree", { timeout: 60000 });
  await page.check("#agree");
  await page.click("#start");

  await page.waitForFunction(() => {
    const text = window.chatVmDiagnostics?.screenText || "";
    const status = window.chatVmDiagnostics?.status || "";
    return /A:\\?>/i.test(text) || status.includes("실행 실패");
  }, null, { timeout: 150000, polling: 250 });

  result.final_status = await page.locator("#status").textContent();
  result.screen_before_launch = await page.evaluate(() => window.chatVmDiagnostics?.screenText || "");
  if (result.final_status.includes("실행 실패")) {
    throw new Error(await page.locator("#error").textContent());
  }
  result.dos_prompt = /A:\\?>/i.test(result.screen_before_launch);
  if (!result.dos_prompt) {
    throw new Error(`FreeDOS prompt was not detected:\n${result.screen_before_launch}`);
  }

  await page.waitForFunction(() => {
    const text = document.querySelector("#status")?.textContent || "";
    return text.includes("준비 완료") || text.includes("실행 실패");
  }, null, { timeout: 30000, polling: 250 });

  result.vm_ready = true;
  await page.screenshot({ path: "smoke-dos-ready.png", fullPage: true });
  await page.click("#run");

  await page.waitForFunction(() => {
    const canvas = document.querySelector("#screen_container canvas");
    const status = document.querySelector("#status")?.textContent || "";
    return status.includes("실행 실패") ||
      Boolean(canvas && getComputedStyle(canvas).display !== "none" && canvas.width > 0 && canvas.height > 0);
  }, null, { timeout: 180000, polling: 250 });

  result.final_status = await page.locator("#status").textContent();
  result.screen_after_launch = await page.evaluate(() => window.chatVmDiagnostics?.screenText || "");
  if (result.final_status.includes("실행 실패")) {
    throw new Error(await page.locator("#error").textContent());
  }
  result.mame_graphics = true;

  await page.click('[data-key="o"]');
  await page.waitForTimeout(700);
  await page.click('[data-key="k"]');
  await page.waitForTimeout(3500);
  await page.click('[data-key="5"]');
  await page.waitForTimeout(700);
  await page.click('[data-key="1"]');
  await page.waitForTimeout(6000);

  if (browserErrors.length) {
    throw new Error(`Browser errors detected:\n${browserErrors.join("\n\n")}`);
  }

  await page.screenshot({ path: "smoke-mame.png", fullPage: true });
} catch (error) {
  result.error = error.stack || String(error);
  result.screen_after_launch = await page.evaluate(() => window.chatVmDiagnostics?.screenText || "").catch(() => result.screen_after_launch);
  await page.screenshot({ path: "smoke-failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  result.final_status = await page.locator("#status").textContent().catch(() => result.final_status);
  await writeFile("smoke-result.json", JSON.stringify(result, null, 2) + "\n");
  await browser.close();
}
