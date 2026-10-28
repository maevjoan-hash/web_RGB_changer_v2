// --- ПОДСВЕТКА НА LOGITECH КЛАВИАТУРА (напр. G515 TKL) ПРЕЗ HID++ 2.0 ---
// 0x8071 RGBEffects: ефект за целия клъстер (статичен, дишане, цикъл, вълна, изключено)
// 0x8081 PerKeyLighting v2: цвят за всеки клавиш; вижда се само при статичен ефект
// 0x8040 BrightnessControl: яркост
// 0x8101 ProfileManagement: режим „host“/„onboard“ и профилът в паметта на клавиатурата
//
// За да покаже подсветката на сайта, клавиатурата минава в режим „host“ (0x8101 fn6 [05]) и сайтът поема
// клъстерите и захранването на подсветката (0x8071 fn5 [01 03 04]). Тогава фърмуерът не затъмнява сам,
// затова сайтът го прави по събитията за неактивност. След рестарт или дълбок сън клавиатурата се връща
// към паметта си – сайтът проверява това и я поема отново, а при отваряне на страницата се свързва сам
// с вече разрешената клавиатура. „Запиши в клавиатурата“ пази ефекта и основния цвят в паметта ѝ.
// Протоколът следва бележките на logirgb (github.com/mevdschee/logirgb/tree/main/research), Solaar и OpenRGB.
(() => {
  const device = document.querySelector('.keyboard');
  const bar = document.querySelector('[data-device-actions]');
  if (!device || !bar || typeof LogitechHidpp === 'undefined') return;

  const { t } = I18n;
  const { FEATURES } = LogitechHidpp;
  const WATCH_MS = 5000;
  const SETTLE_MS = 1500; // след поемане фърмуерът праща фалшива двойка „неактивна/активна“
  const DIM_PERCENT = 30;
  const NEVER = 0xffff;
  const AUTO_KEY = 'rgb-changer-g515-auto';
  // Позиция на интензитета в параметрите на ефекта (за затъмнения вариант)
  const INTENSITY_AT = { 0x03: 7, 0x04: 8, 0x0a: 6, 0x15: 8, 0x16: 8 };

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

  // Fn няма HID код и зоната му не е описана никъде. На G515 LS TKL е 111 (мястото на десния Win, проверено
  // на клавиатурата) – това е стандартът. „Намери Fn“ остава за други модели: запалва зоните, които клавиатурата обявява,
  // но може да нямат клавиш на TKL (98 е Menu, ако го има), в различни цветове – потребителят посочва цвета
  // на Fn и изборът се помни. Зони 1–79, 104–110 са на познати клавиши и не се пробват.
  const FN_KEY = 'rgb-changer-g515-fn-zone';
  const DEFAULT_FN_ZONE = 111;
  const FN_CANDIDATES = [
    { zone: 111, color: '#ff1744', name: t('червено') },
    { zone: 254, color: '#00e676', name: t('зелено') },
    { zone: 99, color: '#2979ff', name: t('синьо') },
    { zone: 97, color: '#ffea00', name: t('жълто') },
    { zone: 47, color: '#ff40ff', name: t('розово') },
    { zone: 100, color: '#00e5ff', name: t('циан') },
    { zone: 101, color: '#ff9100', name: t('оранжево') },
    { zone: 102, color: '#ffffff', name: t('бяло') },
    { zone: 98, color: '#7c4dff', name: t('лилаво') },
    { zone: 103, color: '#8d6e63', name: t('кафяво') }
  ];
  const readFnZone = () => {
    try {
      return Number(localStorage.getItem(FN_KEY)) || DEFAULT_FN_ZONE;
    } catch {
      return DEFAULT_FN_ZONE;
    }
  };
  let fnZone = readFnZone();
  const zoneOf = (keyId) => (keyId === 'Fn' ? fnZone : ZONES[keyId]);
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((letter, index) => {
    ZONES[letter] = 1 + index;
  });
  '1234567890'.split('').forEach((digit, index) => {
    ZONES[digit] = 27 + index;
  });
  for (let n = 1; n <= 12; n += 1) ZONES[`F${n}`] = 54 + n;

  // Времена за неактивност (секунди); 0xFFFF = никога
  const IDLE_CHOICES = [15, 30, 60, 120, 300, 600, NEVER];
  const SLEEP_CHOICES = [60, 300, 600, 900, 1800, 3600, NEVER];
  const timerLabel = (seconds) => {
    if (seconds === NEVER) return t('никога');
    if (seconds < 60) return `${seconds} s`;
    return seconds % 3600 === 0 ? t('{n} ч', { n: seconds / 3600 }) : t('{n} мин', { n: Math.round(seconds / 60) });
  };
  const timerOptions = (choices) => choices.map((seconds) => `<option value="${seconds}">${timerLabel(seconds)}</option>`).join('');

  bar.innerHTML = `
    <div class="device-bar">
      <div class="panel-actions save-bar__row">
        <button type="button" class="panel-btn panel-btn--primary" data-device-action="connect">${t('Свържи клавиатурата')}</button>
        <span class="save-bar__group" data-connected hidden>
          <label class="live-toggle"><input type="checkbox" id="kb-live" checked /> ${t('На живо')}</label>
          <button type="button" class="panel-btn" data-device-action="apply">${t('Приложи')}</button>
          <button type="button" class="panel-btn panel-btn--primary" data-device-action="save">${t('Запиши в клавиатурата')}</button>
          <details class="action-menu">
            <summary class="panel-btn">${t('Още ▾')}</summary>
            <div class="action-menu__list">
              <button type="button" class="panel-btn" data-device-action="release">${t('Върни подсветката от паметта')}</button>
              <button type="button" class="panel-btn" data-device-action="find-fn">${t('Намери Fn')}</button>
              <button type="button" class="panel-btn" data-device-action="read-memory">${t('Прочети паметта')}</button>
              <button type="button" class="panel-btn" data-device-action="copy-diagnostics">${t('Техническа информация')}</button>
              <hr />
              <button type="button" class="panel-btn panel-btn--danger" data-device-action="disconnect">${t('Прекъсни')}</button>
            </div>
          </details>
        </span>
      </div>
      <div class="save-bar__row fn-finder" data-fn-finder hidden>
        <span>${t('Какъв цвят свети Fn?')}</span>
        ${FN_CANDIDATES.map((candidate) => `<button type="button" class="panel-btn fn-choice" data-fn-zone="${candidate.zone}"
          style="--choice: ${candidate.color}">${candidate.name}</button>`).join('')}
        <button type="button" class="panel-btn" data-fn-zone="0">${t('В нито един цвят')}</button>
      </div>
      <div class="save-bar__row fn-finder" data-fn-search hidden>
        <span id="fn-search-question"></span>
        <button type="button" class="panel-btn panel-btn--primary" data-fn-answer="yes">${t('Да')}</button>
        <button type="button" class="panel-btn" data-fn-answer="no">${t('Не')}</button>
        <button type="button" class="panel-btn" data-fn-answer="cancel">${t('Откажи')}</button>
      </div>
      <p class="device-summary" id="kb-summary" hidden></p>
      <p class="device-log" id="device-log" role="status"></p>
      ${LogitechHelp.html(t('клавиатурата'))}
    </div>
  `;
  LogitechHelp.setup(bar);

  // Времената за неактивност са настройка на подсветката – в панела „Яркост и скорост“, щом клавиатурата е свързана
  const timersRow = document.createElement('div');
  timersRow.className = 'device-timers';
  timersRow.hidden = true;
  timersRow.innerHTML = `
    <label class="field">
      <span class="field__label">${t('Затъмняване след')}</span>
      <select class="field__select" id="kb-idle">${timerOptions(IDLE_CHOICES)}</select>
    </label>
    <label class="field">
      <span class="field__label">${t('Изключване след')}</span>
      <select class="field__select" id="kb-sleep">${timerOptions(SLEEP_CHOICES)}</select>
    </label>
  `;
  (document.querySelector('[data-column="lighting"] [data-panel="3"]') || bar).append(timersRow);

  const deviceBar = bar.querySelector('.device-bar');
  const connectButton = bar.querySelector('[data-device-action="connect"]');
  const connectedGroup = bar.querySelector('[data-connected]');
  const fnFinder = bar.querySelector('[data-fn-finder]');
  const fnSearch = bar.querySelector('[data-fn-search]');
  const fnQuestion = bar.querySelector('#fn-search-question');
  const idleSelect = timersRow.querySelector('#kb-idle');
  const sleepSelect = timersRow.querySelector('#kb-sleep');
  const liveInput = bar.querySelector('#kb-live');
  const summary = bar.querySelector('#kb-summary');
  const log = bar.querySelector('#device-log');
  const help = bar.querySelector('#device-help');

  let keyboard = null;
  let effectIndexes = new Map();
  let hasPerKey = false;
  let hasBrightness = false;
  let zoneBitmap = [];
  let findingFn = false;
  let claimed = false;
  let wantControl = false; // сайтът трябва да държи подсветката (след „Приложи“ или промяна на живо)
  let power = 'active'; // active | dim | off
  let timers = { idle: 60, sleep: 300 };
  let settleUntil = 0;
  let lastSent = '';
  let applyTimer = null;
  let watchTimer = null;
  let offTimer = null;
  let diagnostics = {};
  const events = [];

  const setLog = (message, isError = false) => {
    log.textContent = message;
    log.classList.toggle('device-log--error', isError);
    events.push(`${new Date().toLocaleTimeString(I18n.locale)}${isError ? ` ${t('[грешка]')}` : ''} ${message}`);
    if (events.length > 30) events.shift();
  };

  const showError = (error) => {
    console.error(error, error.cause);
    setLog(error.message || String(error), true);
  };

  const wait = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  // Всички действия към клавиатурата вървят едно след друго, за да не се смесват кадрите
  let chain = Promise.resolve();
  const exclusive = (task) => {
    const result = chain.then(task, task);
    chain = result.catch(() => {});
    return result;
  };

  const autoEnabled = () => {
    try {
      return localStorage.getItem(AUTO_KEY) !== 'off';
    } catch {
      return true;
    }
  };
  const setAuto = (enabled) => {
    try {
      localStorage.setItem(AUTO_KEY, enabled ? 'on' : 'off');
    } catch {
      // Без localStorage автоматичното свързване просто остава включено
    }
  };

  // Клавиатурата отговаря „заето“, докато обработва предишен кадър – тогава се опитва пак
  const send = async (featureId, fn, params = []) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await keyboard.call(featureId, fn, params);
      } catch (error) {
        if (attempt >= 4 || error.hidppCode !== 0x08) throw error;
        await wait(40 * attempt);
      }
    }
  };

  const rgb = (color) => [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const scaleColor = (color, percent) => `#${rgb(color)
    .map((value) => Math.round((value * percent) / 100).toString(16).padStart(2, '0')).join('')}`;

  // --- ПОЕМАНЕ И ВРЪЩАНЕ НА УПРАВЛЕНИЕТО ---
  const claim = async () => {
    if (await keyboard.supports(FEATURES.PROFILE_MANAGEMENT)) await send(FEATURES.PROFILE_MANAGEMENT, 0x60, [0x05]);
    // Сайтът държи клъстерите и захранването (03) и иска събитие при неактивност (04)
    await send(FEATURES.RGB_EFFECTS, 0x50, [0x01, 0x03, 0x04]);
    claimed = true;
    power = 'active';
    clearTimeout(offTimer);
    settleUntil = performance.now() + SETTLE_MS;
  };

  // Връща подсветката на фърмуера (без да сменя режима на 0x8101)
  const dropControl = async () => {
    wantControl = false;
    clearTimeout(offTimer);
    if (power === 'off') await send(FEATURES.RGB_EFFECTS, 0x80, [0x01, 0x01]).catch(() => {});
    power = 'active';
    claimed = false;
    lastSent = '';
    await send(FEATURES.RGB_EFFECTS, 0x50, [0x01, 0x00, 0x00]);
  };

  const release = async () => {
    await dropControl();
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

  // Параметрите с цвят и интензитет, намалени до percent (за затъмняване), допълнени до 10 байта
  const scaledParams = (effectId, lighting, percent) => {
    const params = effectParams(effectId, scaleColor(lighting.color, percent), lighting.periodMs);
    const at = INTENSITY_AT[effectId];
    if (at !== undefined) params[at] = Math.max(1, Math.round((params[at] * percent) / 100));
    return [...params, ...Array(10 - params.length).fill(0)];
  };

  // Цвят за всеки клавиш: първо всички зони в основния цвят (иначе незаписаните светват в бяло),
  // после клавишите с различен цвят на групи по 13 и накрая frameEnd, който показва кадъра
  const sendPerKeyFrame = async (lighting, percent) => {
    const [r, g, b] = rgb(scaleColor(lighting.color, percent));
    await send(FEATURES.PER_KEY_LIGHTING, 0x50, [1, 111, r, g, b]);
    // setRange иска first < last, а зона, която клавиатурата не обявява, може да спре цяла група –
    // затова зона на Fn извън 1–111 се боядисва поотделно
    const fnApart = fnZone > 111;
    if (fnApart) {
      const fnColor = lighting.leds.Fn ? rgb(scaleColor(lighting.leds.Fn, percent)) : [r, g, b];
      await send(FEATURES.PER_KEY_LIGHTING, 0x60, [...fnColor, fnZone]).catch(() => {});
    }

    const groups = new Map();
    Object.entries(lighting.leds).forEach(([keyId, color]) => {
      const zone = zoneOf(keyId);
      if (!zone || color === lighting.color || (fnApart && keyId === 'Fn')) return;
      if (!groups.has(color)) groups.set(color, []);
      groups.get(color).push(zone);
    });

    for (const [color, zones] of groups) {
      for (let start = 0; start < zones.length; start += 13) {
        await send(FEATURES.PER_KEY_LIGHTING, 0x60, [...rgb(scaleColor(color, percent)), ...zones.slice(start, start + 13)]);
      }
    }
    await send(FEATURES.PER_KEY_LIGHTING, 0x70, [0x00, 0x00, 0x00, 0x00, 0x00]);
  };

  const applyLighting = async (percent = 100) => {
    const lighting = window.RgbChanger?.getLighting?.();
    if (!lighting) return;

    const effectId = EFFECT_IDS[lighting.effect].find((id) => effectIndexes.has(id));
    if (effectId === undefined) throw new Error(t('Клавиатурата не поддържа този ефект.'));

    if (!claimed) await claim();
    wantControl = true;
    const payload = [0x00, effectIndexes.get(effectId), ...scaledParams(effectId, lighting, percent), 0x01];
    await send(FEATURES.RGB_EFFECTS, 0x10, payload);

    if (hasPerKey && lighting.effect === 'static') await sendPerKeyFrame(lighting, percent);
    if (hasBrightness) await send(FEATURES.BRIGHTNESS, 0x20, [0x00, lighting.brightness]);

    if (percent === 100) {
      lastSent = JSON.stringify(lighting);
      diagnostics.lastApplied = { ...lighting, effectId, effectIndex: effectIndexes.get(effectId) };
    }
  };

  // --- ВРЕМЕНА ЗА НЕАКТИВНОСТ (0x8071 fn7) ---
  // Сменят се веднага; „Запиши в клавиатурата“ ги пази и в профила (байтове 2–5), за да важат след рестарт
  const showTimers = () => {
    [[idleSelect, timers.idle], [sleepSelect, timers.sleep]].forEach(([select, seconds]) => {
      if (![...select.options].some((option) => Number(option.value) === seconds)) {
        select.add(new Option(timerLabel(seconds), seconds));
      }
      select.value = String(seconds);
    });
  };

  // Изключването трябва да е след затъмняването – другото поле се донагласява само
  const setTimers = (changed) => async () => {
    let idle = Number(idleSelect.value);
    let sleep = Number(sleepSelect.value);
    if (sleep !== NEVER && (idle === NEVER || sleep <= idle)) {
      if (changed === idleSelect) sleep = SLEEP_CHOICES.find((seconds) => seconds > idle) ?? NEVER;
      else idle = [...IDLE_CHOICES].reverse().find((seconds) => seconds < sleep) ?? IDLE_CHOICES[0];
    }
    await send(FEATURES.RGB_EFFECTS, 0x70, [0x01, 0x00, 0x00, idle >> 8, idle & 0xff, sleep >> 8, sleep & 0xff]);
    timers = { idle, sleep };
    diagnostics.timers = timers;
    showTimers();
    const values = { idle: timerLabel(idle), sleep: timerLabel(sleep) };
    let summaryText;
    if (idle === NEVER) {
      summaryText = sleep === NEVER ? t('Без затъмняване, без изключване.') : t('Без затъмняване, изключване след {sleep}.', values);
    } else {
      summaryText = sleep === NEVER ? t('Затъмняване след {idle}, без изключване.', values) : t('Затъмняване след {idle}, изключване след {sleep}.', values);
    }
    setLog(`${summaryText} ${t('„Запиши в клавиатурата“ ги пази и след рестарт.')}`);
  };

  // --- НЕАКТИВНОСТ: докато сайтът държи подсветката, затъмнява и изключва вместо фърмуера ---
  const goIdle = async () => {
    if (!keyboard || !claimed || power !== 'active') return;
    await applyLighting(DIM_PERCENT);
    await send(FEATURES.RGB_EFFECTS, 0x50, [0x01, 0x03, 0x02]); // събитие при следващо натискане
    power = 'dim';
    clearTimeout(offTimer);
    if (timers.sleep !== NEVER && timers.sleep > timers.idle) {
      offTimer = setTimeout(() => exclusive(goOff).catch(() => {}), (timers.sleep - timers.idle) * 1000);
    }
  };

  const goOff = async () => {
    if (!keyboard || !claimed || power !== 'dim') return;
    await send(FEATURES.RGB_EFFECTS, 0x80, [0x01, 0x03]);
    power = 'off';
  };

  const wake = async () => {
    if (!keyboard || !claimed || power === 'active') return;
    clearTimeout(offTimer);
    if (power === 'off') {
      // Първата команда след събуждане понякога не минава (Solaar)
      for (let attempt = 1; ; attempt += 1) {
        try {
          await send(FEATURES.RGB_EFFECTS, 0x80, [0x01, 0x01]);
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
          await wait(100);
        }
      }
    }
    await send(FEATURES.RGB_EFFECTS, 0x50, [0x01, 0x03, 0x04]);
    settleUntil = performance.now() + SETTLE_MS;
    power = 'active';
    await applyLighting();
  };

  // Събития от клавиатурата: неактивност/натискане (0x8071 fn1) и нова връзка през приемника (HID++ 1.0, 0x41)
  const onNotification = (reportId, bytes) => {
    if (!keyboard || bytes[0] !== keyboard.index) return;
    if (bytes[1] === 0x41) {
      if (!(bytes[3] & 0x40)) setTimeout(watch, 1000);
      return;
    }
    const rgbIndex = keyboard.featureIndexes.get(FEATURES.RGB_EFFECTS);
    if (reportId !== 0x11 || bytes[1] !== rgbIndex || bytes[2] !== 0x10) return;
    if (!claimed || findingFn || performance.now() < settleUntil) return;
    exclusive(bytes[3] === 0 ? goIdle : wake).catch(showError);
  };

  // На всеки 5 s: ако клавиатурата се е върнала към паметта си (рестарт, дълбок сън), сайтът я поема отново
  const watch = () => {
    if (!keyboard || !wantControl || findingFn) return;
    exclusive(async () => {
      if (!keyboard || !wantControl) return;
      try {
        let returned = false;
        if (claimed && await keyboard.supports(FEATURES.PROFILE_MANAGEMENT)) {
          const mode = await send(FEATURES.PROFILE_MANAGEMENT, 0x60, [0x00]);
          returned = Boolean(mode[0] & 1);
          if (returned) claimed = false;
        }
        if (!claimed) {
          await applyLighting();
          if (returned) setLog(t('Клавиатурата се беше върнала към подсветката от паметта си – сайтът я пое отново.'));
        }
      } catch {
        // Клавиатурата спи или е извън обхват – опитва се пак при следващата проверка
        claimed = false;
      }
    });
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
  const BACKUP_KEY = 'rgb-changer-g515-backup';

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
  const hex = (bytes) => bytes && Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

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

  // --- ЧЕТЕНЕ НА ЦЯЛАТА ПАМЕТ (само четене) ---
  // Търси файлове извън известните 0x0000/0x0008/0x0100/0x0101 – напр. записите на G HUB за цветове по клавиши,
  // чиито адреси не са описани никъде. fn8 само зарежда файл в буфера на клавиатурата и fnC го чете; запис няма.
  // Адресът е [дял, място]; пробват се дялове 0x00–0x0F и места 0x00–0x1F.
  const MEMORY_PARTITIONS = 0x10;
  const MEMORY_SLOTS = 0x20;
  const MEMORY_READ = 0x80; // размерът на буфера според getInfo (00 80)

  const readMemoryMap = async () => {
    if (!(await keyboard.supports(FEATURES.PROFILE_MANAGEMENT))) {
      throw new Error(t('Тази клавиатура няма памет за подсветка (0x8101).'));
    }
    const report = {
      name: diagnostics.name,
      deviceIndex: keyboard.index,
      info: hex(await pmCall(0x0).catch(() => [])),
      mode: hex((await pmCall(0x6, [0x00])).slice(0, 3)),
      files: {},
      errors: {}
    };
    const total = MEMORY_PARTITIONS * MEMORY_SLOTS;
    for (let partition = 0; partition < MEMORY_PARTITIONS; partition += 1) {
      for (let slot = 0; slot < MEMORY_SLOTS; slot += 1) {
        const done = partition * MEMORY_SLOTS + slot;
        if (done % 16 === 0) setLog(t('Чета паметта… {done} от {total}', { done, total }));
        const address = `0x${((partition << 8) | slot).toString(16).padStart(4, '0')}`;
        try {
          await pmCall(0x8, [partition, slot, 0x00, 0x10]);
          const file = { head: hex(await pmBuffer(0x10)) };
          // Файлът съществува – опитва и по-голяма дължина, за да се види повече от съдържанието
          try {
            await pmCall(0x8, [partition, slot, 0x00, MEMORY_READ]);
            file.data = hex(await pmBuffer(MEMORY_READ));
          } catch (error) {
            file.longRead = error.hidppCode ?? error.message;
          }
          report.files[address] = file;
        } catch (error) {
          const code = error.hidppCode ?? error.message;
          (report.errors[code] ||= []).push(address);
        }
      }
    }
    // Грешка 0x04 („няма файл“) е очакваната за празните адреси – съкращава се до брой
    Object.keys(report.errors).forEach((code) => {
      if (report.errors[code].length > 8) report.errors[code] = `${report.errors[code].length} ${t('адреса')}`;
    });
    diagnostics.memory = report;
    const found = Object.keys(report.files);
    setLog(t('Паметта е прочетена: намерени файлове {files}. Натисни „Техническа информация“ и ми изпрати текста.', {
      files: found.join(', ') || t('няма')
    }));
  };

  const pmSave = async (address, data, checksum) => {
    if (address !== PM.USER_PROFILE && address !== PM.USER_DIR) throw new Error(t('Отказан запис извън потребителския профил.'));
    await pmCall(0x2, [data.length >> 8, data.length & 0xff]);
    for (let offset = 0; offset < data.length; offset += 16) await pmCall(0x3, data.slice(offset, offset + 16));
    if (!sameBytes(await pmBuffer(data.length), data)) throw new Error(t('Проверката на буфера не мина – паметта не е променена.'));
    await pmCall(0x7, [address >> 8, address & 0xff, data.length >> 8, data.length & 0xff, ...be32(checksum)]);
    if (!sameBytes(await pmRead(address, data.length), data)) throw new Error(t('Записаното в паметта се различава от изпратеното.'));
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
      throw new Error(t('Паметта на клавиатурата има непознат формат – не е променена.'));
    }
    if (!files.userProfile !== !files.userDir) {
      throw new Error(t('Потребителският профил в паметта е записан наполовина – не е променен.'));
    }
    if (files.userProfile && (!validProfile(files.userProfile) || !validDir(files.userDir) ||
      files.userDir[14] !== PM.USER_PROFILE || crc32(files.userProfile) !== readBe32(files.userDir, 10))) {
      throw new Error(t('Потребителският профил не съвпада с описанието си в паметта – не е променен.'));
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

  // Запис в профила: [ID на ефекта, 10 байта параметри] – същите параметри като в 0x8071
  const effectRecord = (effectId, lighting, percent) => [effectId, ...scaledParams(effectId, lighting, percent)];

  const hasPerKeyColors = (lighting) => lighting.effect === 'static' &&
    Object.entries(lighting.leds).some(([keyId, color]) => zoneOf(keyId) && color !== lighting.color);

  const saveToKeyboard = async () => {
    if (!(await keyboard.supports(FEATURES.PROFILE_MANAGEMENT))) {
      throw new Error(t('Тази клавиатура няма памет за подсветка (0x8101).'));
    }
    if (!/G515/i.test(diagnostics.name || '')) {
      throw new Error(t('Записът в паметта е проверен само с G515 – за тази клавиатура е изключен.'));
    }
    const lighting = window.RgbChanger.getLighting();
    const effectId = EFFECT_IDS[lighting.effect].find((id) => effectIndexes.has(id));
    if (effectId === undefined) throw new Error(t('Клавиатурата не поддържа този ефект.'));

    // Всяка стъпка с отговора на клавиатурата отива в „Техническа информация“
    const trace = [];
    diagnostics.saveTrace = trace;
    const step = (label, reply) => trace.push(reply ? `${label}: ${hex(reply)}` : label);
    step(t('{name}, устройство 0x{index}, ефект {effect} {color}', {
      name: diagnostics.name,
      index: keyboard.index.toString(16),
      effect: lighting.effect,
      color: lighting.color
    }));
    step('0x8101 getInfo', await pmCall(0x0).catch((error) => [error.message]));

    setLog(t('Чета паметта на клавиатурата…'));
    const files = await readProfileFiles();
    keepBackup(files);
    step(files.userProfile ? t('има потребителски профил') : t('няма потребителски профил (ще се използва фабричният)'));

    // Новият профил е копие на досегашния (или фабричния) с нови записи 1 и 3; флаг 00 = използвай тях
    const profile = [...(files.userProfile || files.factoryProfile)];
    profile.fill(0, PM.RECORDS, PM.RECORDS + 4 * PM.RECORD_SIZE);
    profile.splice(PM.RECORDS + PM.RECORD_SIZE, PM.RECORD_SIZE, ...effectRecord(effectId, lighting, 100));
    profile.splice(PM.RECORDS + 3 * PM.RECORD_SIZE, PM.RECORD_SIZE, ...effectRecord(effectId, lighting, DIM_PERCENT));
    profile[PM.FLAGS] = 0x00;
    profile.splice(2, 4, timers.idle >> 8, timers.idle & 0xff, timers.sleep >> 8, timers.sleep & 0xff);
    const profileCrc = crc32(profile);

    // Директорията е копие на фабричната с CRC на новия профил и мястото му (0x08)
    const dir = [...files.factoryDir];
    dir.splice(10, 4, ...be32(profileCrc));
    dir[14] = PM.USER_PROFILE;
    dir.splice(0, 4, ...be32(crc32(dir.slice(4))));

    setLog(t('Записвам в паметта на клавиатурата…'));
    diagnostics.savedProfile = hex(profile);
    if (!sameBytes(profile, files.userProfile)) {
      await pmSave(PM.USER_PROFILE, profile, profileCrc);
      step(t('профилът е записан и проверен'));
    } else {
      step(t('профилът е същият – не е записван'));
    }
    if (!sameBytes(dir, files.userDir)) {
      await pmSave(PM.USER_DIR, dir, readBe32(dir, 0));
      step(t('директорията е записана и проверена'));
    } else {
      step(t('директорията е същата – не е записвана'));
    }

    // Връща подсветката на клавиатурата и я кара да зареди новия профил веднага
    await dropControl();
    step(t('режим преди активиране'), await pmCall(0x6, [0x00]));
    step('onboard (fn6 0b)', await pmCall(0x6, [0x0b]));
    step(t('активиране (fn9)'), await pmCall(0x9, [0x81, 0x01, 0x01, 0x00, 0x01, 0x00, 0x63, ...be32(profileCrc)]));
    const mode = await pmCall(0x6, [0x00]);
    step(t('режим след активиране'), mode);
    if (!(mode[0] & 1) || mode[1] !== 0x00 || mode[2] !== 0x01) {
      throw new Error(t('Профилът е записан, но клавиатурата не потвърди зареждането му ({reply}).', { reply: hex(mode.slice(0, 3)) }));
    }
    if (hasBrightness) await send(FEATURES.BRIGHTNESS, 0x20, [0x00, lighting.brightness]).catch(() => {});

    step(t('паметта е потвърдена'));

    // Паметта пази само основния цвят – докато сайтът е отворен, той показва отново и цветовете по клавиши
    if (hasPerKeyColors(lighting)) {
      await applyLighting();
      setLog(t('Записан е основният цвят ({color}) – клавиатурата го показва, когато сайтът е затворен. Цветовете по клавиши паметта ѝ не пази, затова ги показва сайтът, докато е отворен.', {
        color: lighting.color
      }));
    } else {
      setLog(t('Подсветката е записана в клавиатурата и остава и без сайта.'));
    }
  };

  // --- СВЪРЗВАНЕ ---
  const showConnected = (isConnected) => {
    connectButton.hidden = isConnected;
    connectedGroup.hidden = !isConnected;
    summary.hidden = !isConnected;
    timersRow.hidden = !isConnected;
  };

  // Кои зони има клавиатурата (0x8081 getInfo, страници 0–2, по 14 байта битова карта)
  const readZoneBitmap = async () => {
    const bitmap = [];
    for (let page = 0; page < 3; page += 1) {
      bitmap.push(...(await send(FEATURES.PER_KEY_LIGHTING, 0x00, [0x00, page])).slice(2, 16));
    }
    return bitmap;
  };
  const hasZone = (bitmap, zone) => Boolean((bitmap[zone >> 3] >> (zone & 7)) & 1);

  // --- НАМИРАНЕ НА Fn ---
  // Всичко угасва, а кандидатите за Fn светват всеки в свой цвят
  const findFn = async () => {
    const candidates = FN_CANDIDATES.filter(({ zone }) => !zoneBitmap.length || hasZone(zoneBitmap, zone));
    if (!hasPerKey || !effectIndexes.has(0x01)) throw new Error(t('Клавиатурата няма цвят по клавиши.'));
    if (!claimed) await claim();
    wantControl = true;
    findingFn = true;
    lastSent = '';
    await send(FEATURES.RGB_EFFECTS, 0x10, [0x00, effectIndexes.get(0x01), 0, 0, 0, 0x02, 0, 0, 0, 0, 0, 0, 0x01]);
    await send(FEATURES.PER_KEY_LIGHTING, 0x50, [1, 111, 0, 0, 0]);
    for (const { zone, color } of candidates) await send(FEATURES.PER_KEY_LIGHTING, 0x60, [...rgb(color), zone]);
    await send(FEATURES.PER_KEY_LIGHTING, 0x70, [0x00, 0x00, 0x00, 0x00, 0x00]);

    fnFinder.querySelectorAll('.fn-choice').forEach((button) => {
      button.hidden = !candidates.some(({ zone }) => zone === Number(button.dataset.fnZone));
    });
    fnFinder.hidden = false;
    setLog(t('Клавиатурата е угаснала, освен няколко зони в различни цветове. Натисни цвета, в който свети Fn.'));
  };

  // --- ПЪЛНО ТЪРСЕНЕ НА Fn ПО ПОЛОВИНИ ---
  // Светват половината от всички възможни зони (1–254) в зелено; според отговора „свети ли Fn“ остава
  // едната половина. След ~8 въпроса остава една зона, която се проверява сама. Необявените зони се
  // пращат поотделно, защото клавиатурата може да откаже цялата група заради една непозната зона.
  const SEARCH_COLOR = [0x00, 0xe6, 0x76];
  let searchZones = [];
  let confirming = false;
  let litZones = [];

  // Цвят за зони поотделно – необявените може да бъдат отказани една по една, без да спират останалите
  const paintZones = async (zones, color) => {
    const known = zones.filter((zone) => hasZone(zoneBitmap, zone));
    for (let start = 0; start < known.length; start += 13) {
      await send(FEATURES.PER_KEY_LIGHTING, 0x60, [...color, ...known.slice(start, start + 13)]);
    }
    for (const zone of zones.filter((candidate) => !hasZone(zoneBitmap, candidate))) {
      await send(FEATURES.PER_KEY_LIGHTING, 0x60, [...color, zone]).catch(() => {});
    }
  };

  // Клавиатурата пази цвета на зона до следващ запис, затова зелените от предишната стъпка се гасят изрично
  const paintSearch = async (zones) => {
    await send(FEATURES.RGB_EFFECTS, 0x10, [0x00, effectIndexes.get(0x01), 0, 0, 0, 0x02, 0, 0, 0, 0, 0, 0, 0x01]);
    await send(FEATURES.PER_KEY_LIGHTING, 0x50, [1, 111, 0, 0, 0]);
    if (hasZone(zoneBitmap, 254)) await send(FEATURES.PER_KEY_LIGHTING, 0x60, [0, 0, 0, 254]);
    await paintZones(litZones.filter((zone) => zone > 111 && !zones.includes(zone)), [0, 0, 0]);
    await paintZones(zones, SEARCH_COLOR);
    await send(FEATURES.PER_KEY_LIGHTING, 0x70, [0x00, 0x00, 0x00, 0x00, 0x00]);
    litZones = zones;
  };

  const askSearch = async () => {
    fnSearch.hidden = true;
    if (searchZones.length === 1) {
      confirming = true;
      await paintSearch(searchZones);
      fnQuestion.textContent = t('Последна проверка (зона {zone}): свети ли Fn в зелено?', { zone: searchZones[0] });
    } else {
      confirming = false;
      await paintSearch(searchZones.slice(0, Math.ceil(searchZones.length / 2)));
      const steps = Math.ceil(Math.log2(searchZones.length));
      fnQuestion.textContent = t('Свети ли Fn в зелено? (остават около {steps} въпроса)', { steps });
    }
    fnSearch.hidden = false;
    setLog(t('Гледай само клавиша Fn – другите зелени клавиши нямат значение.'));
  };

  const startSearch = async () => {
    fnFinder.hidden = true;
    if (!claimed) await claim();
    findingFn = true;
    litZones = Array.from({ length: 143 }, (_, index) => index + 112); // всички извън 1–111 – за сигурност угасени
    searchZones = Array.from({ length: 254 }, (_, index) => index + 1);
    await askSearch();
  };

  const answerSearch = async (answer) => {
    if (answer === 'cancel') {
      cancelFindFn();
      if (keyboard) await applyLighting();
      setLog(t('Търсенето на Fn е спряно.'));
      return;
    }
    const lit = answer === 'yes';
    if (confirming) {
      if (lit) {
        await chooseFn(searchZones[0]);
      } else {
        cancelFindFn();
        diagnostics.fnAnswer = t('няма своя зона');
        if (keyboard) await applyLighting();
        setLog(t('Fn не светна в нито една зона – на G515 той няма светлина, която може да се оцветява отделно.'));
      }
      return;
    }
    const half = Math.ceil(searchZones.length / 2);
    searchZones = lit ? searchZones.slice(0, half) : searchZones.slice(half);
    await askSearch();
  };

  const cancelFindFn = () => {
    fnFinder.hidden = true;
    fnSearch.hidden = true;
    findingFn = false;
  };

  const chooseFn = async (zone) => {
    // „В нито един цвят“ – търсене във всички възможни зони
    if (!zone) {
      await startSearch();
      return;
    }
    cancelFindFn();
    diagnostics.fnAnswer = zone;
    fnZone = zone;
    try {
      localStorage.setItem(FN_KEY, String(zone));
    } catch {
      // Изборът важи само до презареждане
    }
    diagnostics.fnZone = fnZone;
    if (keyboard) await applyLighting();
    setLog(t('Fn е намерен (зона {zone}) – вече се оцветява като останалите клавиши.', { zone }));
  };

  // automatic: при отваряне на страницата или включване – тихо, само за G515
  const connectTo = async (found, automatic) => {
    keyboard = found;
    help.hidden = true;
    if (!automatic) setLog(t('Чета информацията от клавиатурата…'));

    const supported = await keyboard.supports(FEATURES.RGB_EFFECTS);
    const name = supported ? await keyboard.readName().catch(() => t('Logitech клавиатура')) : '';
    if (!supported || (automatic && !/G515/i.test(name))) {
      await keyboard.close();
      keyboard = null;
      if (automatic) return false;
      throw new Error(t('Това устройство няма управление на подсветката (0x8071).'));
    }

    const battery = await keyboard.supports(FEATURES.UNIFIED_BATTERY)
      ? await keyboard.readBattery().catch(() => null)
      : null;
    effectIndexes = await readEffects();
    hasPerKey = await keyboard.supports(FEATURES.PER_KEY_LIGHTING);
    hasBrightness = await keyboard.supports(FEATURES.BRIGHTNESS);
    zoneBitmap = hasPerKey ? await readZoneBitmap().catch(() => []) : [];
    // Таймерите за затъмняване и изключване (секунди), заредени от профила в паметта
    timers = await send(FEATURES.RGB_EFFECTS, 0x70, [0x00])
      .then((reply) => ({ idle: (reply[3] << 8) | reply[4], sleep: (reply[5] << 8) | reply[6] }))
      .catch(() => ({ idle: 60, sleep: 300 }));
    claimed = false;
    power = 'active';
    lastSent = '';
    keyboard.onNotification = onNotification;

    diagnostics = {
      name,
      deviceIndex: keyboard.index,
      userAgent: navigator.userAgent,
      effects: Object.fromEntries([...effectIndexes].map(([id, index]) => [`0x${id.toString(16).padStart(2, '0')}`, index])),
      perKey: hasPerKey,
      brightness: hasBrightness,
      fnZone,
      zoneBitmap: hex(zoneBitmap),
      timers
    };
    // 0x1B05 (пренасочване на клавиши) не е описана публично – само се чете fn0, за бъдещо проучване
    if (await keyboard.supports(FEATURES.FULL_KEY_CUSTOMIZATION)) {
      diagnostics.fullKeyCustomization = await send(FEATURES.FULL_KEY_CUSTOMIZATION, 0x00)
        .then(hex).catch((error) => error.message);
    }

    const connection = keyboard.index === 0xff ? t('Bluetooth или кабел') : t('безжичен приемник');
    let batteryText = '';
    if (battery) {
      batteryText = ` · ${battery.charging
        ? t('батерия {percent}% (зарежда)', { percent: battery.percent })
        : t('батерия {percent}%', { percent: battery.percent })}`;
    }
    summary.textContent = `${name} · ${connection}${batteryText}`;
    showTimers();
    showConnected(true);

    await applyLighting();
    clearInterval(watchTimer);
    watchTimer = setInterval(watch, WATCH_MS);
    setAuto(true);
    setLog(automatic
      ? t('Клавиатурата е свързана автоматично и показва подсветката от сайта.')
      : t('Клавиатурата показва подсветката от сайта.'));
    return true;
  };

  const connect = async () => {
    const found = await LogitechHidpp.requestDevice();
    if (found) await connectTo(found, false);
  };

  // Свързва се без въпрос с клавиатура, за която браузърът вече има разрешение
  const autoConnect = () => exclusive(async () => {
    if (keyboard || !autoEnabled()) return;
    for (const hid of await LogitechHidpp.grantedDevices()) {
      try {
        if (await connectTo(await LogitechHidpp.openDevice(hid), true)) return;
      } catch (error) {
        console.warn(error);
        await keyboard?.close().catch(() => {});
        keyboard = null;
        showConnected(false);
      }
    }
  }).catch(() => {});

  const forget = () => {
    cancelFindFn();
    clearInterval(watchTimer);
    clearTimeout(offTimer);
    keyboard = null;
    claimed = false;
    wantControl = false;
    power = 'active';
    showConnected(false);
  };

  const disconnect = async () => {
    if (keyboard && claimed) await release().catch(() => {});
    await keyboard?.close();
    forget();
    setAuto(false);
    setLog(t('Връзката е прекъсната. Клавиатурата показва подсветката от паметта си.'));
  };

  // --- НА ЖИВО: всяка промяна на подсветката на сайта отива към клавиатурата ---
  const scheduleApply = () => {
    if (!keyboard || !liveInput.checked || findingFn) return;
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      exclusive(async () => {
        const lighting = window.RgbChanger?.getLighting?.();
        if (!keyboard || !lighting) return;
        // Промяна на сайта събужда затъмнената подсветка
        if (claimed && power !== 'active') {
          await wake();
        } else if (!claimed || JSON.stringify(lighting) !== lastSent) {
          await applyLighting();
        }
      }).catch(showError);
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
      await exclusive(action);
    } catch (error) {
      showError(error);
      if (error.code === 'open-failed') help.hidden = false;
    } finally {
      busy = false;
      deviceBar.classList.remove('is-busy');
    }
  };

  const actions = {
    connect: run(connect),
    apply: run(async () => {
      cancelFindFn();
      if (claimed && power !== 'active') await wake();
      else await applyLighting();
      setLog(t('Подсветката е приложена.'));
    }),
    save: run(async () => {
      cancelFindFn();
      await saveToKeyboard();
    }),
    release: run(async () => {
      cancelFindFn();
      await release();
      setLog(t('Клавиатурата показва подсветката от паметта си. „Приложи подсветката“ я поема отново.'));
    }),
    'find-fn': run(findFn),
    'read-memory': run(readMemoryMap),
    'copy-diagnostics': run(async () => {
      if (keyboard) {
        diagnostics.features = Object.fromEntries(Object.entries(FEATURES).map(
          ([featureName, id]) => [featureName, keyboard.featureIndexes.get(id) ?? t('не е проверена')]
        ));
      }
      diagnostics.power = power;
      diagnostics.events = events;
      try {
        diagnostics.backup = JSON.parse(localStorage.getItem(BACKUP_KEY));
      } catch {
        diagnostics.backup = null;
      }
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setLog(t('Техническата информация е копирана.'));
    }),
    'copy-commands': run(async () => {
      await navigator.clipboard.writeText(LogitechHelp.LINUX_COMMANDS);
      setLog(t('Командите са копирани. Постави ги в терминала.'));
    }),
    disconnect: run(disconnect)
  };

  bar.addEventListener('click', (event) => {
    const action = event.target.closest('[data-device-action]')?.dataset.deviceAction;
    if (action) actions[action]();
    const fnChoice = event.target.closest('[data-fn-zone]');
    if (fnChoice) run(() => chooseFn(Number(fnChoice.dataset.fnZone)))();
    const fnAnswer = event.target.closest('[data-fn-answer]')?.dataset.fnAnswer;
    if (fnAnswer) run(() => answerSearch(fnAnswer))();
  });

  [idleSelect, sleepSelect].forEach((select) => {
    select.addEventListener('change', run(setTimers(select)));
  });

  liveInput.addEventListener('change', () => {
    if (liveInput.checked) scheduleApply();
  });

  navigator.hid?.addEventListener('disconnect', (event) => {
    if (keyboard && event.device === keyboard.hid) {
      forget();
      setLog(t('Клавиатурата беше изключена. Сайтът ще се свърже отново, щом я включиш.'), true);
    }
  });

  // Включена отново (кабел, приемник, Bluetooth) – свързва се сама, ако преди е била свързана
  navigator.hid?.addEventListener('connect', (event) => {
    if (!keyboard && LogitechHidpp.speaksHidpp(event.device)) setTimeout(autoConnect, 1000);
  });

  // При затваряне на страницата клавиатурата се връща към подсветката от паметта си
  window.addEventListener('pagehide', () => {
    if (keyboard && claimed) release().catch(() => {});
  });

  autoConnect();
})();
