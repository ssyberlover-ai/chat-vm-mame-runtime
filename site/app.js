"use strict";

(() => {
  const ROBBY = {
    id: "robby",
    title: "Robby Roto",
    platform: "Arcade",
    core: "mame2003_plus",
    url: "https://raw.githubusercontent.com/mamedev/www.mamedev.org/e27034c7eb14717f287a789ffde35593a4c162f6/roms/robby/robby.zip",
    license: "MAMEdev 비상업 사용",
    developer: "Bally/Midway",
    release_date: "1981",
    source_page: "https://www.mamedev.org/roms/robby/",
    hosted: false,
    control_profile: "arcade"
  };

  const $ = selector => document.querySelector(selector);
  const catalogNode = $("#catalog");
  const agree = $("#agree");
  const agreeText = $("#agree-text");
  const launch = $("#launch");
  const shell = $("#game-shell");
  const status = $("#status");
  const selection = $("#selection");
  const error = $("#error");
  const touchControls = $("#touch-controls");
  const directionControl = $("#direction-control");
  const systemPad = $("#system-pad");
  const actionPad = $("#action-pad");

  let games = [ROBBY];
  let selected = null;
  let loading = false;
  const inputRefs = new Map();
  const pointerStates = new Map();
  const inputEvents = [];

  window.touchControlDiagnostics = {
    visible: false,
    profile: null,
    serviceEvents: 0,
    resetEvents: 0,
    coinEvents: 0,
    startEvents: 0,
    stickEvents: 0,
    events: inputEvents
  };

  function fail(reason) {
    console.error(reason);
    status.textContent = "실행 실패";
    error.textContent = reason?.stack || String(reason);
    launch.disabled = !agree.checked || !selected;
    loading = false;
  }

  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function isTouchEnvironment() {
    const params = new URLSearchParams(location.search);
    return params.get("touch") === "1" || navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches;
  }

  function renderCatalog() {
    catalogNode.innerHTML = games.map(game => {
      const source = game.source_page
        ? `<a class="game-source" href="${escapeText(game.source_page)}" target="_blank" rel="noopener">출처·라이선스 확인</a>`
        : "";
      const hosted = game.hosted === false ? "공식 원격 파일" : "저장소 포함";
      const licenseClass = game.user_supplied ? "game-license user" : "game-license";
      const licenseText = game.user_supplied ? "사용자 제공 ROM" : game.license;
      return `<label class="game-card">
        <input type="radio" name="game" value="${escapeText(game.id)}">
        <span class="game-title">${escapeText(game.title)}</span>
        <span class="game-meta">${escapeText(game.platform)} · ${escapeText(game.developer)}<br>${hosted}${game.release_date ? ` · ${escapeText(game.release_date)}` : ""}</span>
        <span class="${licenseClass}">${escapeText(licenseText)}</span>
        ${source}
      </label>`;
    }).join("");

    catalogNode.querySelectorAll('input[name="game"]').forEach(input => {
      input.addEventListener("change", () => selectGame(input.value));
    });

    const requested = new URLSearchParams(location.search).get("game");
    const preferred = games.find(game => game.id === requested)
      || games.find(game => game.id === "cybercoaster")
      || games[0];
    const input = catalogNode.querySelector(`input[value="${CSS.escape(preferred.id)}"]`);
    if (input) {
      input.checked = true;
      selectGame(preferred.id);
    }
  }

  function selectGame(id) {
    selected = games.find(game => game.id === id) || null;
    agree.checked = false;
    launch.disabled = true;
    error.textContent = "";
    if (!selected) return;
    agreeText.textContent = selected.user_supplied
      ? `${selected.title} ROM을 직접 제공했으며 사용할 권한이 있음을 확인합니다.`
      : `${selected.title}의 ${selected.license} 조건과 저작권 고지를 확인했습니다.`;
    selection.textContent = `${selected.title} · ${selected.platform}`;
    status.textContent = "게임 선택 완료";
  }

  agree.addEventListener("change", () => {
    launch.disabled = !agree.checked || loading || !selected;
  });

  function inputButton({ id, label, hint = "", inputs = [], key = "", command = "", className = "" }) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = id;
    button.className = `pad-key ${className}`.trim();
    button.dataset.inputs = inputs.join(",");
    if (key) button.dataset.key = key;
    if (command) button.dataset.command = command;
    button.setAttribute("aria-label", hint ? `${label} ${hint}` : label);
    button.innerHTML = `<span>${escapeText(label)}${hint ? `<span class="control-hint">${escapeText(hint)}</span>` : ""}</span>`;
    return button;
  }

  function simulateInput(index, value) {
    const manager = window.EJS_emulator?.gameManager;
    if (!manager?.simulateInput) return false;
    manager.simulateInput(0, index, value);
    inputEvents.push({ index, value, at: Date.now() });
    if (inputEvents.length > 120) inputEvents.splice(0, inputEvents.length - 120);
    return true;
  }

  function sameIndexes(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function holdInputs(pointerId, button, indexes) {
    const previous = pointerStates.get(pointerId);
    if (previous && previous.button === button && sameIndexes(previous.indexes, indexes)) return;
    releasePointer(pointerId);
    for (const index of indexes) {
      const count = inputRefs.get(index) || 0;
      inputRefs.set(index, count + 1);
      if (count === 0) simulateInput(index, 1);
    }
    pointerStates.set(pointerId, { button, indexes });
    button.classList.add("is-pressed");
    if (button.closest(".action-pad.arcade")) {
      try { navigator.vibrate?.(12); } catch {}
    }
  }

  function releasePointer(pointerId) {
    const state = pointerStates.get(pointerId);
    if (!state) return;
    for (const index of state.indexes) {
      const next = Math.max(0, (inputRefs.get(index) || 1) - 1);
      if (next === 0) {
        inputRefs.delete(index);
        simulateInput(index, 0);
      } else {
        inputRefs.set(index, next);
      }
    }
    state.button.classList.remove("is-pressed");
    pointerStates.delete(pointerId);
  }

  function centerArcadeStick() {
    const stick = directionControl.querySelector(".arcade-stick");
    if (!stick) return;
    stick.style.setProperty("--stick-x", "0px");
    stick.style.setProperty("--stick-y", "0px");
    stick.classList.remove("is-pressed");
  }

  function releaseAllInputs() {
    for (const pointerId of [...pointerStates.keys()]) releasePointer(pointerId);
    for (const index of [...inputRefs.keys()]) simulateInput(index, 0);
    inputRefs.clear();
    touchControls.querySelectorAll(".is-pressed").forEach(button => button.classList.remove("is-pressed"));
    centerArcadeStick();
  }

  function arcadeStickInputs(dx, dy, deadZone) {
    if (Math.hypot(dx, dy) < deadZone) return [];
    const sector = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
    return [[7], [5, 7], [5], [5, 6], [6], [4, 6], [4], [4, 7]][sector];
  }

  function buildArcadeStick() {
    directionControl.className = "control-surface arcade-stick";
    directionControl.setAttribute("aria-label", "8방향 아케이드 스틱");
    const cross = document.createElement("span");
    cross.className = "stick-cross";
    const knob = document.createElement("span");
    knob.className = "stick-knob";
    directionControl.replaceChildren(cross, knob);
    centerArcadeStick();

    const update = event => {
      const rect = directionControl.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy);
      const maxTravel = rect.width * .255;
      const scale = distance > maxTravel ? maxTravel / distance : 1;
      directionControl.style.setProperty("--stick-x", `${dx * scale}px`);
      directionControl.style.setProperty("--stick-y", `${dy * scale}px`);
      directionControl.classList.add("is-pressed");
      holdInputs(event.pointerId, directionControl, arcadeStickInputs(dx, dy, rect.width * .15));
      window.touchControlDiagnostics.stickEvents += 1;
    };

    directionControl.onpointerdown = event => {
      event.preventDefault();
      try { directionControl.setPointerCapture(event.pointerId); } catch {}
      update(event);
      try { navigator.vibrate?.(8); } catch {}
    };
    directionControl.onpointermove = event => {
      if (pointerStates.get(event.pointerId)?.button === directionControl) update(event);
    };
    const stop = event => {
      releasePointer(event.pointerId);
      centerArcadeStick();
    };
    directionControl.onpointerup = stop;
    directionControl.onpointercancel = stop;
    directionControl.onlostpointercapture = stop;
  }

  function buildConsoleDpad() {
    directionControl.className = "control-surface console-dpad";
    directionControl.setAttribute("aria-label", "8방향 패드");
    const directions = [
      ["↖", [4, 6], "왼쪽 위"], ["↑", [4], "위"], ["↗", [4, 7], "오른쪽 위"],
      ["←", [6], "왼쪽"], ["", [], ""], ["→", [7], "오른쪽"],
      ["↙", [5, 6], "왼쪽 아래"], ["↓", [5], "아래"], ["↘", [5, 7], "오른쪽 아래"]
    ];
    directionControl.replaceChildren(...directions.map(([label, inputs, hint], index) => {
      if (!inputs.length) {
        const center = document.createElement("span");
        center.className = "dpad-center";
        return center;
      }
      return inputButton({ id: `touch-dir-${index}`, label, hint, inputs, className: "direction-key" });
    }));
    directionControl.onpointerdown = null;
    directionControl.onpointermove = null;
    directionControl.onpointerup = null;
    directionControl.onpointercancel = null;
    directionControl.onlostpointercapture = null;
  }

  function buildTouchControls(game) {
    systemPad.replaceChildren();
    actionPad.replaceChildren();
    const arcade = game.control_profile === "arcade";
    actionPad.className = `action-pad ${arcade ? "arcade" : "console"}`;

    if (arcade) {
      buildArcadeStick();
      actionPad.append(
        inputButton({ id: "touch-b1", label: "B1", hint: "버튼 1", inputs: [0], className: "action-1" }),
        inputButton({ id: "touch-b2", label: "B2", hint: "버튼 2", inputs: [8], className: "action-2" }),
        inputButton({ id: "touch-b3", label: "B3", hint: "버튼 3", inputs: [1], className: "action-3" })
      );
      systemPad.append(
        inputButton({ id: "touch-test", label: "TEST", hint: "초기 설정", key: "F2", className: "test-key" }),
        inputButton({ id: "touch-reset", label: "RESET", hint: "재부팅", command: "restart" }),
        inputButton({ id: "touch-coin", label: "COIN", command: "coin" }),
        inputButton({ id: "touch-start", label: "START", command: "start" })
      );
    } else {
      buildConsoleDpad();
      if (game.core === "mgba") {
        actionPad.append(
          inputButton({ id: "touch-l", label: "L", inputs: [10], className: "shoulder" }),
          inputButton({ id: "touch-r", label: "R", inputs: [11], className: "shoulder" })
        );
      }
      actionPad.append(
        inputButton({ id: "touch-b", label: "B", inputs: [0] }),
        inputButton({ id: "touch-a", label: "A", inputs: [8] })
      );
      systemPad.append(
        inputButton({ id: "touch-select", label: "SELECT", inputs: [2] }),
        inputButton({ id: "touch-start", label: "START", inputs: [3] })
      );
    }

    const visible = isTouchEnvironment();
    document.body.classList.toggle("touch-ui", visible);
    touchControls.hidden = !visible;
    window.touchControlDiagnostics.visible = visible;
    window.touchControlDiagnostics.profile = arcade ? "arcade" : "console";
  }

  function createKeyboardEvent(type, key, code, keyCode) {
    const event = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
    try {
      Object.defineProperties(event, {
        keyCode: { get: () => keyCode },
        which: { get: () => keyCode }
      });
    } catch {}
    return event;
  }

  function sendMameKey(key, code, keyCode, duration = 260) {
    const emulator = window.EJS_emulator;
    const manager = emulator?.gameManager;
    try { manager?.functions?.setKeyboardEnabled?.(1); } catch {}
    const target = emulator?.canvas || document.querySelector("#game canvas") || document;
    try { target.focus?.({ preventScroll: true }); } catch { target.focus?.(); }
    target.dispatchEvent(createKeyboardEvent("keydown", key, code, keyCode));
    setTimeout(() => target.dispatchEvent(createKeyboardEvent("keyup", key, code, keyCode)), duration);
  }

  function runCommand(button) {
    const command = button.dataset.command;
    if (command === "restart") {
      window.EJS_emulator?.gameManager?.restart?.();
      window.touchControlDiagnostics.resetEvents += 1;
    } else if (command === "coin") {
      sendMameKey("5", "Digit5", 53, 420);
      window.touchControlDiagnostics.coinEvents += 1;
    } else if (command === "start") {
      sendMameKey("1", "Digit1", 49, 420);
      window.touchControlDiagnostics.startEvents += 1;
    } else if (button.dataset.key === "F2") {
      sendMameKey("F2", "F2", 113, 180);
      window.touchControlDiagnostics.serviceEvents += 1;
    }
  }

  touchControls.addEventListener("pointerdown", event => {
    const button = event.target.closest(".pad-key");
    if (!button || !touchControls.contains(button)) return;
    event.preventDefault();
    try { button.setPointerCapture(event.pointerId); } catch {}
    if (button.dataset.command || button.dataset.key) {
      button.classList.add("is-pressed");
      pointerStates.set(event.pointerId, { button, indexes: [] });
      runCommand(button);
      try { navigator.vibrate?.(10); } catch {}
      return;
    }
    const indexes = button.dataset.inputs.split(",").filter(Boolean).map(Number);
    if (indexes.length) holdInputs(event.pointerId, button, indexes);
  });

  touchControls.addEventListener("pointermove", event => {
    const state = pointerStates.get(event.pointerId);
    if (!state || !state.button.classList.contains("direction-key")) return;
    const next = document.elementFromPoint(event.clientX, event.clientY)?.closest(".direction-key");
    if (!next || next === state.button) return;
    holdInputs(event.pointerId, next, next.dataset.inputs.split(",").filter(Boolean).map(Number));
  });

  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    touchControls.addEventListener(type, event => releasePointer(event.pointerId));
  }
  window.addEventListener("blur", releaseAllInputs);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAllInputs();
  });

  function disableBuiltInVirtualGamepad() {
    const emulator = window.EJS_emulator;
    if (!emulator) return;
    try { emulator.toggleVirtualGamepad?.(false); } catch {}
    try { emulator.changeSettingOption?.("virtual-gamepad", "disabled", true); } catch {}
    if (emulator.virtualGamepad) emulator.virtualGamepad.style.display = "none";
  }

  function startSelectedGame() {
    if (loading || !agree.checked || !selected) return;
    loading = true;
    launch.disabled = true;
    status.textContent = `${selected.title} 코어 로딩 중…`;
    error.textContent = "";
    shell.hidden = false;
    document.body.classList.add("running");
    buildTouchControls(selected);

    window.EJS_player = "#game";
    window.EJS_core = selected.core;
    window.EJS_gameName = selected.rom_name || (selected.id === "robby" ? "robby" : selected.title);
    window.EJS_gameUrl = selected.url;
    window.EJS_pathtodata = "https://cdn.emulatorjs.org/4.2.3/data/";
    window.EJS_startOnLoaded = true;
    window.EJS_fullscreenOnLoaded = false;
    window.EJS_controlScheme = selected.control_profile === "arcade" ? "mame" : undefined;
    window.EJS_gameID = selected.id;
    window.EJS_backgroundColor = "#000";
    window.EJS_disableAutoLang = true;
    window.EJS_language = "en-US";
    window.EJS_askBeforeExit = false;
    window.EJS_noAutoFocus = false;
    window.EJS_AdUrl = "";
    if (isTouchEnvironment()) window.EJS_browserMode = "mobile";
    window.EJS_VirtualGamepadSettings = [];
    window.EJS_Buttons = {
      playPause: true,
      restart: true,
      mute: true,
      settings: true,
      fullscreen: true,
      saveState: true,
      loadState: true,
      screenRecord: false,
      gamepad: true,
      cheat: false,
      volume: true,
      saveSavFiles: false,
      loadSavFiles: false,
      quickSave: true,
      quickLoad: true,
      screenshot: true,
      cacheManager: false,
      exitEmulation: false
    };

    window.EJS_ready = () => {
      disableBuiltInVirtualGamepad();
      status.textContent = "코어 준비 완료";
    };
    window.EJS_onGameStart = () => {
      loading = false;
      disableBuiltInVirtualGamepad();
      setTimeout(disableBuiltInVirtualGamepad, 250);
      setTimeout(disableBuiltInVirtualGamepad, 1000);
      status.textContent = `${selected.title} 실행 중`;
      window.webEmulatorDiagnostics = {
        ready: true,
        id: selected.id,
        core: selected.core,
        hosted: selected.hosted !== false,
        hasEmulator: Boolean(window.EJS_emulator),
        customTouchControls: window.touchControlDiagnostics.visible,
        controlProfile: window.touchControlDiagnostics.profile
      };
    };

    const loader = document.createElement("script");
    loader.src = "https://cdn.emulatorjs.org/4.2.3/data/loader.js";
    loader.async = true;
    loader.onerror = () => fail(new Error("EmulatorJS 로더를 가져오지 못했습니다."));
    document.body.appendChild(loader);
  }

  window.addEventListener("error", event => {
    const message = String(event.error?.message || event.message || "");
    if (/Wake Lock permission request denied/i.test(message)) return;
    if (loading) fail(event.error || event.message);
  });

  launch.addEventListener("click", startSelectedGame);

  (async () => {
    try {
      const response = await fetch("./roms/manifest.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`ROM 카탈로그 HTTP ${response.status}`);
      const manifest = await response.json();
      const hostedGames = manifest.games.map(game => ({
        ...game,
        hosted: true,
        control_profile: game.control_profile || (game.core === "mame2003_plus" ? "arcade" : "console")
      }));
      games = [...hostedGames, ROBBY];
      status.textContent = `${hostedGames.length}개 ROM 준비 완료`;
    } catch (reason) {
      console.warn(reason);
      status.textContent = "ROM 목록 실패 · Robby Roto만 사용 가능";
      games = [ROBBY];
    }
    renderCatalog();
  })();
})();
