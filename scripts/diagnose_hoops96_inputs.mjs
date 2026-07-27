import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const targetUrl = process.env.SMOKE_URL || "http://127.0.0.1:8000/?game=hoops96-user&touch=1";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 900, height: 430 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1
});
const page = await context.newPage();
const logs = [];
page.on("console", message => logs.push(`${message.type()}: ${message.text()}`));

const pulse = async (selector, pointerId, duration = 220) => {
  const event = {
    pointerId,
    pointerType: "touch",
    isPrimary: true,
    buttons: 1,
    button: 0,
    clientX: 10,
    clientY: 10
  };
  await page.dispatchEvent(selector, "pointerdown", event);
  await page.waitForTimeout(duration);
  await page.dispatchEvent(selector, "pointerup", { ...event, buttons: 0 });
  await page.waitForTimeout(250);
};

const result = { target_url: targetUrl, reached_io_check: false, captures: [], logs };

try {
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#catalog input[name="game"]:checked')?.value === "hoops96-user", null, { timeout: 90000 });
  await page.check("#agree");
  await page.click("#launch");
  await page.waitForFunction(() => (document.querySelector("#status")?.textContent || "").includes("실행 중"), null, { timeout: 240000 });
  await page.waitForTimeout(9000);

  const canvas = page.locator("#game canvas").last();
  await pulse("#touch-test", 10);
  await page.waitForTimeout(3000);

  for (let i = 0; i < 3; i++) await pulse("#touch-dir-7", 20 + i, 160);
  await pulse("#touch-b1", 30, 180);
  await page.waitForTimeout(2200);
  await canvas.screenshot({ path: "io-check-idle.png" });
  result.reached_io_check = true;

  await page.dispatchEvent("#touch-coin", "pointerdown", {
    pointerId: 41, pointerType: "touch", isPrimary: true, buttons: 1, button: 0, clientX: 10, clientY: 10
  });
  await page.waitForTimeout(500);
  await canvas.screenshot({ path: "io-check-custom-coin-down.png" });
  await page.dispatchEvent("#touch-coin", "pointerup", {
    pointerId: 41, pointerType: "touch", isPrimary: true, buttons: 0, button: 0, clientX: 10, clientY: 10
  });
  await page.waitForTimeout(500);
  await canvas.screenshot({ path: "io-check-custom-coin-up.png" });

  await page.evaluate(() => window.EJS_emulator.gameManager.simulateInput(0, 2, 1));
  await page.waitForTimeout(500);
  await canvas.screenshot({ path: "io-check-retropad-coin-down.png" });
  await page.evaluate(() => window.EJS_emulator.gameManager.simulateInput(0, 2, 0));
  await page.waitForTimeout(500);
  await canvas.screenshot({ path: "io-check-retropad-coin-up.png" });

  const parent = page.locator("#game .ejs_parent").first();
  await parent.focus().catch(() => page.locator("#game").focus());
  await page.keyboard.down("5");
  await page.waitForTimeout(500);
  await canvas.screenshot({ path: "io-check-trusted-key5-down.png" });
  await page.keyboard.up("5");
  await page.waitForTimeout(500);
  await canvas.screenshot({ path: "io-check-trusted-key5-up.png" });

  result.captures = [
    "io-check-idle.png",
    "io-check-custom-coin-down.png",
    "io-check-custom-coin-up.png",
    "io-check-retropad-coin-down.png",
    "io-check-retropad-coin-up.png",
    "io-check-trusted-key5-down.png",
    "io-check-trusted-key5-up.png"
  ];
} catch (error) {
  result.error = error.stack || String(error);
  await page.screenshot({ path: "io-check-failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile("io-check-result.json", JSON.stringify(result, null, 2) + "\n");
  await browser.close();
}
