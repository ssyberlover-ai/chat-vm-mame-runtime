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
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const result = {
  target_url: targetUrl,
  selected_game: null,
  selected_core: null,
  canvas: false,
  controls: [],
  control_profile: null,
  arcade_stick: false,
  convex_buttons: false,
  concurrent_hold: false,
  released_inputs: false,
  service_switch_sent: false,
  reset_sent: false,
  coin_screen_changed: false,
  start_screen_changed: false,
  portrait_controls_separated: false,
  portrait_no_horizontal_overflow: false,
  portrait_controls_inside_viewport: false,
  final_status: "",
  console: consoleLines,
  page_errors: pageErrors
};

const pointer = (pointerId, x, y, buttons = 1) => ({
  pointerId,
  pointerType: "touch",
  isPrimary: pointerId === 41,
  buttons,
  button: 0,
  clientX: x,
  clientY: y
});

try {
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() =>
    document.querySelector('#catalog input[name="game"]:checked')?.value === "hoops96-user",
    null,
    { timeout: 90000, polling: 500 }
  );

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
  if (errorText || result.final_status.includes("실행 실패")) throw new Error(errorText || result.final_status);

  const romErrors = consoleLines.filter(line =>
    !/Translation not found/i.test(line) &&
    /Failed to start game|missing required files|ROM loading (?:problem|failed)|(?:ROM|file).{0,40}not found/i.test(line)
  );
  if (romErrors.length) throw new Error(`Core reported a ROM problem:\n${romErrors.join("\n")}`);

  const diagnostics = await page.evaluate(() => window.webEmulatorDiagnostics || null);
  result.selected_game = diagnostics?.id || null;
  result.selected_core = diagnostics?.core || null;
  result.control_profile = diagnostics?.controlProfile || null;
  if (
    result.selected_game !== "hoops96-user" ||
    result.selected_core !== "mame2003_plus" ||
    result.control_profile !== "arcade" ||
    !diagnostics?.customTouchControls
  ) throw new Error(`Unexpected runtime diagnostics: ${JSON.stringify(diagnostics)}`);

  result.canvas = await page.evaluate(() =>
    [...document.querySelectorAll("#game canvas")].some(canvas =>
      canvas.width > 0 && canvas.height > 0 && getComputedStyle(canvas).display !== "none"
    )
  );
  if (!result.canvas) throw new Error("MAME canvas was not detected");

  const expectedControls = [
    ["#direction-control.arcade-stick", "STICK"],
    ["#touch-b1", "B1"],
    ["#touch-b2", "B2"],
    ["#touch-b3", "B3"],
    ["#touch-test", "TEST"],
    ["#touch-reset", "RESET"],
    ["#touch-coin", "COIN"],
    ["#touch-start", "START"]
  ];
  for (const [selector, label] of expectedControls) {
    if (!(await page.locator(selector).isVisible())) throw new Error(`${label} control is not visible`);
    result.controls.push(label);
  }

  result.arcade_stick = await page.evaluate(() => {
    const stick = document.querySelector("#direction-control.arcade-stick");
    const knob = stick?.querySelector(".stick-knob");
    return Boolean(stick && knob && getComputedStyle(stick).borderRadius === "50%");
  });
  result.convex_buttons = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".action-pad.arcade .pad-key")];
    return buttons.length === 3 && buttons.every(button =>
      getComputedStyle(button).backgroundImage.includes("radial-gradient") &&
      getComputedStyle(button).borderRadius === "50%"
    );
  });
  if (!result.arcade_stick || !result.convex_buttons) throw new Error("Arcade controller styling was not applied");

  const stickBox = await page.locator("#direction-control").boundingBox();
  const b1Box = await page.locator("#touch-b1").boundingBox();
  if (!stickBox || !b1Box) throw new Error("Control bounding boxes were not found");
  const stickRight = pointer(41, stickBox.x + stickBox.width * .84, stickBox.y + stickBox.height * .5);
  const b1Down = pointer(42, b1Box.x + b1Box.width / 2, b1Box.y + b1Box.height / 2);

  await page.dispatchEvent("#direction-control", "pointerdown", stickRight);
  await page.dispatchEvent("#touch-b1", "pointerdown", b1Down);
  await sleep(350);
  let inputEvents = await page.evaluate(() => window.touchControlDiagnostics?.events || []);
  result.concurrent_hold = inputEvents.some(event => event.index === 7 && event.value === 1) &&
    inputEvents.some(event => event.index === 0 && event.value === 1);
  if (!result.concurrent_hold) throw new Error(`Concurrent stick/action hold failed: ${JSON.stringify(inputEvents)}`);

  await page.dispatchEvent("#direction-control", "pointerup", { ...stickRight, buttons: 0 });
  await page.dispatchEvent("#touch-b1", "pointerup", { ...b1Down, buttons: 0 });
  await sleep(250);
  inputEvents = await page.evaluate(() => window.touchControlDiagnostics?.events || []);
  result.released_inputs = inputEvents.some(event => event.index === 7 && event.value === 0) &&
    inputEvents.some(event => event.index === 0 && event.value === 0);
  if (!result.released_inputs) throw new Error(`Input release failed: ${JSON.stringify(inputEvents)}`);

  const canvas = page.locator("#game canvas").last();
  const initial = await canvas.screenshot({ path: "smoke-hoops96-before-test.png" });
  await page.locator("#touch-test").tap();
  await page.waitForTimeout(7000);
  const serviceMenu = await canvas.screenshot({ path: "smoke-hoops96-service-menu.png" });
  result.service_switch_sent = Number(await page.evaluate(() => window.touchControlDiagnostics?.serviceEvents || 0)) > 0;
  if (!result.service_switch_sent || sha256(initial) === sha256(serviceMenu)) throw new Error("TEST input did not change the game screen");

  await page.locator("#touch-reset").tap();
  await page.waitForTimeout(10000);
  const afterReset = await canvas.screenshot({ path: "smoke-hoops96-after-reset.png" });
  result.reset_sent = Number(await page.evaluate(() => window.touchControlDiagnostics?.resetEvents || 0)) > 0;
  if (!result.reset_sent || sha256(serviceMenu) === sha256(afterReset)) throw new Error("RESET did not restart the game");

  const pulse = async (selector, pointerId, duration = 430) => {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`${selector} bounding box missing`);
    const down = pointer(pointerId, box.x + box.width / 2, box.y + box.height / 2);
    await page.dispatchEvent(selector, "pointerdown", down);
    await page.waitForTimeout(duration);
    await page.dispatchEvent(selector, "pointerup", { ...down, buttons: 0 });
  };

  await pulse("#touch-coin", 51);
  await page.waitForTimeout(1200);
  const afterCoin = await canvas.screenshot({ path: "smoke-hoops96-after-coin.png" });
  result.coin_screen_changed = sha256(afterReset) !== sha256(afterCoin);

  await pulse("#touch-start", 52);
  await page.waitForTimeout(8000);
  const afterStart = await canvas.screenshot({ path: "smoke-hoops96-after-start.png" });
  result.start_screen_changed = sha256(afterCoin) !== sha256(afterStart);
  if (!result.coin_screen_changed || !result.start_screen_changed) throw new Error("COIN or START did not change the game screen");

  await page.screenshot({ path: "smoke-hoops96-landscape.png", fullPage: true });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(1600);

  const portrait = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll("#game canvas")]
      .find(item => item.width > 0 && item.height > 0 && getComputedStyle(item).display !== "none");
    const controls = document.querySelector("#touch-controls");
    const direction = document.querySelector("#direction-control");
    const canvasRect = canvas?.getBoundingClientRect();
    const controlsRect = controls?.getBoundingClientRect();
    const directionRect = direction?.getBoundingClientRect();
    const buttons = [...document.querySelectorAll("#touch-controls .pad-key")];
    return {
      separated: Boolean(canvasRect && controlsRect && controlsRect.top >= canvasRect.bottom - 2),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      controlsInsideViewport: Boolean(directionRect && directionRect.left >= -1 && directionRect.right <= window.innerWidth + 1) &&
        buttons.every(button => {
          const rect = button.getBoundingClientRect();
          return rect.left >= -1 && rect.right <= window.innerWidth + 1;
        })
    };
  });
  result.portrait_controls_separated = portrait.separated;
  result.portrait_no_horizontal_overflow = portrait.noHorizontalOverflow;
  result.portrait_controls_inside_viewport = portrait.controlsInsideViewport;
  if (!portrait.separated || !portrait.noHorizontalOverflow || !portrait.controlsInsideViewport) {
    throw new Error(`Portrait layout invalid: ${JSON.stringify(portrait)}`);
  }
  await page.screenshot({ path: "smoke-hoops96-portrait.png", fullPage: true });

  const fatalErrors = pageErrors.filter(message => !/Wake Lock permission request denied/i.test(message));
  if (fatalErrors.length) throw new Error(`Browser errors:\n${fatalErrors.join("\n\n")}`);
} catch (error) {
  result.error = error.stack || String(error);
  await page.screenshot({ path: "smoke-hoops96-failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile("smoke-hoops96-result.json", JSON.stringify(result, null, 2) + "\n");
  await browser.close();
}
