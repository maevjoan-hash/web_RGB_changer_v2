// --- ПОДСВЕТКА НА LOGITECH КЛАВИАТУРА (напр. G515 TKL) ПРЕЗ HID++ 2.0 ---
// 0x8071 RGBEffects: ефект за целия клъстер (статичен, дишане, цикъл, вълна, изключено)
// 0x8081 PerKeyLighting v2: цвят за всеки клавиш; вижда се само при статичен ефект
// 0x8040 BrightnessControl: яркост
// За да покаже подсветката на сайта, клавиатурата минава в режим „host“ (0x8101 fn6 [05]) и сайтът
// поема клъстерите (0x8071 fn5 [01 03 00]). „Върни подсветката от паметта“ отменя това.
// 0x8101 ProfileManagement: „Запиши в клавиатурата“ пази ефекта и цвета в паметта ѝ, така че остават и без сайта.
// Цветовете по клавиши не се пазят там – за тях е помощната програма linux/g515-helper.py.
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
          <button type="button" class="panel-btn panel-btn--primary" data-device-action="save">Запиши в клавиатурата</button>
          <button type="button" class="panel-btn" data-device-action="release">Върни подсветката от паметта</button>
          <button type="button" class="panel-btn" data-device-action="copy-diagnostics">Техническа информация</button>
          <button type="button" class="panel-btn" data-device-action="disconnect">Прекъсни</button>
        </span>
        <button type="button" class="panel-btn" data-device-action="helper-config">Файл за помощната програма</button>
      </div>
      <p class="device-summary" id="kb-summary" hidden></p>
      <p class="device-log" id="device-log" role="status"></p>
      ${LogitechHelp.html('клавиатурата')}
      <details class="device-help helper-help">
        <summary>Цветове по клавиши без отворен сайт (Linux)</summary>
        <p>Паметта на клавиатурата пази само ефекта и основния цвят. Цветовете по клавиши показва малка програма
          на компютъра, която тръгва с Linux и ги изпраща при всяко включване или събуждане на клавиатурата.
          На друг компютър клавиатурата показва записаното в паметта ѝ.</p>
        <p>1. Натисни „Файл за помощната програма“ – изтегля се <code>g515.json</code>.</p>
        <p>2. В папката на проекта изпълни веднъж:</p>
        <pre class="device-help__code"><code id="helper-commands"></code></pre>
        <p>3. При промяна на цветовете изтегли файла отново и го премести на същото място – програмата го
          прочита сама. Докато тя работи, „Върни подсветката от паметта“ важи само няколко секунди; спира се с
          <code>systemctl --user stop rgb-changer-g515</code>.</p>
        <div class="panel-actions">
          <button type="button" class="panel-btn" data-device-action="copy-helper-commands">Копирай командите</button>
        </div>
      </details>
    </div>
  `;
  LogitechHelp.setup(bar);

  // Без heredoc и „&&“, за да работи еднакво в bash, zsh и fish
  const HELPER_COMMANDS = [
    'mkdir -p ~/.local/bin ~/.config/rgb-changer ~/.config/systemd/user',
    'cp linux/g515-helper.py ~/.local/bin/rgb-changer-g515',
    'chmod +x ~/.local/bin/rgb-changer-g515',
    'cp linux/rgb-changer-g515.service ~/.config/systemd/user/',
    'mv ~/Downloads/g515.json ~/.config/rgb-changer/   # или ~/Изтегляния/g515.json',
    'systemctl --user daemon-reload',
    'systemctl --user enable --now rgb-changer-g515'
  ].join('\n');
  bar.querySelector('#helper-commands').textContent = HELPER_COMMANDS;

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

  // --- ЗАПИС В ПАМЕТТА НА КЛАВИАТУРАТА (0x8101) ---
  // Профилът (99 байта) пази таймерите, ефект за нормална работа (запис 1) и затъмнен вариант за неактивност
  // (запис 3). Пишат се само потребителските файлове 0x0008 (профил) и 0x0000 (директория); фабричните
  // 0x0101/0x0100 само се четат. Всеки файл се проверява в буфера преди запис и след записа.
  // Последователността следва logirgb (lighting/profilemgmt.go) и logitech-g515-onboard.
  const PM = {
    FACTORY_PROFILE: 0x0101,
    FACTORY_DIR: 0x0100,
    USER_PROFILE: 0x0008,
    USER_DIR: 0x0000,
    PROFILE_SIZE: 99,
    DIR_SIZE: 16,
    RECORDS: 30,
    RECORD_SIZE: 11,
    FLAGS: 74
  };
  const DIR_HEADER = [0x01, 0x01, 0x81, 0x01, 0x40, 0x63];
  const DIM_PERCENT = 30;
  const BACKUP_KEY = 'rgb-changer-g515-backup';
  // Позиция на интензитета в параметрите на ефекта (за затъмнения вариант)
  const INTENSITY_AT = { 0x03: 7, 0x04: 8, 0x0a: 6, 0x15: 8, 0x16: 8 };

  const CRC32_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    bytes.forEach((byte) => {
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    });
    return (crc ^ 0xffffffff) >>> 0;
  };
  const be32 = (value) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const readBe32 = (bytes, offset) => ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  const sameBytes = (a, b) => Boolean(a && b) && a.length === b.length && a.every((value, i) => value === b[i]);
  const hex = (bytes) => bytes && bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

  const pmCall = (fn, params = []) => send(FEATURES.PROFILE_MANAGEMENT, fn << 4, params);

  const pmBuffer = async (size) => {
    const out = [];
    for (let offset = 0; offset < size; offset += 16) {
      out.push(...await pmCall(0xc, [offset >> 8, offset & 0xff]));
    }
    return out.slice(0, size);
  };

  // Зарежда файл в буфера на клавиатурата и го прочита. Незаписван потребителски файл връща грешка 0x04 → null.
  const pmRead = async (address, size) => {
    try {
      await pmCall(0x8, [address >> 8, address & 0xff, size >> 8, size & 0xff]);
    } catch (error) {
      if (error.hidppCode === 0x04 && address < PM.FACTORY_DIR) return null;
      throw error;
    }
    return pmBuffer(size);
  };

  const pmSave = async (address, data, checksum) => {
    if (address !== PM.USER_PROFILE && address !== PM.USER_DIR) throw new Error('Отказан запис извън потребителския профил.');
    await pmCall(0x2, [data.length >> 8, data.length & 0xff]);
    for (let offset = 0; offset < data.length; offset += 16) await pmCall(0x3, data.slice(offset, offset + 16));
    if (!sameBytes(await pmBuffer(data.length), data)) throw new Error('Проверката на буфера не мина – паметта не е променена.');
    await pmCall(0x7, [address >> 8, address & 0xff, data.length >> 8, data.length & 0xff, ...be32(checksum)]);
    if (!sameBytes(await pmRead(address, data.length), data)) throw new Error('Записаното в паметта се различава от изпратеното.');
  };

  const validProfile = (profile) => profile?.length === PM.PROFILE_SIZE && profile[0] === 0x01 && profile[1] === 0x01;
  const validDir = (dir) => dir?.length === PM.DIR_SIZE && sameBytes(dir.slice(4, 10), DIR_HEADER) &&
    dir[15] === 0xff && crc32(dir.slice(4)) === readBe32(dir, 0);

  // Чете четирите файла и отказва, ако нещо не изглежда както при G515
  const readProfileFiles = async () => {
    const files = {
      factoryProfile: await pmRead(PM.FACTORY_PROFILE, PM.PROFILE_SIZE),
      factoryDir: await pmRead(PM.FACTORY_DIR, PM.DIR_SIZE),
      userProfile: await pmRead(PM.USER_PROFILE, PM.PROFILE_SIZE),
      userDir: await pmRead(PM.USER_DIR, PM.DIR_SIZE)
    };
    diagnostics.profileFiles = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hex(bytes)]));

    if (!validProfile(files.factoryProfile) || !validDir(files.factoryDir)) {
      throw new Error('Паметта на клавиатурата има непознат формат – не е променена.');
    }
    if (!files.userProfile !== !files.userDir) {
      throw new Error('Потребителският профил в паметта е записан наполовина – не е променен.');
    }
    if (files.userProfile && (!validProfile(files.userProfile) || !validDir(files.userDir) ||
      files.userDir[14] !== PM.USER_PROFILE || crc32(files.userProfile) !== readBe32(files.userDir, 10))) {
      throw new Error('Потребителският профил не съвпада с описанието си в паметта – не е променен.');
    }
    return files;
  };

  // Резервно копие на паметта отпреди първия запис (остава в браузъра и в „Техническа информация“)
  const keepBackup = (files) => {
    try {
      if (localStorage.getItem(BACKUP_KEY)) return;
      localStorage.setItem(BACKUP_KEY, JSON.stringify({
        date: new Date().toISOString(),
        name: diagnostics.name,
        files: diagnostics.profileFiles
      }));
    } catch {
      // Без localStorage копието е само в техническата информация
    }
  };

  const scaleColor = (color, percent) => `#${rgb(color)
    .map((value) => Math.round((value * percent) / 100).toString(16).padStart(2, '0')).join('')}`;

  // Запис в профила: [ID на ефекта, 10 байта параметри] – същите параметри като в 0x8071
  const effectRecord = (effectId, lighting, percent) => {
    const params = effectParams(effectId, scaleColor(lighting.color, percent), lighting.periodMs);
    const at = INTENSITY_AT[effectId];
    if (at !== undefined) params[at] = Math.max(1, Math.round((params[at] * percent) / 100));
    return [effectId, ...params, ...Array(10 - params.length).fill(0)];
  };

  const hasPerKeyColors = (lighting) => lighting.effect === 'static' &&
    Object.entries(lighting.leds).some(([keyId, color]) => ZONES[keyId] && color !== lighting.color);

  const saveToKeyboard = async () => {
    if (!(await keyboard.supports(FEATURES.PROFILE_MANAGEMENT))) {
      throw new Error('Тази клавиатура няма памет за подсветка (0x8101).');
    }
    if (!/G515/i.test(diagnostics.name || '')) {
      throw new Error('Записът в паметта е проверен само с G515 – за тази клавиатура е изключен.');
    }
    const lighting = window.RgbChanger.getLighting();
    const effectId = EFFECT_IDS[lighting.effect].find((id) => effectIndexes.has(id));
    if (effectId === undefined) throw new Error('Клавиатурата не поддържа този ефект.');

    setLog('Чета паметта на клавиатурата…');
    const files = await readProfileFiles();
    keepBackup(files);

    // Новият профил е копие на досегашния (или фабричния) с нови записи 1 и 3; флаг 00 = използвай тях
    const profile = [...(files.userProfile || files.factoryProfile)];
    profile.fill(0, PM.RECORDS, PM.RECORDS + 4 * PM.RECORD_SIZE);
    profile.splice(PM.RECORDS + PM.RECORD_SIZE, PM.RECORD_SIZE, ...effectRecord(effectId, lighting, 100));
    profile.splice(PM.RECORDS + 3 * PM.RECORD_SIZE, PM.RECORD_SIZE, ...effectRecord(effectId, lighting, DIM_PERCENT));
    profile[PM.FLAGS] = 0x00;
    const profileCrc = crc32(profile);

    // Директорията е копие на фабричната с CRC на новия профил и мястото му (0x08)
    const dir = [...files.factoryDir];
    dir.splice(10, 4, ...be32(profileCrc));
    dir[14] = PM.USER_PROFILE;
    dir.splice(0, 4, ...be32(crc32(dir.slice(4))));

    setLog('Записвам в паметта на клавиатурата…');
    if (!sameBytes(profile, files.userProfile)) await pmSave(PM.USER_PROFILE, profile, profileCrc);
    if (!sameBytes(dir, files.userDir)) await pmSave(PM.USER_DIR, dir, readBe32(dir, 0));

    // Връща подсветката на клавиатурата и я кара да зареди новия профил веднага
    claimed = false;
    lastSent = '';
    await send(FEATURES.RGB_EFFECTS, 0x50, [0x01, 0x00, 0x00]);
    await pmCall(0x6, [0x0b]);
    await pmCall(0x9, [0x81, 0x01, 0x01, 0x00, 0x01, 0x00, 0x63, ...be32(profileCrc)]);
    const mode = await pmCall(0x6, [0x00]);
    diagnostics.savedProfile = hex(profile);
    if (!(mode[0] & 1) || mode[1] !== 0x00 || mode[2] !== 0x01) {
      throw new Error(`Профилът е записан, но клавиатурата не потвърди зареждането му (${hex(mode.slice(0, 3))}).`);
    }
    if (hasBrightness) await send(FEATURES.BRIGHTNESS, 0x20, [0x00, lighting.brightness]).catch(() => {});

    setLog(hasPerKeyColors(lighting)
      ? 'Ефектът и основният цвят са записани в клавиатурата. Цветовете по клавиши не се пазят в паметта ѝ – за тях е помощната програма по-долу.'
      : 'Подсветката е записана в клавиатурата и остава и без сайта.');
  };

  // Файл с цветовете по клавиши за linux/g515-helper.py (зона 0x8081 → цвят)
  const downloadHelperConfig = () => {
    const lighting = window.RgbChanger.getLighting();
    const keys = {};
    Object.entries(lighting.leds).forEach(([keyId, color]) => {
      if (ZONES[keyId] && color !== lighting.color) keys[ZONES[keyId]] = color.slice(1);
    });
    const config = { version: 1, device: 'G515', effect: lighting.effect, base: lighting.color.slice(1), keys };

    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: 'application/json' }));
    link.download = 'g515.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);

    setLog(hasPerKeyColors(lighting)
      ? 'Файлът g515.json е изтеглен. Премести го в ~/.config/rgb-changer/.'
      : 'Файлът е изтеглен, но в него няма цветове по клавиши (или ефектът не е статичен) – помощната програма няма да прави нищо.');
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
    save: run(saveToKeyboard),
    'helper-config': run(async () => downloadHelperConfig()),
    'copy-helper-commands': run(async () => {
      await navigator.clipboard.writeText(HELPER_COMMANDS);
      setLog('Командите са копирани. Изпълни ги в папката на проекта.');
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
      try {
        diagnostics.backup = JSON.parse(localStorage.getItem(BACKUP_KEY));
      } catch {
        diagnostics.backup = null;
      }
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
