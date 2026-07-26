import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const targetUrl = process.env.SMOKE_URL || "http://127.0.0.1:8000/index.html";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 430, height: 900 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1
});
const page = await context.newPage();
const browserErrors = [];
const consoleLines = [];

page.on("pageerror", error => browserErrors.push(error.stack || String(error)));
page.on("console", message => consoleLines.push(`${message.type()}: ${message.text()}`));

const result = {
  target_url: targetUrl,
  page_loaded: false,
  mode: "unknown",
  game_canvas: false,
  mobile_controls: false,
  final_status: "",
  browser_errors: browserErrors,
  console: consoleLines
};

async function testArcadePage() {
  result.mode = "web-mame";
  await page.click("#launch");

  await page.waitForFunction(() => {
    const status = document.querySelector("#status")?.textContent || "";
    const canvas = document.querySelector("#game canvas");
    const error = document.querySelector("#error")?.textContent || "";
    return status.includes("게임 실행 중") ||
      Boolean(canvas && canvas.width > 0 && canvas.height > 0) ||
      error.length > 0 ||
      status.includes("실행 실패");
  }, null, { timeout: 240000, polling: 300 });

  await page.waitForTimeout(12000);
  result.final_status = await page.locator("#status").textContent();
  const errorText = await page.locator("#error").textContent();
  if (errorText || result.final_status.includes("실행 실패")) {
    throw new Error(errorText || result.final_status);
  }

  result.game_canvas = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll("#game canvas")];
    return canvases.some(canvas => canvas.width > 0 && canvas.height > 0 && getComputedStyle(canvas).display !== "none");
  });
  if (!result.game_canvas) {
    throw new Error("EmulatorJS game canvas was not detected");
  }

  result.mobile_controls = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll("#game button, #game [class*='button'], #game [class*='control'], #game [class*='gamepad']")];
    return candidates.some(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 20 && rect.height > 20;
    });
  });

  await page.keyboard.press("Digit5").catch(() => {});
  await page.waitForTimeout(500);
  await page.keyboard.press("Digit1").catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "smoke-mame.png", fullPage: true });
}

async function testLegacyVmPage() {
  result.mode = "legacy-v86";
  await page.check("#agree");
  await page.click("#start");
  await page.waitForFunction(() => {
    const text = window.chatVmDiagnostics?.screenText || "";
    const status = window.chatVmDiagnostics?.status || "";
    return /A:\\?>/i.test(text) || status.includes("실행 실패");
  }, null, { timeout: 150000, polling: 250 });
  const status = await page.locator("#status").textContent();
  if (status.includes("실행 실패")) throw new Error(await page.locator("#error").textContent());
  await page.click("#run");
  await page.waitForFunction(() => {
    const canvas = document.querySelector("#screen_container canvas");
    return Boolean(canvas && getComputedStyle(canvas).display !== "none" && canvas.width > 0 && canvas.height > 0);
  }, null, { timeout: 180000, polling: 250 });
  result.game_canvas = true;
  result.final_status = await page.locator("#status").textContent();
  await page.screenshot({ path: "smoke-mame.png", fullPage: true });
}

try {
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });
  result.page_loaded = true;

  if (await page.locator("#launch").count()) {
    await testArcadePage();
  } else if (await page.locator("#agree").count()) {
    await testLegacyVmPage();
  } else {
    throw new Error("No supported emulator page entry point was found");
  }

  if (browserErrors.length) {
    throw new Error(`Browser errors detected:\n${browserErrors.join("\n\n")}`);
  }
} catch (error) {
  result.error = error.stack || String(error);
  await page.screenshot({ path: "smoke-failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  result.final_status = await page.locator("#status").textContent().catch(() => result.final_status);
  await writeFile("smoke-result.json", JSON.stringify(result, null, 2) + "\n");
  await browser.close();
}
