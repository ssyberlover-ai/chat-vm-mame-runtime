"use strict";

const ASSETS = {
  bios: "./bios/seabios.bin",
  vga: "./bios/vgabios.bin",
  freedos: "./images/freedos722.img",
  hdaGzip: "./images/mame-hda.img.gz",
  hdaRaw: "./images/mame-hda.img",
  robbyRaw: "https://raw.githubusercontent.com/mamedev/www.mamedev.org/e27034c7eb14717f287a789ffde35593a4c162f6/roms/robby/robby.zip",
  robbyApi: "https://api.github.com/repos/mamedev/www.mamedev.org/contents/roms/robby/robby.zip?ref=e27034c7eb14717f287a789ffde35593a4c162f6"
};

const $ = selector => document.querySelector(selector);
const statusNode = $("#status");
const progressNode = $("#progress");
const errorNode = $("#error");
const coverNode = $("#cover");
const screenTextNode = $("#screen_container > div:first-child");

let emulator = null;
let prepared = null;
let paused = false;
let bootGeneration = 0;

window.chatVmDiagnostics = {
  get screenText() {
    return screenTextNode?.textContent || "";
  },
  get status() {
    return statusNode?.textContent || "";
  },
  get emulator() {
    return emulator;
  }
};

function setStatus(text, progress) {
  statusNode.textContent = text;
  if (typeof progress === "number") {
    progressNode.hidden = false;
    progressNode.value = progress;
  }
}

function setControlsEnabled(enabled) {
  ["#run", "#info", "#reboot", "#pause", "#full", "#command", "#send"]
    .forEach(selector => {
      const element = $(selector);
      if (element) element.disabled = !enabled;
    });
}

function showError(error) {
  console.error(error);
  setStatus("실행 실패");
  errorNode.textContent = error?.stack || String(error);
  $("#start").disabled = !$("#agree").checked;
}

async function fetchBytes(url, label) {
  setStatus(`${label} 불러오는 중…`);
  const response = await fetch(url, { cache: "no-store", redirect: "follow" });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}\n${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`${label}: 빈 응답`);
  return bytes;
}

