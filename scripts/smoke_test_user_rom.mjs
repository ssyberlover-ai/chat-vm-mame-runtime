import { chromium } from "playwright";
import { createHash } from "node:crypto";
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
const consoleLines = [];
const pageErrors = [];
page.on("console", message => consoleLines.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", error => pageErrors.push(error.stack || String(error)));

const sha256 = data => createHash("sha256").update(data).digest("hex");
const result = {
  target_url: targetUrl,
  selected_game: null,
  selected_core: null,
  canvas: false,
  controls: [],
  control_profile: null,
  concurrent_hold: false,
  released_inputs: false,
  service_switch_sent: false,
  screen_changed_after_service: false,
  final_status: "",
  console: consoleLines,
  page_errors: pageErrors
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

try {
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => {
    const selected = document.querySelector('#catalog input[name="game"]:checked');
    return selected?.value === "hoops96-user";
  }, null, { timeout: 90000, polling: 500 });

  await page.check("#agree");
  await page.click("#launch");

  await page.waitForFunction(() => {
    const status = document.querySelector("#status")?.textContent || "";
    const error = document.querySelector("#error")?.textContent || "";
    return status.includes("실행 중") || status.includes("실행 실패") || error.length > 0;
  }, null, { timeout: 240000, polling: 500 });

  await page.waitForTimeout(9000);
  result.final_status = await page.locator("#status").textContent();
  const errorText = await page.locator("#error").textContent();
  if (errorText || result.final_status.includes("실행 실패")) {
    throw new Error(errorText || result.final_status);
  }

  const romErrorLines = consoleLines.filter(line =>
    !/Translation not found/i.test(line) &&
    /Failed to start game|missing required files|ROM loading (?:problem|failed)|(?:ROM|file).{0,40}not found/i.test(line)
  );
  if (romErrorLines.length) {
    throw new Error(`Core reported a ROM loading problem:\n${romErrorLines.join("\n")}`);
  }

  const diagnostics = await page.evaluate(() => window.webEmulatorDiagnostics || null);
  result.selected_game = diagnostics?.id || null;
  result.selected_core = diagnostics?.core || null;
  result.control_profile = diagnostics?.controlProfile || null;
  if (
    result.selected_game !== "hoops96-user" ||
    result.selected_core !== "mame2003_plus" ||
    result.control_profile !== "arcade" ||
    !diagnostics?.customTouchControls
  ) {
    throw new Error(`Unexpected runtime diagnostics: ${JSON.stringify(diagnostics)}`);
  }

  result.canvas = await page.evaluate(() =>
    [...document.querySelectorAll("#game canvas")].some(canvas =>
      canvas.width > 0 && canvas.height > 0 && getComputedStyle(canvas).display !== "none"
    )
  );
  if (!result.canvas) throw new Error("MAME canvas was not detected");

  const expectedControls = [
    ["#touch-b1", "B1"],
    ["#touch-b2", "B2"],
    ["#touch-b3", "B3"],
    ["#touch-coin", "COIN"],
    ["#touch-start", "START"],
    ["#touch-test", "TEST"]
  ];
  for (const [selector, label] of expectedControls) {
    const control = page.locator(selector);
    if (!(await control.isVisible())) throw new Error(`${label} touch control is not visible`);
    result.controls.push(label);
  }

  const pointerEvent = (pointerId, pointerType = "touch") => ({
    pointerId,
    pointerType,
    isPrimary: pointerId === 41,
    buttons: 1,
    button: 0,
    clientX: 10,
    clientY: 10
  });

  await page.dispatchEvent("#touch-dir-5", "pointerdown", pointerEvent(41));
  await page.dispatchEvent("#touch-b1", "pointerdown", pointerEvent(42));
  await sleep(350);

  let inputEvents = await page.evaluate(() => window.touchControlDiagnostics?.events || []);
  result.concurrent_hold = inputEvents.some(event => event.index === 7 && event.value === 1) &&
    inputEvents.some(event => event.index === 0 && event.value === 1);
  if (!result.concurrent_hold) {
    throw new Error(`Concurrent direction/action hold was not recorded: ${JSON.stringify(inputEvents)}`);
  }

  await page.dispatchEvent("#touch-dir-5", "pointerup", { ...pointerEvent(41), buttons: 0 });
  await page.dispatchEvent("#touch-b1", "pointerup", { ...pointerEvent(42), buttons: 0 });
  await sleep(250);
  inputEvents = await page.evaluate(() => window.touchControlDiagnostics?.events || []);
  result.released_inputs = inputEvents.some(event => event.index === 7 && event.value === 0) &&
    inputEvents.some(event => event.index === 0 && event.value === 0);
  if (!result.released_inputs) {
    throw new Error(`Released inputs were not recorded: ${JSON.stringify(inputEvents)}`);
  }

  const canvas = page.locator("#game canvas").last();
  const before = await canvas.screenshot({ path: "smoke-hoops96-before-test.png" });
  await page.locator("#touch-test").click();
  await page.waitForTimeout(7000);
  const after = await canvas.screenshot({ path: "smoke-hoops96.png" });

  result.service_switch_sent = await page.evaluate(() =>
    Number(window.touchControlDiagnostics?.serviceEvents || 0) > 0
  );
  result.screen_changed_after_service = sha256(before) !== sha256(after);
  if (!result.service_switch_sent) throw new Error("TEST control did not dispatch the service switch");
  if (!result.screen_changed_after_service) {
    throw new Error("Game canvas did not change after the TEST service switch");
  }

  const fatalErrors = pageErrors.filter(message => !/Wake Lock permission request denied/i.test(message));
  if (fatalErrors.length) throw new Error(`Browser errors:\n${fatalErrors.join("\n\n")}`);

  await page.screenshot({ path: "smoke-hoops96-full.png", fullPage: true });
} catch (error) {
  result.error = error.stack || String(error);
  await page.screenshot({ path: "smoke-hoops96-failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile("smoke-hoops96-result.json", JSON.stringify(result, null, 2) + "\n");
  await browser.close();
}
