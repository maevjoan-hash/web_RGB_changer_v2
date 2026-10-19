// --- ПОДСВЕТКА НА LOGITECH КЛАВИАТУРА (напр. G515 TKL) ПРЕЗ HID++ 2.0 ---
// 0x8071 RGBEffects: ефект за целия клъстер (статичен, дишане, цикъл, вълна, изключено)
// 0x8081 PerKeyLighting v2: цвят за всеки клавиш; вижда се само при статичен ефект
// 0x8040 BrightnessControl: яркост
// За да покаже подсветката на сайта, клавиатурата минава в режим „host“ (0x8101 fn6 [05]) и сайтът
// поема клъстерите (0x8071 fn5 [01 03 00]). „Върни подсветката от паметта“ отменя това.
// Протоколът следва бележките на logirgb (github.com/mevdschee/logirgb/tree/main/research), Solaar и OpenRGB.
(() => {
  const device = document.querySelector('.keyboard');
  const bar = document.querySelector('[data-device-actions]');
  if (!device || !bar || typeof LogitechHidpp === 'undefined') return;

  const { FEATURES } = LogitechHidpp;
  const KEEPALIVE_MS = 5000;

  // Ефектите на сайта → ID на ефект в 0x8071 (първият, който клавиатурата поддържа)
  const EFFECT_IDS = {
    off: [0x00],
    static: [0x01],
    breathing: [0x0a, 0x02],
    spectrum: [0x15, 0x03],
    wave: [0x16, 0x04]
  };

  // Зони на клавишите (0x8081): HID кодът на клавиша − 3; модификаторите (0xE0–0xE7) − 0x78
  const ZONES = {
    Enter: 37, Esc: 38, Backspace: 39, Tab: 40, Space: 41, '-': 42, '=': 43, '[': 44, ']': 45, '\\': 46,
    ';': 48, "'": 49, '`': 50, ',': 51, '.': 52, '/': 53, Caps: 54, PrtSc: 67, ScrLk: 68, Pause: 69,
    Ins: 70, Home: 71, PgUp: 72, Del: 73, End: 74, PgDn: 75, '→': 76, '←': 77, '↓': 78, '↑': 79, Menu: 98,
    Ctrl: 104, Shift: 105, Alt: 106, Win: 107, 'Ctrl#2': 108, 'Shift#2': 109, 'Alt#2': 110, 'Win#2': 111
  };
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((letter, index) => {
    ZONES[letter] = 1 + index;
  });
  '1234567890'.split('').forEach((digit, index) => {
    ZONES[digit] = 27 + index;
  });
  for (let n = 1; n <= 12; n += 1) ZONES[`F${n}`] = 54 + n;

  bar.innerHTML = `
    <div class="device-bar">
      <div class="panel-actions save-bar__row">
        <button type="button" class="panel-btn panel-btn--primary" data-device-action="connect">Свържи клавиатурата</button>
        <span class="save-bar__group" data-connected hidden>
          <button type="button" class="panel-btn panel-btn--primary" data-device-action="apply">Приложи подсветката</button>
          <label class="live-toggle"><input type="checkbox" id="kb-live" checked /> На живо</label>
          <button type="button" class="panel-btn" data-device-action="release">Върни подсветката от паметта</button>
          <button type="button" class="panel-btn" data-device-action="copy-diagnostics">Техническа информация</button>
          <button type="button" class="panel-btn" data-device-action="disconnect">Прекъсни</button>
        </span>
      </div>
      <p class="device-summary" id="kb-summary" hidden></p>
      <p class="device-log" id="device-log" role="status"></p>
      ${LogitechHelp.html('клавиатурата')}
    </div>
  `;
  LogitechHelp.setup(bar);

  const deviceBar = bar.querySelector('.device-bar');
  const connectButton = bar.querySelector('[data-device-action="connect"]');
  const connectedGroup = bar.querySelector('[data-connected]');
  const liveInput = bar.querySelector('#kb-live');
  const summary = bar.querySelector('#kb-summary');
  const log = bar.querySelector('#device-log');
  const help = bar.querySelector('#device-help');

  let keyboard = null;
  let effectIndexes = new Map();
  let hasPerKey = false;
  let hasBrightness = false;
  let claimed = false;
  let lastSent = '';
  let applying = false;
  let pendingApply = false;
  let applyTimer = null;
  let keepaliveTimer = null;
  let diagnostics = {};
  const events = [];

  const setLog = (message, isError = false) => {
    log.textContent = message;
    log.classList.toggle('device-log--error', isError);
    events.push(`${new Date().toLocaleTimeString('bg-BG')}${isError ? ' [грешка]' : ''} ${message}`);
    if (events.length > 30) events.shift();
  };

  const wait = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  // Клавиатурата отговаря „заето“, докато обработва предишен кадър – тогава се опитва пак
  const send = async (featureId, fn, params = []) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await keyboard.call(featureId, fn, params);
      } catch (error) {
        if (attempt >= 4 || !error.message.includes('заето')) throw error;
        await wait(40 * attempt);
      }
    }
  };

  const rgb = (color) => [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));

  // --- ПОЕМАНЕ И ВРЪЩАНЕ НА УПРАВЛЕНИЕТО ---
  const claim = async () => {
    if (await keyboard.supports(FEATURES.PROFILE_MANAGEMENT)) await send(FEATURES.PROFILE_MANAGEMENT, 0x60, [0x05]);
    await send(FEATURES.RGB_EFFECTS, 0x50, [0x01, 0x03, 0x00]);
    claimed = true;
  };

  const release = async () => {
    claimed = false;
    lastSent = '';
    await send(FEATURES.RGB_EFFECTS, 0x50, [0x01, 0x00, 0x00]);
    if (await keyboard.supports(FEATURES.PROFILE_MANAGEMENT)) await send(FEATURES.PROFILE_MANAGEMENT, 0x60, [0x03]);
  };

  // Ефектите в клавиатурата се избират по индекс; индексите се четат по ID на ефекта (0x8071 getInfo)
  const readEffects = async () => {
    const cluster = await send(FEATURES.RGB_EFFECTS, 0x00, [0x00, 0xff, 0x00]);
    const count = cluster[4];
    const indexes = new Map();
    for (let index = 0; index < count; index += 1) {
      const info = await send(FEATURES.RGB_EFFECTS, 0x00, [0x00, index, 0x00]);
      indexes.set((info[2] << 8) | info[3], index);
    }
    return indexes;
  };

  // 10 байта параметри за ефекта (оформлението е от спецификацията на 0x8071)
  const effectParams = (effectId, color, periodMs) => {
    const [r, g, b] = rgb(color);
    const hi = (periodMs >> 8) & 0xff;
    const lo = periodMs & 0xff;
    switch (effectId) {
      case 0x01: return [r, g, b, 0x02];
      case 0x02: return [r, g, b, hi, lo];
      case 0x0a: return [r, g, b, hi, lo, 0x00, 100];
      case 0x03: return [0, 0, 0, 0, 0, hi, lo, 100];
      case 0x15: return [0, 0xff, 0, 0, 0, 0, hi, lo, 100];
      case 0x04: return [r, g, b, r, g, b, lo, 0x01, 100, hi];
      case 0x16: return [0, 0xff, 0, 0, 0, 0, hi, lo, 100, 0x01];
      default: return [];
    }
  };

  // Цвят за всеки клавиш: първо всички зони в основния цвят (иначе незаписаните светват в бяло),
  // после клавишите с различен цвят на групи по 13 и накрая frameEnd, който показва кадъра
  const sendPerKeyFrame = async (lighting) => {
    const [r, g, b] = rgb(lighting.color);
    await send(FEATURES.PER_KEY_LIGHTING, 0x50, [1, 111, r, g, b]);

    const groups = new Map();
    Object.entries(lighting.leds).forEach(([keyId, color]) => {
      const zone = ZONES[keyId];
      if (!zone || color === lighting.color) return;
      if (!groups.has(color)) groups.set(color, []);
      groups.get(color).push(zone);
    });

    for (const [color, zones] of groups) {
      for (let start = 0; start < zones.length; start += 13) {
        await send(FEATURES.PER_KEY_LIGHTING, 0x60, [...rgb(color), ...zones.slice(start, start + 13)]);
      }
    }
    await send(FEATURES.PER_KEY_LIGHTING, 0x70, [0x00, 0x00, 0x00, 0x00, 0x00]);
  };

  const applyLighting = async () => {
    const lighting = window.RgbChanger?.getLighting?.();
    if (!lighting) return;

    const effectId = EFFECT_IDS[lighting.effect].find((id) => effectIndexes.has(id));
    if (effectId === undefined) throw new Error('Клавиатурата не поддържа този ефект.');

    if (!claimed) await claim();
    const params = effectParams(effectId, lighting.color, lighting.periodMs);
    const payload = [0x00, effectIndexes.get(effectId), ...params, ...Array(10 - params.length).fill(0), 0x01];
    await send(FEATURES.RGB_EFFECTS, 0x10, payload);

    if (hasPerKey && lighting.effect === 'static') await sendPerKeyFrame(lighting);
    if (hasBrightness) await send(FEATURES.BRIGHTNESS, 0x20, [0x00, lighting.brightness]);

    lastSent = JSON.stringify(lighting);
    diagnostics.lastApplied = { ...lighting, effectId, effectIndex: effectIndexes.get(effectId) };
  };

  // --- СВЪРЗВАНЕ ---
  const showConnected = (isConnected) => {
    connectButton.hidden = isConnected;
    connectedGroup.hidden = !isConnected;
    summary.hidden = !isConnected;
  };

  const connect = async () => {
    const found = await LogitechHidpp.requestDevice();
    if (!found) return;
    keyboard = found;
    help.hidden = true;
    setLog('Чета информацията от клавиатурата…');

    if (!(await keyboard.supports(FEATURES.RGB_EFFECTS))) {
      await keyboard.close();
      keyboard = null;
      throw new Error('Това устройство няма управление на подсветката (0x8071).');
    }

    const name = await keyboard.readName().catch(() => 'Logitech клавиатура');
    const battery = await keyboard.supports(FEATURES.UNIFIED_BATTERY)
      ? await keyboard.readBattery().catch(() => null)
      : null;
    effectIndexes = await readEffects();
    hasPerKey = await keyboard.supports(FEATURES.PER_KEY_LIGHTING);
    hasBrightness = await keyboard.supports(FEATURES.BRIGHTNESS);
    claimed = false;
    lastSent = '';

    diagnostics = {
      name,
      deviceIndex: keyboard.index,
      userAgent: navigator.userAgent,
      effects: Object.fromEntries([...effectIndexes].map(([id, index]) => [`0x${id.toString(16).padStart(2, '0')}`, index])),
      perKey: hasPerKey,
      brightness: hasBrightness
    };

    const connection = keyboard.index === 0xff ? 'Bluetooth или кабел' : 'безжичен приемник';
    const batteryText = battery ? ` · батерия ${battery.percent}%${battery.charging ? ' (зарежда)' : ''}` : '';
    summary.textContent = `${name} · ${connection}${batteryText}`;
    showConnected(true);

    await applyLighting();
    keepaliveTimer = setInterval(keepalive, KEEPALIVE_MS);
    setLog('Клавиатурата показва подсветката от сайта.');
  };

  // Поддържа управлението – някои фърмуери връщат подсветката от паметта, ако сайтът замълчи
  const keepalive = () => {
    if (!keyboard || !claimed || applying) return;
    send(FEATURES.RGB_EFFECTS, 0x50, [0x01, 0x03, 0x00]).catch(() => {});
  };

  const disconnect = async () => {
    clearInterval(keepaliveTimer);
    if (keyboard && claimed) await release().catch(() => {});
    await keyboard?.close();
    keyboard = null;
    showConnected(false);
    setLog('Връзката е прекъсната. Клавиатурата показва подсветката от паметта си.');
  };

  // --- НА ЖИВО: всяка промяна на подсветката на сайта отива към клавиатурата ---
  const scheduleApply = () => {
    if (!keyboard || !liveInput.checked) return;
    clearTimeout(applyTimer);
    applyTimer = setTimeout(async () => {
      const lighting = window.RgbChanger?.getLighting?.();
      if (!lighting || JSON.stringify(lighting) === lastSent) return;
      if (applying) {
        pendingApply = true;
        return;
      }
      applying = true;
      try {
        await applyLighting();
      } catch (error) {
        console.error(error);
        setLog(error.message || String(error), true);
      } finally {
        applying = false;
        if (pendingApply) {
          pendingApply = false;
          scheduleApply();
        }
      }
    }, 120);
  };

  device.addEventListener('rgbchange', scheduleApply);

  // --- БУТОНИ ---
  let busy = false;
  const run = (action) => async () => {
    if (busy) return;
    busy = true;
    deviceBar.classList.add('is-busy');
    try {
      await action();
    } catch (error) {
      console.error(error, error.cause);
      setLog(error.message || String(error), true);
      if (error.code === 'open-failed') help.hidden = false;
    } finally {
      busy = false;
      deviceBar.classList.remove('is-busy');
    }
  };

  const actions = {
    connect: run(connect),
    apply: run(async () => {
      applying = true;
      try {
        await applyLighting();
      } finally {
        applying = false;
      }
      setLog('Подсветката е приложена.');
    }),
    release: run(async () => {
      await release();
      setLog('Клавиатурата показва подсветката от паметта си. „Приложи подсветката“ я поема отново.');
    }),
    'copy-diagnostics': run(async () => {
      if (keyboard) {
        diagnostics.features = Object.fromEntries(Object.entries(FEATURES).map(
          ([featureName, id]) => [featureName, keyboard.featureIndexes.get(id) ?? 'не е проверена']
        ));
      }
      diagnostics.events = events;
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setLog('Техническата информация е копирана.');
    }),
    'copy-commands': run(async () => {
      await navigator.clipboard.writeText(LogitechHelp.LINUX_COMMANDS);
      setLog('Командите са копирани. Постави ги в терминала.');
    }),
    disconnect: run(disconnect)
  };

  bar.addEventListener('click', (event) => {
    const action = event.target.closest('[data-device-action]')?.dataset.deviceAction;
    if (action) actions[action]();
  });

  liveInput.addEventListener('change', () => {
    if (liveInput.checked) scheduleApply();
  });

  navigator.hid?.addEventListener('disconnect', (event) => {
    if (keyboard && event.device === keyboard.hid) {
      clearInterval(keepaliveTimer);
      keyboard = null;
      claimed = false;
      showConnected(false);
      setLog('Клавиатурата беше изключена.', true);
    }
  });

  // При затваряне на страницата клавиатурата се връща към подсветката от паметта си
  window.addEventListener('pagehide', () => {
    if (keyboard && claimed) release().catch(() => {});
  });
})();