async function fetchRobby() {
  try {
    return await fetchBytes(ASSETS.robbyRaw, "Robby Roto ROM");
  } catch (rawError) {
    console.warn("Raw ROM fetch failed; using Contents API", rawError);
    const response = await fetch(ASSETS.robbyApi, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`Robby Roto ROM: GitHub API HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.encoding !== "base64" || !payload.content) {
      throw new Error("Robby Roto ROM: Base64 콘텐츠 없음");
    }
    const clean = payload.content.replace(/\s/g, "");
    return Uint8Array.from(atob(clean), character => character.charCodeAt(0));
  }
}

async function loadHda() {
  if ("DecompressionStream" in window) {
    const compressed = await fetchBytes(ASSETS.hdaGzip, "MAME 실행 디스크");
    setStatus("MAME 실행 디스크 해제 중…");
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return fetchBytes(ASSETS.hdaRaw, "MAME 실행 디스크");
}

function put16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
}

function put32(bytes, offset, value) {
  put16(bytes, offset, value & 0xffff);
  put16(bytes, offset + 2, Math.floor(value / 65536));
}

function putAscii(bytes, offset, text, length) {
  for (let index = 0; index < length; index += 1) {
    bytes[offset + index] = index < text.length
      ? text.charCodeAt(index) & 0xff
      : 0x20;
  }
}

function makeRomDisk(romBytes) {
  const bps = 512;
  const spc = 2;
  const partitionStart = 63;
  const totalSectors = 16 * 2048;
  const partitionSectors = totalSectors - partitionStart;
  const rootEntries = 512;
  const rootSectors = Math.ceil(rootEntries * 32 / bps);
  const reserved = 1;
  const fats = 2;
  let fatSectors = 1;
  let clusterCount = 0;

  for (let iteration = 0; iteration < 10; iteration += 1) {
    clusterCount = Math.floor(
      (partitionSectors - reserved - fats * fatSectors - rootSectors) / spc
    );
    fatSectors = Math.ceil((clusterCount + 2) * 2 / bps);
  }

  const disk = new Uint8Array(totalSectors * bps);
  const p = 446;
  disk[p] = 0x00;
  disk[p + 1] = 0x01;
  disk[p + 2] = 0x01;
  disk[p + 3] = 0x00;
  disk[p + 4] = 0x06;
  disk[p + 5] = 0xfe;
  disk[p + 6] = 0xff;
  disk[p + 7] = 0xff;
  put32(disk, p + 8, partitionStart);
  put32(disk, p + 12, partitionSectors);
  disk[510] = 0x55;
  disk[511] = 0xaa;

  const boot = partitionStart * bps;
  disk.set([0xeb, 0x3c, 0x90], boot);
  putAscii(disk, boot + 3, "MSDOS5.0", 8);
  put16(disk, boot + 11, bps);
  disk[boot + 13] = spc;
  put16(disk, boot + 14, reserved);
  disk[boot + 16] = fats;
  put16(disk, boot + 17, rootEntries);
  put16(disk, boot + 19, 0);
  disk[boot + 21] = 0xf8;
  put16(disk, boot + 22, fatSectors);
  put16(disk, boot + 24, 63);
  put16(disk, boot + 26, 16);
  put32(disk, boot + 28, partitionStart);
  put32(disk, boot + 32, partitionSectors);
  disk[boot + 36] = 0x81;
  disk[boot + 38] = 0x29;
  put32(disk, boot + 39, 0x524f4242);
  putAscii(disk, boot + 43, "ROBBY ROM", 11);
  putAscii(disk, boot + 54, "FAT16", 8);
  disk[boot + 510] = 0x55;
  disk[boot + 511] = 0xaa;

  const fatStart = partitionStart + reserved;
  const rootStart = fatStart + fats * fatSectors;
  const dataStart = rootStart + rootSectors;
  const clusterBytes = spc * bps;
  const count = Math.max(1, Math.ceil(romBytes.length / clusterBytes));
  const fat = new Uint16Array(fatSectors * bps / 2);
  fat[0] = 0xfff8;
  fat[1] = 0xffff;

  for (let index = 0; index < count; index += 1) {
    fat[2 + index] = index === count - 1 ? 0xffff : 3 + index;
  }

  const root = rootStart * bps;
  putAscii(disk, root, "ROBBY", 8);
  putAscii(disk, root + 8, "ZIP", 3);
  disk[root + 11] = 0x20;
  put16(disk, root + 26, 2);
  put32(disk, root + 28, romBytes.length);
  disk.set(romBytes, dataStart * bps);

  const fatBytes = new Uint8Array(fat.buffer);
  for (let index = 0; index < fats; index += 1) {
    disk.set(
      fatBytes.subarray(0, fatSectors * bps),
      (fatStart + index * fatSectors) * bps
    );
  }
  return disk;
}

function getScreenText() {
  return (screenTextNode?.textContent || "").replace(/\u00a0/g, " ");
}

async function waitForScreenText(test, timeoutMs = 70000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const text = getScreenText();
    if (typeof test === "string" ? text.includes(test) : test(text)) {
      return text;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`화면 대기 시간 초과\n현재 화면:\n${getScreenText().slice(-2000)}`);
}

async function prepareAssets() {
  if (typeof window.V86Starter !== "function") {
    throw new Error("v86 런타임을 불러오지 못했습니다.");
  }

  setStatus("실행 자산 준비 중…", 5);
  const [bios, vga, freedos, hda, robby] = await Promise.all([
    fetchBytes(ASSETS.bios, "SeaBIOS"),
    fetchBytes(ASSETS.vga, "VGA BIOS"),
    fetchBytes(ASSETS.freedos, "FreeDOS"),
    loadHda(),
    fetchRobby()
  ]);
  setStatus("Robby Roto ROM 디스크 생성 중…", 72);
  prepared = { bios, vga, freedos, hda, hdb: makeRomDisk(robby) };
}

async function bootVm() {
  if (!prepared) throw new Error("실행 자산이 준비되지 않았습니다.");
  const generation = ++bootGeneration;
  setControlsEnabled(false);
  paused = false;
  $("#pause").textContent = "일시정지";

  if (emulator) {
    try {
      await emulator.stop();
      emulator.destroy();
    } catch (error) {
      console.warn(error);
    }
  }

  errorNode.textContent = "";
  coverNode.hidden = true;
  setStatus("FreeDOS 부팅 중…", 82);

  emulator = new V86Starter({
    memory_size: 64 * 1024 * 1024,
    vga_memory_size: 4 * 1024 * 1024,
    screen_container: $("#screen_container"),
    bios: { buffer: prepared.bios.buffer },
    vga_bios: { buffer: prepared.vga.buffer },
    fda: { buffer: prepared.freedos.buffer },
    hda: { buffer: prepared.hda.buffer },
    hdb: { buffer: prepared.hdb.buffer },
    boot_order: 0x213,
    autostart: true,
    disable_mouse: true,
    disable_speaker: true
  });

  window.mameVm = emulator;
  emulator.add_listener("emulator-ready", () => {
    if (generation === bootGeneration) {
      setStatus("VM 실행 중 · FreeDOS 프롬프트 대기", 90);
    }
  });

  try {
    await waitForScreenText(text => /A:\\?>/i.test(text), 70000);
  } catch (error) {
    console.warn(error);
    setStatus("부팅 확인 지연 · 잠시 후 실행 가능", 96);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  if (generation !== bootGeneration) return;
  setStatus("준비 완료 · Robby Roto 실행을 누르세요", 100);
  progressNode.hidden = true;
  setControlsEnabled(true);
  $("#screen_container").focus();
}

function typeText(text) {
  if (!emulator) return;
  emulator.keyboard_send_text(text);
  $("#screen_container").focus();
}

$("#agree").addEventListener("change", event => {
  $("#start").disabled = !event.target.checked;
});

$("#start").addEventListener("click", async () => {
  $("#start").disabled = true;
  try {
    if (!prepared) await prepareAssets();
    await bootVm();
  } catch (error) {
    showError(error);
  }
});

$("#run").addEventListener("click", () => {
  typeText("C:\nPLAY.BAT\n");
  setStatus("Robby Roto 실행 중…");
});

$("#info").addEventListener("click", () => typeText("C:\nMAMEINFO.BAT\n"));
$("#reboot").addEventListener("click", () => bootVm().catch(showError));
$("#pause").addEventListener("click", async () => {
  if (!emulator) return;
  if (paused) {
    emulator.run();
    paused = false;
    $("#pause").textContent = "일시정지";
  } else {
    await emulator.stop();
    paused = true;
    $("#pause").textContent = "계속";
  }
});
$("#full").addEventListener("click", () => emulator?.screen_go_fullscreen());
$("#send").addEventListener("click", () => {
  typeText($("#command").value + "\n");
  $("#command").value = "";
});
$("#command").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#send").click();
  }
});

const scanCodes = {
  up: [0xe0, 0x48, 0xe0, 0xc8],
  down: [0xe0, 0x50, 0xe0, 0xd0],
  left: [0xe0, 0x4b, 0xe0, 0xcb],
  right: [0xe0, 0x4d, 0xe0, 0xcd],
  enter: [0x1c, 0x9c],
  esc: [0x01, 0x81],
  ctrl: [0x1d, 0x9d],
  alt: [0x38, 0xb8],
  space: [0x39, 0xb9],
  "1": [0x02, 0x82],
  "5": [0x06, 0x86],
  o: [0x18, 0x98],
  k: [0x25, 0xa5]
};

for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("pointerdown", event => {
    event.preventDefault();
    emulator?.keyboard_send_scancodes(scanCodes[button.dataset.key]);
    $("#screen_container").focus();
  });
}

window.addEventListener("error", event => showError(event.error || event.message));
