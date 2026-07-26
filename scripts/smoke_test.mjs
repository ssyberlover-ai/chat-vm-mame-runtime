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
  visible_control_labels: [],
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

async function waitForArcadeCanvas(timeoutMs = 240000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await page.evaluate(() => {
      const canvas = [...document.querySelectorAll("#game canvas")]
        .find(item => item.width > 0 && item.height > 0 && getComputedStyle(item).display !== "none");
      const status = document.querySelector("#status")?.textContent || "";
      const error = document.querySelector("#error")?.textContent || "";
      return {
        canvas: Boolean(canvas),
        status,
        error
      };
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
  throw new Error("Timed out waiting for the WebAssembly MAME canvas");
}

async function testArcadePage() {
  result.mode = "web-mame";
  await page.click("#launch");
  await waitForArcadeCanvas();
  await page.waitForTimeout(10000);

  result.final_status = await page.locator("#status").textContent();
  const errorText = await page.locator("#error").textContent();
  if (errorText || result.final_status.includes("실행 실패")) {
    throw new Error(errorText || result.final_status);
  }

  result.game_canvas = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll("#game canvas")];
    return canvases.some(canvas =>
      canvas.width > 0 &&
      canvas.height > 0 &&
      getComputedStyle(canvas).display !== "none"
    );
  });
  if (!result.game_canvas) {
    throw new Error("EmulatorJS game canvas was not detected");
  }

  result.visible_control_labels = await page.evaluate(() => {
    const wanted = ["FIRE", "FIRE 2", "COIN", "START"];
    const visibleText = [...document.querySelectorAll("#game *")]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 18 &&
          rect.height > 18 &&
          style.display !== "none" &&
          style.visibility !== "hidden";
      })
      .map(element => (element.textContent || "").trim())
      .filter(Boolean);
    return wanted.filter(label => visibleText.some(text => text === label || text.includes(label)));
  });

  result.mobile_controls = ["FIRE", "COIN", "START"]
    .every(label => result.visible_control_labels.includes(label));
  if (!result.mobile_controls) {
    throw new Error(
      `Custom mobile controls were not all visible: ${JSON.stringify(result.visible_control_labels)}`
    );
  }

  for (const label of ["COIN", "START"]) {
    const button = page.getByText(label, { exact: true }).last();
    if (await button.count()) {
      await button.tap({ timeout: 10000 }).catch(() => button.click());
      await page.waitForTimeout(600);
    }
  }

  const fatal = fatalBrowserErrors();
  if (fatal.length) {
    throw new Error(`Browser errors detected:\n${fatal.join("\n\n")}`);
  }

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
} catch (error) {
  result.error = error.stack || String(error);
  await page.screenshot({ path: "smoke-failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  result.final_status = await page.locator("#status").textContent().catch(() => result.final_status);
  await writeFile("smoke-result.json", JSON.stringify(result, null, 2) + "\n");
  await browser.close();
}
