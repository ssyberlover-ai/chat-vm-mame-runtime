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
  mode: "web-emulator",
  selected_game: "",
  selected_core: "",
  hosted_rom: false,
  game_canvas: false,
  mobile_controls: false,
  visible_control_labels: [],
  virtual_gamepad_display: "",
  final_status: "",
  browser_errors: browserErrors,
  console: consoleLines
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function fatalBrowserErrors() {
  return browserErrors.filter(message =>
    !/Wake Lock permission request denied/i.test(message)
  );
}

async function waitForCanvas(timeoutMs = 240000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await page.evaluate(() => {
      const canvas = [...document.querySelectorAll("#game canvas")]
        .find(item => item.width > 0 && item.height > 0 && getComputedStyle(item).display !== "none");
      const status = document.querySelector("#status")?.textContent || "";
      const error = document.querySelector("#error")?.textContent || "";
      return { canvas: Boolean(canvas), status, error };
    });

    if (state.error || state.status.includes("실행 실패")) {
      throw new Error(state.error || state.status);
    }
    if (consoleLines.some(line => line.includes("Failed to start game"))) {
      throw new Error("EmulatorJS core reported: Failed to start game");
    }
    if (state.canvas) return;
    await sleep(400);
  }
  throw new Error("Timed out waiting for the WebAssembly emulator canvas");
}

async function visibleLabels(wanted) {
  return page.evaluate(labels => {
    const visibleText = [...document.querySelectorAll("#game *")]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 18 && rect.height > 18 &&
          style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0;
      })
      .map(element => (element.textContent || "").trim())
      .filter(Boolean);
    return labels.filter(label => visibleText.some(text => text === label || text.includes(label)));
  }, wanted);
}

try {
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });
  result.page_loaded = true;

  await page.waitForFunction(() => {
    const checked = document.querySelector('#catalog input[name="game"]:checked');
    const status = document.querySelector("#status")?.textContent || "";
    return Boolean(checked) && !status.includes("불러오는 중");
  }, null, { timeout: 60000, polling: 250 });

  const selectedBeforeLaunch = await page.locator('#catalog input[name="game"]:checked').inputValue();
  if (selectedBeforeLaunch !== "cybercoaster") {
    throw new Error(`Expected default hosted ROM cybercoaster, got ${selectedBeforeLaunch}`);
  }

  await page.check("#agree");
  await page.click("#launch");
  await waitForCanvas();
  await page.setViewportSize({ width: 900, height: 430 });
  await page.waitForTimeout(2200);

  const diagnostics = await page.evaluate(() => window.webEmulatorDiagnostics || null);
  if (!diagnostics?.ready) throw new Error("Runtime diagnostics were not initialized");
  result.selected_game = diagnostics.id;
  result.selected_core = diagnostics.core;
  result.hosted_rom = Boolean(diagnostics.hosted);

  if (result.selected_game !== "cybercoaster" || result.selected_core !== "fceumm" || !result.hosted_rom) {
    throw new Error(`Unexpected runtime selection: ${JSON.stringify(diagnostics)}`);
  }

  result.final_status = await page.locator("#status").textContent();
  const errorText = await page.locator("#error").textContent();
  if (errorText || result.final_status.includes("실행 실패")) {
    throw new Error(errorText || result.final_status);
  }

  result.game_canvas = await page.evaluate(() =>
    [...document.querySelectorAll("#game canvas")].some(canvas =>
      canvas.width > 0 && canvas.height > 0 && getComputedStyle(canvas).display !== "none"
    )
  );
  if (!result.game_canvas) throw new Error("EmulatorJS game canvas was not detected");

  const expectedControls = ["A", "B", "SELECT", "START"];
  await page.waitForFunction(labels => {
    const visibleText = [...document.querySelectorAll("#game *")]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 18 && rect.height > 18 &&
          style.display !== "none" && style.visibility !== "hidden";
      })
      .map(element => (element.textContent || "").trim());
    return labels.every(label => visibleText.some(text => text === label || text.includes(label)));
  }, expectedControls, { timeout: 30000, polling: 300 });

  result.visible_control_labels = await visibleLabels(expectedControls);
  result.virtual_gamepad_display = await page.evaluate(() => {
    const gamepad = window.EJS_emulator?.virtualGamepad;
    return gamepad ? getComputedStyle(gamepad).display : "missing";
  });
  result.mobile_controls = expectedControls.every(label => result.visible_control_labels.includes(label));
  if (!result.mobile_controls) {
    throw new Error(`Console controls were not all visible: ${JSON.stringify(result.visible_control_labels)}`);
  }

  const startButton = page.getByText("START", { exact: true }).last();
  if (await startButton.count()) {
    await startButton.tap({ timeout: 10000 }).catch(() => startButton.click());
    await page.waitForTimeout(1000);
  }

  const fatal = fatalBrowserErrors();
  if (fatal.length) throw new Error(`Browser errors detected:\n${fatal.join("\n\n")}`);

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
