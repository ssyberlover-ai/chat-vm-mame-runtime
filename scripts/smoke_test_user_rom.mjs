import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const targetUrl = process.env.SMOKE_URL || "https://ssyberlover-ai.github.io/chat-vm-mame-runtime/?game=hoops96-user";
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

const result = {
  target_url: targetUrl,
  selected_game: null,
  selected_core: null,
  canvas: false,
  controls: [],
  final_status: "",
  console: consoleLines,
  page_errors: pageErrors
};

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

  await page.waitForTimeout(12000);
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
  if (result.selected_game !== "hoops96-user" || result.selected_core !== "mame2003_plus") {
    throw new Error(`Unexpected runtime diagnostics: ${JSON.stringify(diagnostics)}`);
  }

  result.canvas = await page.evaluate(() =>
    [...document.querySelectorAll("#game canvas")].some(canvas =>
      canvas.width > 0 && canvas.height > 0 && getComputedStyle(canvas).display !== "none"
    )
  );
  if (!result.canvas) throw new Error("MAME canvas was not detected");

  const expected = ["FIRE", "FIRE 2", "COIN", "START"];
  result.controls = await page.evaluate(labels => {
    const visible = [...document.querySelectorAll("#game *")]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 18 && rect.height > 18 &&
          style.display !== "none" && style.visibility !== "hidden";
      })
      .map(element => (element.textContent || "").trim());
    return labels.filter(label => visible.some(text => text === label || text.includes(label)));
  }, expected);

  if (!expected.every(label => result.controls.includes(label))) {
    throw new Error(`Arcade controls were not all visible: ${JSON.stringify(result.controls)}`);
  }

  const fatalErrors = pageErrors.filter(message => !/Wake Lock permission request denied/i.test(message));
  if (fatalErrors.length) throw new Error(`Browser errors:\n${fatalErrors.join("\n\n")}`);

  await page.screenshot({ path: "smoke-hoops96.png", fullPage: true });
} catch (error) {
  result.error = error.stack || String(error);
  await page.screenshot({ path: "smoke-hoops96-failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile("smoke-hoops96-result.json", JSON.stringify(result, null, 2) + "\n");
  await browser.close();
}
