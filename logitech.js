// --- ЗАПИС В LOGITECH МИШКА (HID++ 2.0 през WebHID) ---
// Logitech мишките (напр. G309) се управляват с протокола HID++ 2.0. Всяка функция
// (име, батерия, DPI, профили в паметта) е „feature“ с номер, който първо се търси в ROOT.
// Форматът на профилите и бутоните следва Solaar (github.com/pwr-Solaar/Solaar).
//
// Заявка (long report 0x11, 20 байта): [устройство, feature index, функция | software id, параметри…]
const LogitechHidpp = (() => {
  const VENDOR_ID = 0x046d;
  const LONG_REPORT = 0x11;
  const SHORT_REPORT = 0x10;
  const LONG_LENGTH = 19;
  const SOFTWARE_ID = 0x0a;
  const DIRECT_DEVICE = 0xff;
  const TIMEOUT_MS = 1500;

  const FEATURES = {
    ROOT: 0x0000,
    DEVICE_NAME: 0x0005,
    UNIFIED_BATTERY: 0x1004,
    EXTENDED_DPI: 0x2202,
    ONBOARD_PROFILES: 0x8100
  };

  const ERROR_NAMES = {
    0x02: 'непознат параметър',
    0x03: 'невалиден аргумент',
    0x04: 'извън обхвата',
    0x05: 'хардуерна грешка',
    0x07: 'невалиден номер на функция',
    0x08: 'устройството е заето',
    0x09: 'неподдържано'
  };

  class HidppDevice {
    constructor(hid) {
      this.hid = hid;
      this.index = DIRECT_DEVICE;
      this.featureIndexes = new Map([[FEATURES.ROOT, 0]]);
      this.pending = null;
      this.queue = Promise.resolve();
      this.onReport = this.onReport.bind(this);
    }

    async open() {
      if (!this.hid.opened) {
        try {
          await this.hid.open();
        } catch (cause) {
          // Най-често: в Linux няма права за /dev/hidraw*, или друга програма държи устройството
          const error = new Error('Системата не позволи на браузъра да отвори мишката.');
          error.code = 'open-failed';
          error.cause = cause;
          throw error;
        }
      }
      this.hid.addEventListener('inputreport', this.onReport);
    }

    async close() {
      this.hid.removeEventListener('inputreport', this.onReport);
      if (this.hid.opened) await this.hid.close();
    }

    onReport(event) {
      if (!this.pending || (event.reportId !== LONG_REPORT && event.reportId !== SHORT_REPORT)) return;

      const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
      const { index, featureIndex, functionId, resolve, reject } = this.pending;
      if (bytes[0] !== index) return;

      if (bytes[1] === featureIndex && bytes[2] === functionId) {
        resolve(bytes.slice(3));
      } else if ((bytes[1] === 0xff || bytes[1] === 0x8f) && bytes[2] === featureIndex && bytes[3] === functionId) {
        const code = bytes[4];
        reject(new Error(`Мишката върна грешка: ${ERROR_NAMES[code] || `код ${code}`}`));
      }
    }

    // Заявките се изпращат една по една, защото отговорът се разпознава по feature и функция
    request(featureIndex, fn, params = [], { index = this.index, timeout = TIMEOUT_MS } = {}) {
      const run = () => new Promise((resolve, reject) => {
        const functionId = (fn & 0xf0) | SOFTWARE_ID;
        const data = new Uint8Array(LONG_LENGTH);
        data.set([index, featureIndex, functionId, ...params].slice(0, LONG_LENGTH));

        const timer = setTimeout(() => {
          this.pending = null;
          reject(new Error('Мишката не отговори навреме.'));
        }, timeout);

        const finish = (callback) => (value) => {
          clearTimeout(timer);
          this.pending = null;
          callback(value);
        };

        this.pending = { index, featureIndex, functionId, resolve: finish(resolve), reject: finish(reject) };
        this.hid.sendReport(LONG_REPORT, data).catch(this.pending.reject);
      });

      const result = this.queue.then(run, run);
      this.queue = result.catch(() => {});
      return result;
    }

    // Безжичният приемник (Lightspeed) адресира мишката с номер 1–6, а Bluetooth/кабел с 0xFF
    async findDeviceIndex() {
      for (const index of [DIRECT_DEVICE, 1, 2, 3, 4, 5, 6]) {
        try {
          const reply = await this.request(0, 0x10, [0, 0, 0x5a], { index, timeout: 700 });
          if (reply[2] === 0x5a) {
            this.index = index;
            return index;
          }
        } catch {
          // Няма устройство на този номер – пробваме следващия
        }
      }
      throw new Error('Не е намерена мишка, която говори HID++ 2.0.');
    }

    async featureIndex(featureId) {
      if (!this.featureIndexes.has(featureId)) {
        const reply = await this.request(0, 0x00, [featureId >> 8, featureId & 0xff]);
        this.featureIndexes.set(featureId, reply[0] || null);
      }
      return this.featureIndexes.get(featureId);
    }

    async supports(featureId) {
      return Boolean(await this.featureIndex(featureId));
    }

    async call(featureId, fn, params = []) {
      const index = await this.featureIndex(featureId);
      if (!index) throw new Error(`Мишката не поддържа функция 0x${featureId.toString(16).padStart(4, '0')}.`);
      return this.request(index, fn, params);
    }

    // --- Име и батерия ---
    async readName() {
      const [length] = await this.call(FEATURES.DEVICE_NAME, 0x00);
      let name = '';
      while (name.length < length) {
        const chunk = await this.call(FEATURES.DEVICE_NAME, 0x10, [name.length]);
        const text = new TextDecoder().decode(chunk).replace(/\0.*$/s, '');
        if (!text) break;
        name += text.slice(0, length - name.length);
      }
      return name;
    }

    async readBattery() {
      const reply = await this.call(FEATURES.UNIFIED_BATTERY, 0x10);
      return { percent: reply[0], charging: reply[2] === 1 || reply[2] === 2 };
    }

    // --- DPI (Extended Adjustable DPI, 0x2202) ---
    async readDpiCapabilities() {
      const caps = await this.call(FEATURES.EXTENDED_DPI, 0x10, [0]);
      const words = [];

      // Списъкът идва на страници; 0 означава край. 0b111xxxxx xxxxxxxx = „стъпка“, следвана от горна граница.
      for (let page = 0; page < 0x100; page += 1) {
        const reply = await this.call(FEATURES.EXTENDED_DPI, 0x20, [0, 0, page]);
        let ended = false;
        for (let offset = 3; offset + 1 < reply.length; offset += 2) {
          const word = (reply[offset] << 8) | reply[offset + 1];
          if (word === 0) {
            ended = true;
            break;
          }
          words.push(word);
        }
        if (ended) break;
      }

      const values = [];
      for (let i = 0; i < words.length; i += 1) {
        if (words[i] >> 13 === 0b111 && values.length > 0 && i + 1 < words.length) {
          const step = words[i] & 0x1fff;
          const last = words[i + 1];
          for (let value = values[values.length - 1] + step; value <= last; value += step) values.push(value);
          i += 1;
        } else {
          values.push(words[i]);
        }
      }

      return { values, hasY: Boolean(caps[2] & 0x01), hasLod: Boolean(caps[2] & 0x02) };
    }

    async readDpi() {
      const reply = await this.call(FEATURES.EXTENDED_DPI, 0x50, [0]);
      return { dpi: (reply[1] << 8) | reply[2], lod: reply[9] };
    }

    async setDpi(dpi, { hasY, hasLod }) {
      const { lod } = await this.readDpi();
      const y = hasY ? dpi : 0;
      await this.call(FEATURES.EXTENDED_DPI, 0x60, [0, dpi >> 8, dpi & 0xff, y >> 8, y & 0xff, hasLod ? lod : 0]);
    }

    // --- Профили в паметта на мишката (Onboard Profiles, 0x8100) ---
    async readOnboardInfo() {
      const r = await this.call(FEATURES.ONBOARD_PROFILES, 0x00);
      return {
        raw: r.slice(0, 16),
        memory: r[0],
        format: r[1],
        profileCount: r[3],
        buttons: r[5],
        sectors: r[6],
        sectorSize: (r[7] << 8) | r[8]
      };
    }

    async readMode() {
      const [mode] = await this.call(FEATURES.ONBOARD_PROFILES, 0x20);
      return mode;
    }

    async setMode(mode) {
      await this.call(FEATURES.ONBOARD_PROFILES, 0x10, [mode]);
    }

    // Текущ профил = номер на сектора му. Повторният избор кара мишката да го прочете наново от паметта.
    async readCurrentProfile() {
      const reply = await this.call(FEATURES.ONBOARD_PROFILES, 0x40);
      return (reply[0] << 8) | reply[1];
    }

    async setCurrentProfile(sector) {
      await this.call(FEATURES.ONBOARD_PROFILES, 0x30, [sector >> 8, sector & 0xff]);
    }

    // Текущо DPI ниво (0–4) в режим „профил от паметта“ – същото, което сменя бутонът DPI на мишката
    async readCurrentDpiIndex() {
      const [index] = await this.call(FEATURES.ONBOARD_PROFILES, 0xb0);
      return index;
    }

    async setCurrentDpiIndex(index) {
      await this.call(FEATURES.ONBOARD_PROFILES, 0xc0, [index]);
    }

    async readSector(sector, size) {
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += 16) {
        const at = Math.min(offset, size - 16);
        const chunk = await this.call(FEATURES.ONBOARD_PROFILES, 0x50, [sector >> 8, sector & 0xff, at >> 8, at & 0xff]);
        bytes.set(chunk.slice(0, 16), at);
      }
      return bytes;
    }

    async writeSector(sector, bytes) {
      const length = bytes.length;
      await this.call(FEATURES.ONBOARD_PROFILES, 0x60, [sector >> 8, sector & 0xff, 0, 0, length >> 8, length & 0xff]);
      for (let offset = 0; offset < length; offset += 16) {
        await this.call(FEATURES.ONBOARD_PROFILES, 0x70, [...bytes.slice(offset, offset + 16)]);
      }
      await this.call(FEATURES.ONBOARD_PROFILES, 0x80);
    }
  }

  // CRC-16/CCITT (начална стойност 0xFFFF), записва се big-endian в последните 2 байта на сектора
  const crc16 = (bytes) => {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  };

  const withCrc = (bytes) => {
    const crc = crc16(bytes.subarray(0, bytes.length - 2));
    bytes[bytes.length - 2] = crc >> 8;
    bytes[bytes.length - 1] = crc & 0xff;
    return bytes;
  };

  const isEmptySector = (bytes) => bytes.slice(0, 4).every((byte) => byte === 0x00) ||
    bytes.slice(0, 4).every((byte) => byte === 0xff);

  // Директорията (сектор 0, а за фабричните профили 0x0100) е списък от [сектор(2), активен(1), 0]
  const parseDirectory = (bytes) => {
    const entries = [];
    if (isEmptySector(bytes)) return entries;
    for (let offset = 0; offset + 3 < bytes.length - 2; offset += 4) {
      const sector = (bytes[offset] << 8) | bytes[offset + 1];
      if (sector === 0xffff) break;
      entries.push({ sector, enabled: bytes[offset + 2] });
    }
    return entries;
  };

  const buildDirectory = (entries, size) => {
    const bytes = new Uint8Array(size).fill(0xff);
    let offset = 0;
    entries.forEach(({ sector, enabled }) => {
      bytes.set([sector >> 8, sector & 0xff, enabled, 0x00], offset);
      offset += 4;
    });
    bytes.set([0xff, 0xff, 0x00, 0x00], offset);
    return withCrc(bytes);
  };

  async function requestDevice() {
    if (!navigator.hid) {
      throw new Error('Браузърът не поддържа WebHID. Използвай Chrome или Edge на компютър.');
    }
    if (!window.isSecureContext) {
      throw new Error('WebHID работи само през https:// или http://localhost.');
    }

    const devices = await navigator.hid.requestDevice({
      filters: [
        { vendorId: VENDOR_ID, usagePage: 0xff43 },
        { vendorId: VENDOR_ID, usagePage: 0xff00 }
      ]
    });

    // HID++ минава през колекцията, която приема long report 0x11
    const hid = devices.find((candidate) => candidate.collections.some(
      (collection) => collection.outputReports?.some((report) => report.reportId === LONG_REPORT)
    ));

    if (devices.length === 0) return null;
    if (!hid) throw new Error('Избраното устройство не поддържа HID++ (протокола на Logitech).');

    const device = new HidppDevice(hid);
    await device.open();
    await device.findDeviceIndex();
    return device;
  }

  return { FEATURES, requestDevice, crc16, withCrc, parseDirectory, buildDirectory };
})();

// --- БУТОНИТЕ В ПРОФИЛА НА МИШКАТА ---
// Всеки бутон е 4 байта: 0x80 тип стойност = „изпрати“ (бутон на мишката, клавиш или медия),
// 0x90 функция 0xFF данни = вградена функция (DPI, профил…), 0x00–0x2F = макро, 0xFF… = неизползван.
const LogitechButtons = (() => {
  const MOUSE_BUTTONS = { left: 0x0001, right: 0x0002, middle: 0x0004, back: 0x0008, forward: 0x0010 };
  const FUNCTIONS = { 'dpi-up': 0x03, 'dpi-down': 0x04, sniper: 0x07 };
  const CONSUMER = {
    'play-pause': 0xcd,
    next: 0xb5,
    prev: 0xb6,
    stop: 0xb7,
    mute: 0xe2,
    'volume-up': 0xe9,
    'volume-down': 0xea
  };
  const MODIFIERS = { Ctrl: 0x01, Shift: 0x02, Alt: 0x04, Win: 0x08 };

  // HID кодове на клавишите (Keyboard/Keypad usage page)
  const KEY_CODES = {
    Enter: 0x28, Esc: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, '-': 0x2d, '=': 0x2e, '[': 0x2f,
    ']': 0x30, '\\': 0x31, ';': 0x33, "'": 0x34, '`': 0x35, ',': 0x36, '.': 0x37, '/': 0x38, Caps: 0x39,
    PrtSc: 0x46, ScrLk: 0x47, Pause: 0x48, Ins: 0x49, Home: 0x4a, PgUp: 0x4b, Del: 0x4c, End: 0x4d, PgDn: 0x4e,
    '→': 0x4f, '←': 0x50, '↓': 0x51, '↑': 0x52, NumLock: 0x53, 'Num Divide': 0x54, 'Num Multiply': 0x55,
    'Num Subtract': 0x56, 'Num Add': 0x57, 'Num Decimal': 0x63, Menu: 0x65
  };
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((letter, index) => {
    KEY_CODES[letter] = 0x04 + index;
  });
  '1234567890'.split('').forEach((digit, index) => {
    KEY_CODES[digit] = 0x1e + index;
    KEY_CODES[`Num ${digit}`] = digit === '0' ? 0x62 : 0x59 + index;
  });
  for (let n = 1; n <= 24; n += 1) KEY_CODES[`F${n}`] = n <= 12 ? 0x39 + n : 0x5b + n;

  const KEY_NAMES = Object.fromEntries(Object.entries(KEY_CODES).map(([name, code]) => [code, name]));
  const MOUSE_NAMES = { 0x0001: 'Ляв клик', 0x0002: 'Десен клик', 0x0004: 'Среден клик', 0x0008: 'Назад', 0x0010: 'Напред' };
  const CONSUMER_NAMES = {
    0xcd: 'Пусни / пауза', 0xb5: 'Следваща песен', 0xb6: 'Предишна песен', 0xb7: 'Стоп',
    0xe2: 'Без звук', 0xe9: 'Звук +', 0xea: 'Звук −'
  };
  const FUNCTION_NAMES = {
    0x00: 'Без действие', 0x01: 'Наклон наляво', 0x02: 'Наклон надясно', 0x03: 'DPI +', 0x04: 'DPI −',
    0x05: 'Смяна на DPI (кръгово)', 0x06: 'DPI по подразбиране', 0x07: 'Нисък DPI докато е натиснат',
    0x08: 'Следващ профил', 0x09: 'Предишен профил', 0x0a: 'Смяна на профила', 0x0b: 'G-Shift',
    0x0c: 'Състояние на батерията', 0x0d: 'Избор на профил', 0x0e: 'Смяна на режима', 0x0f: 'Бутон към компютъра',
    0x10: 'Скрол надолу', 0x11: 'Скрол нагоре'
  };

  const encodeCombo = (combo) => {
    let modifiers = 0;
    let key = 0;
    for (const part of combo.split(' + ')) {
      if (MODIFIERS[part]) modifiers |= MODIFIERS[part];
      else if (KEY_CODES[part] !== undefined && !key) key = KEY_CODES[part];
      else return null;
    }
    return [0x80, 0x02, modifiers, key];
  };

  // Връща 4 байта, 'factory' (фабричната функция) или { error } за неподдържаните функции
  const encode = (binding) => {
    if (!binding) return 'factory';

    switch (binding.type) {
      case 'combo': {
        const bytes = encodeCombo(binding.value);
        return bytes || { error: `клавишът „${binding.value}“ не може да се запише в мишката` };
      }
      case 'media':
        return [0x80, 0x03, 0x00, CONSUMER[binding.value]];
      case 'mouse':
        if (MOUSE_BUTTONS[binding.value]) return [0x80, 0x01, 0x00, MOUSE_BUTTONS[binding.value]];
        if (FUNCTIONS[binding.value] !== undefined) return [0x90, FUNCTIONS[binding.value], 0xff, 0x00];
        return { error: 'двоен клик и бърза стрелба изискват макро, което още не се записва в мишката' };
      case 'disabled':
        return [0x80, 0x00, 0xff, 0xff];
      case 'macro':
        return { error: 'макросите още не се записват в мишката' };
      default:
        return { error: 'неизвестна функция' };
    }
  };

  const describe = (bytes) => {
    const [b0, b1, b2, b3] = bytes;
    const value = (b2 << 8) | b3;

    if (b0 === 0xff && b1 === 0xff) return 'Неизползван';
    if (b0 === 0x80) {
      if (b1 === 0x00) return 'Изключен';
      if (b1 === 0x01) {
        return MOUSE_NAMES[value] || `Бутон на мишката 0x${value.toString(16)}`;
      }
      if (b1 === 0x02) {
        const modifiers = Object.entries(MODIFIERS).filter(([, bit]) => b2 & bit).map(([name]) => name);
        return [...modifiers, ...(b3 ? [KEY_NAMES[b3] || `код 0x${b3.toString(16)}`] : [])].join(' + ');
      }
      if (b1 === 0x03) return CONSUMER_NAMES[value] || `Медия 0x${value.toString(16)}`;
    }
    if (b0 === 0x90) return FUNCTION_NAMES[b1] || `Функция 0x${b1.toString(16)}`;
    if (b0 >> 4 <= 0x2) return 'Макро';
    return `Непознато (${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')})`;
  };

  return { encode, describe };
})();

// --- ПАНЕЛ „ЗАПИС В МИШКАТА“ ---
(() => {
  const device = document.querySelector('.mouse-svg');
  const panels = document.querySelector('.settings-panels');
  const tab = document.querySelector('.settings-tab[data-tab="6"]');
  if (!device || !panels || !tab) return;

  const MODE_ONBOARD = 0x01;
  const MODE_HOST = 0x02;

  // Форматът на профила се различава между поколенията мишки и не е публично описан за всички.
  // Затова мястото на бутоните се намира във фабричния профил по първите два бутона
  // (ляв и десен клик: 80 01 00 01 80 01 00 02), а подредбата на DPI се приема само ако
  // всичките ѝ стойности са сред поддържаните от мишката.
  // Формати 1–5 (Solaar): DPI по 2 байта от байт 3, индекс по подразбиране в байт 1.
  // Формат 7 (PRO X 2 Superlight): DPI по 5 байта (X, Y, LOD) от байт 4, индекс в байт 2.
  const BUTTON_SIGNATURE = [0x80, 0x01, 0x00, 0x01, 0x80, 0x01, 0x00, 0x02];
  const DPI_LAYOUTS = [
    { offset: 3, stride: 2, hasY: false, defaultIndexByte: 1 },
    { offset: 4, stride: 5, hasY: true, defaultIndexByte: 2 }
  ];

  const detectLayout = (factory, dpiValues) => {
    let buttons = null;
    for (let offset = 0; offset + BUTTON_SIGNATURE.length <= factory.length - 2; offset += 4) {
      if (BUTTON_SIGNATURE.every((byte, index) => factory[offset + index] === byte)) {
        buttons = offset;
        break;
      }
    }

    const validDpi = new Set(dpiValues || []);
    const known = DPI_LAYOUTS.find((layout) => {
      const used = readDpiStages(factory, layout).filter((value) => !isUnusedDpi(value));
      return used.length > 0 && used.every((value) => validDpi.has(value)) && factory[layout.defaultIndexByte] < 5;
    });

    // Y се записва само ако фабричният профил го ползва (Y = X). G309 (формат 6) държи Y = 0.
    const dpi = known ? { ...known, hasY: known.hasY && yMatchesX(factory, known) } : scanDpiLayout(factory, validDpi, buttons ?? 64);
    return { buttons, dpi };
  };

  function yMatchesX(bytes, { offset, stride }) {
    const used = readDpiStages(bytes, { offset, stride }).map((value, slot) => [value, slot]).filter(([value]) => !isUnusedDpi(value));
    return used.length > 0 && used.every(([value, slot]) => (
      (bytes[offset + slot * stride + 2] | (bytes[offset + slot * stride + 3] << 8)) === value
    ));
  }

  const isUnusedDpi = (value) => value === 0 || value === 0xffff;

  // 5 нива на DPI (little-endian); при подредба с Y, Y е 2 байта след X
  function readDpiStages(bytes, { offset, stride }) {
    return Array.from({ length: 5 }, (_, slot) => bytes[offset + slot * stride] | (bytes[offset + slot * stride + 1] << 8));
  }

  // Непознат формат: търси във фабричния профил (преди бутоните) поредица от нива, които изглеждат
  // като фабрични DPI нива – поддържани от мишката, възходящи (напр. 400, 800, 1600…), празните само накрая.
  // Индексът на нивото по подразбиране тогава не е известен и не се променя.
  function scanDpiLayout(factory, validDpi, limit) {
    for (const stride of [2, 4, 5, 6]) {
      for (let offset = 0; offset + stride * 4 + 2 <= limit; offset += 1) {
        const stages = readDpiStages(factory, { offset, stride });
        const used = stages.filter((value) => !isUnusedDpi(value));
        const isPrefix = stages.slice(0, used.length).every((value) => !isUnusedDpi(value));
        const isAscending = used.every((value, index) => index === 0 || value > used[index - 1]);
        if (used.length >= 2 && isPrefix && isAscending && used.every((value) => validDpi.has(value))) {
          const hasY = stride >= 4 && used.every((value, slot) => (
            (factory[offset + slot * stride + 2] | (factory[offset + slot * stride + 3] << 8)) === value
          ));
          return { offset, stride, hasY, defaultIndexByte: null };
        }
      }
    }
    return null;
  }

  const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  const BUTTON_NAMES = ['Ляв бутон', 'Десен бутон', 'Среден бутон (колелце)', 'Страничен назад', 'Страничен напред', 'DPI бутон'];

  // Кой бутон от рисунката на сайта на кой бутон в мишката отговаря
  const SITE_TO_DEVICE = { LMB: 0, RMB: 1, Scroll: 2 };
  const deviceButtonFor = ({ id, defaultBinding }) => {
    if (SITE_TO_DEVICE[id] !== undefined) return SITE_TO_DEVICE[id];
    if (defaultBinding.value === 'back') return 3;
    if (defaultBinding.value === 'forward') return 4;
    return { M4: 3, M5: 4, 'DPI+': 5 }[id];
  };

  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  panel.dataset.panel = tab.dataset.tab;
  panel.id = `settings-panel-${tab.dataset.tab}`;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', tab.textContent);
  panel.hidden = true;
  tab.setAttribute('aria-controls', panel.id);
  panel.innerHTML = `
    <div class="panel-actions">
      <button type="button" class="panel-btn" data-device-action="connect">Свържи мишката</button>
      <button type="button" class="panel-btn" data-device-action="disconnect" hidden>Прекъсни</button>
    </div>

    <div class="device-details" id="device-details" hidden>
      <p class="device-summary" id="device-summary"></p>

      <div class="device-block" id="device-dpi-block" hidden>
        <p class="field__label">DPI (чувствителност) <span id="device-dpi-range"></span> · сега: <span id="device-dpi-current"></span></p>
        <p class="settings-hint" id="device-dpi-stages-hint" hidden></p>
        <div class="dpi-stages" id="device-dpi-stages" hidden></div>
        <label class="field" id="device-dpi-single">
          <span class="field__label">Нов DPI</span>
          <input type="number" class="field__select" id="device-dpi" />
        </label>
        <div class="panel-actions">
          <button type="button" class="panel-btn" data-device-action="apply-dpi">Приложи веднага</button>
          <button type="button" class="panel-btn" data-device-action="write-dpi" id="device-write-dpi" hidden>Запиши DPI нивата в мишката</button>
        </div>
      </div>

      <div class="device-block" id="device-buttons-block" hidden>
        <p class="field__label">Бутоните в мишката сега</p>
        <ul class="binding-list" id="device-buttons"></ul>
        <p class="field__label" id="device-plan-title"></p>
        <ul class="binding-list" id="device-plan"></ul>
        <div class="panel-actions" id="device-write-actions">
          <button type="button" class="panel-btn" data-device-action="write">Запиши в мишката</button>
          <button type="button" class="panel-btn" data-device-action="factory">Върни фабричните бутони</button>
        </div>
      </div>

      <p class="panel-note" id="device-onboard-note" hidden></p>
      <div class="panel-actions">
        <button type="button" class="panel-btn" data-device-action="copy-diagnostics">Копирай техническа информация</button>
      </div>
    </div>

    <p class="device-log" id="device-log" role="status"></p>

    <div class="device-help" id="device-help" hidden>
      <div data-help-os="linux">
        <p>В Linux браузърът няма достъп до HID устройствата, докато не му се разреши. Изпълни веднъж в терминала:</p>
        <pre class="device-help__code"><code id="device-help-commands"></code></pre>
        <div class="panel-actions">
          <button type="button" class="panel-btn" data-device-action="copy-commands">Копирай командите</button>
        </div>
        <p>След това изключи и включи мишката (или я свържи отново по Bluetooth) и натисни „Свържи мишката“ пак.
          Ако браузърът е инсталиран като Snap или Flatpak, той може да няма достъп до HID устройства изобщо –
          тогава използвай версията от официалния сайт или пакет (.deb/.rpm).</p>
      </div>
      <div data-help-os="other">
        <p>Затвори Logitech G HUB и другите програми за мишката, рестартирай браузъра и опитай пак.</p>
      </div>
    </div>
  `;
  panels.append(panel);

  const details = panel.querySelector('#device-details');
  const summary = panel.querySelector('#device-summary');
  const dpiBlock = panel.querySelector('#device-dpi-block');
  const dpiInput = panel.querySelector('#device-dpi');
  const dpiRange = panel.querySelector('#device-dpi-range');
  const dpiCurrent = panel.querySelector('#device-dpi-current');
  const dpiStages = panel.querySelector('#device-dpi-stages');
  const dpiStagesHint = panel.querySelector('#device-dpi-stages-hint');
  const dpiSingle = panel.querySelector('#device-dpi-single');
  const writeDpiButton = panel.querySelector('#device-write-dpi');
  const applyDpiButton = panel.querySelector('[data-device-action="apply-dpi"]');
  const buttonsBlock = panel.querySelector('#device-buttons-block');
  const buttonsList = panel.querySelector('#device-buttons');
  const planTitle = panel.querySelector('#device-plan-title');
  const planList = panel.querySelector('#device-plan');
  const writeActions = panel.querySelector('#device-write-actions');
  const onboardNote = panel.querySelector('#device-onboard-note');
  const log = panel.querySelector('#device-log');
  const help = panel.querySelector('#device-help');
  const isLinux = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

  // Същото правило като linux/42-logitech-webhid.rules в проекта.
  // Без heredoc и „&&“, за да работи еднакво в bash, zsh и fish.
  const LINUX_COMMANDS = [
    "printf '%s\\n' 'SUBSYSTEM==\"hidraw\", ATTRS{idVendor}==\"046d\", TAG+=\"uaccess\"' " +
      "'SUBSYSTEM==\"hidraw\", KERNELS==\"0005:046D:*\", TAG+=\"uaccess\"' " +
      '| sudo tee /etc/udev/rules.d/42-logitech-webhid.rules > /dev/null',
    'sudo udevadm control --reload-rules',
    'sudo udevadm trigger'
  ].join('\n');

  panel.querySelector('#device-help-commands').textContent = LINUX_COMMANDS;
  panel.querySelectorAll('[data-help-os]').forEach((block) => {
    block.hidden = (block.dataset.helpOs === 'linux') !== isLinux;
  });
  const connectButton = panel.querySelector('[data-device-action="connect"]');
  const disconnectButton = panel.querySelector('[data-device-action="disconnect"]');

  let mouse = null;
  let deviceText = '';
  let dpiCaps = null;
  let onboard = null;
  let diagnostics = {};
  let busy = false;

  // Последните съобщения влизат и в техническата информация
  const events = [];

  const setLog = (message, isError = false) => {
    log.textContent = message;
    log.classList.toggle('device-log--error', isError);
    events.push(`${new Date().toLocaleTimeString('bg-BG')}${isError ? ' [грешка]' : ''} ${message}`);
    if (events.length > 30) events.shift();
  };

  const listItems = (items) => items.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  });

  // Какво ще се запише за всеки бутон на мишката според функциите от активния профил на сайта
  const buildPlan = () => {
    const functions = window.RgbChanger?.getButtonFunctions?.() || [];
    const plan = new Map();
    const skipped = [];

    functions.forEach((entry) => {
      const index = deviceButtonFor(entry);
      if (index === undefined || index >= onboard.info.buttons) {
        if (entry.binding) skipped.push(`${entry.name}: тази мишка няма такъв бутон`);
        return;
      }
      const encoded = LogitechButtons.encode(entry.binding);
      if (encoded.error) {
        skipped.push(`${entry.name}: ${encoded.error}`);
        return;
      }
      plan.set(index, { encoded, description: entry.description });
    });

    return { plan, skipped };
  };

  const renderDevice = () => {
    const modeText = onboard ? ` · режим: ${onboard.mode === MODE_ONBOARD ? 'профил от паметта' : 'управлявана от компютъра'}` : '';
    summary.textContent = `${deviceText}${modeText}`;
    if (!onboard) return;

    const buttonsOffset = onboard.layout.buttons;
    const recognized = buttonsOffset !== null;
    writeActions.hidden = !recognized;
    planTitle.hidden = !recognized;
    planList.hidden = !recognized;

    if (!recognized) {
      buttonsList.replaceChildren(...listItems([
        `Форматът на профилите в тази мишка (формат ${onboard.info.format}) още не е разпознат, затова бутоните не могат да се четат и записват.`
      ]));
      return;
    }

    buttonsList.replaceChildren(...listItems(
      Array.from({ length: onboard.info.buttons }, (_, index) => {
        const bytes = onboard.profile.slice(buttonsOffset + index * 4, buttonsOffset + index * 4 + 4);
        return `${BUTTON_NAMES[index] || `Бутон ${index + 1}`}: ${LogitechButtons.describe(bytes)}`;
      })
    ));

    const { plan, skipped } = buildPlan();
    planTitle.textContent = `Какво ще се запише (Профил ${(window.RgbChanger?.activeProfile?.() ?? 0) + 1} от сайта)`;
    planList.replaceChildren(...listItems([
      ...Array.from({ length: onboard.info.buttons }, (_, index) => {
        const entry = plan.get(index);
        const name = BUTTON_NAMES[index] || `Бутон ${index + 1}`;
        if (!entry || entry.encoded === 'factory') {
          const factory = onboard.factory.slice(buttonsOffset + index * 4, buttonsOffset + index * 4 + 4);
          return `${name} → ${LogitechButtons.describe(factory)} (фабрично)`;
        }
        return `${name} → ${entry.description}`;
      }),
      ...skipped.map((text) => `Пропуснато – ${text}`)
    ]));
  };

  // В режим „профил от паметта“ текущото ниво се чете и сменя директно (0x8100, функции 0xB0/0xC0)
  const usesOnboardStages = () => Boolean(dpiCaps && onboard?.layout.dpi && onboard.mode === MODE_ONBOARD);
  const storedStages = () => readDpiStages(onboard.userEntry ? onboard.profile : onboard.factory, onboard.layout.dpi);
  let currentStage = null;

  const markActiveStage = () => {
    dpiStages.querySelectorAll('.dpi-stage').forEach((row, slot) => {
      row.classList.toggle('is-active-stage', slot === currentStage);
    });
  };

  // Нивата на DPI от активния профил; кръгчето отбелязва нивото по подразбиране, „Включи“ сменя нивото веднага
  const renderDpi = () => {
    const layout = onboard?.layout.dpi;
    const hasStages = Boolean(dpiCaps && layout);
    const canSwitch = usesOnboardStages();
    dpiStages.hidden = !hasStages;
    dpiStagesHint.hidden = !hasStages;
    dpiSingle.hidden = hasStages;
    writeDpiButton.hidden = !hasStages;
    applyDpiButton.hidden = canSwitch;
    if (!hasStages) return;

    dpiStagesHint.textContent = layout.defaultIndexByte !== null
      ? 'Празно поле = изключено ниво · кръгче = по подразбиране'
      : 'Празно поле = изключено ниво';

    const source = onboard.userEntry ? onboard.profile : onboard.factory;
    const stages = readDpiStages(source, layout);
    const current = Number(dpiCurrent.dataset.dpi);
    let selected = layout.defaultIndexByte !== null ? source[layout.defaultIndexByte] : stages.indexOf(current);
    if (selected < 0 || selected > 4 || isUnusedDpi(stages[selected])) selected = 0;

    dpiStages.replaceChildren(...stages.map((value, slot) => {
      const row = document.createElement('label');
      row.className = 'dpi-stage';
      row.innerHTML = `
        <input type="radio" name="dpi-default" value="${slot}" />
        <span>Ниво ${slot + 1}</span>
        <input type="number" class="field__select" data-dpi-stage="${slot}" placeholder="изключено" />
        <button type="button" class="panel-btn" data-device-action="activate-stage" data-stage="${slot}">Включи</button>
      `;
      row.querySelector('[data-device-action]').hidden = !canSwitch;
      const input = row.querySelector('[data-dpi-stage]');
      input.min = dpiInput.min;
      input.max = dpiInput.max;
      input.step = dpiInput.step;
      input.value = isUnusedDpi(value) ? '' : value;
      row.querySelector('[type="radio"]').checked = slot === selected;
      return row;
    }));
    markActiveStage();
  };

  const selectedStage = () => Number(dpiStages.querySelector('[name="dpi-default"]:checked')?.value ?? 0);

  // В режим „профил от паметта“ DPI отчитането (0x2202) не показва вярно нивото на G309,
  // затова там се чете текущото ниво (0xB0) и стойността му от профила
  const showCurrentDpi = async () => {
    if (usesOnboardStages()) {
      try {
        const index = await mouse.readCurrentDpiIndex();
        const stages = storedStages();
        if (index <= 4 && !isUnusedDpi(stages[index])) {
          currentStage = index;
          dpiCurrent.dataset.dpi = stages[index];
          dpiCurrent.textContent = `ниво ${index + 1} · ${stages[index]} DPI`;
          markActiveStage();
          return stages[index];
        }
      } catch (error) {
        diagnostics.dpiIndexError = error.message;
      }
    }

    const { dpi } = await mouse.readDpi();
    currentStage = null;
    dpiCurrent.dataset.dpi = dpi;
    dpiCurrent.textContent = `${dpi} DPI`;
    markActiveStage();
    return dpi;
  };

  // Сменя текущото ниво веднага, както бутонът DPI на мишката (ползва записаната в мишката стойност)
  const activateStage = async (event) => {
    const slot = Number(event.target.closest('[data-stage]').dataset.stage);
    const stored = storedStages()[slot];
    if (isUnusedDpi(stored)) throw new Error(`Ниво ${slot + 1} е изключено в мишката. Първо запиши DPI нивата.`);

    await mouse.setCurrentDpiIndex(slot);
    await showCurrentDpi();

    const input = dpiStages.querySelector(`[data-dpi-stage="${slot}"]`);
    const edited = input.value !== '' && Number(input.value) !== stored;
    setLog(`Мишката е на ниво ${slot + 1} (${stored} DPI).` +
      (edited ? ' Промените в полетата важат след „Запиши DPI нивата в мишката“.' : ''));
  };

  // Чете профилите от паметта. Ако потребителски профил няма, работи с копие на фабричния.
  const loadOnboard = async () => {
    const info = await mouse.readOnboardInfo();
    diagnostics.onboardDescription = hex(info.raw);
    diagnostics.mode = await mouse.readMode();

    const romSector = await mouse.readSector(0x0100, info.sectorSize);
    const userSector = await mouse.readSector(0x0000, info.sectorSize);
    diagnostics.romDirectory = hex(romSector);
    diagnostics.userDirectory = hex(userSector);

    const romDirectory = LogitechHidpp.parseDirectory(romSector);
    const userDirectory = LogitechHidpp.parseDirectory(userSector);
    if (romDirectory.length === 0) throw new Error('Не са намерени фабрични профили в мишката.');

    // Работи се с профила, който мишката ползва в момента, ако е потребителски
    const currentProfile = await mouse.readCurrentProfile().catch(() => null);
    diagnostics.currentProfile = currentProfile === null ? 'неизвестен' : `0x${currentProfile.toString(16).padStart(4, '0')}`;

    const factory = await mouse.readSector(romDirectory[0].sector, info.sectorSize);
    const userEntry = userDirectory.find((entry) => entry.enabled && entry.sector === currentProfile) ||
      userDirectory.find((entry) => entry.enabled) || userDirectory[0];
    const profile = userEntry ? await mouse.readSector(userEntry.sector, info.sectorSize) : factory.slice();
    diagnostics.factoryProfile = hex(factory);
    diagnostics.userProfile = userEntry ? hex(profile) : null;

    const layout = detectLayout(factory, dpiCaps?.values);
    diagnostics.detectedLayout = layout;

    onboard = { info, factory, profile, userEntry, layout, mode: diagnostics.mode };
  };

  const connect = async () => {
    const device = await LogitechHidpp.requestDevice();
    if (!device) return;
    mouse = device;
    help.hidden = true;

    setLog('Чета информацията от мишката…');
    const name = await mouse.readName().catch(() => 'Logitech мишка');
    const battery = await mouse.supports(LogitechHidpp.FEATURES.UNIFIED_BATTERY)
      ? await mouse.readBattery().catch(() => null)
      : null;
    const connection = mouse.index === 0xff ? 'Bluetooth или кабел' : 'безжичен приемник';
    const batteryText = battery ? ` · батерия ${battery.percent}%${battery.charging ? ' (зарежда)' : ''}` : '';

    dpiCaps = null;
    if (await mouse.supports(LogitechHidpp.FEATURES.EXTENDED_DPI)) {
      dpiCaps = await mouse.readDpiCapabilities();
      const { dpi } = await mouse.readDpi();
      const { values } = dpiCaps;
      dpiInput.min = values[0];
      dpiInput.max = values[values.length - 1];
      dpiInput.step = values.length > 1 ? values[1] - values[0] : 1;
      dpiInput.value = dpi;
      dpiRange.textContent = `(${values[0]}–${values[values.length - 1]})`;
      dpiCurrent.dataset.dpi = dpi;
      dpiCurrent.textContent = `${dpi} DPI`;
    }

    diagnostics = {
      name,
      deviceIndex: mouse.index,
      userAgent: navigator.userAgent,
      dpiValues: dpiCaps ? `${dpiCaps.values[0]}–${dpiCaps.values[dpiCaps.values.length - 1]} (${dpiCaps.values.length} стойности)` : null
    };

    // Проблем с профилите не трябва да пречи на името, батерията и DPI
    onboard = null;
    let onboardMessage = '';
    if (await mouse.supports(LogitechHidpp.FEATURES.ONBOARD_PROFILES)) {
      try {
        await loadOnboard();
        if (onboard.layout.buttons === null) {
          onboardMessage = `Профилите в паметта са във формат ${onboard.info.format}, който още не е разпознат. ` +
            'Натисни „Копирай техническа информация“ и я изпрати, за да се добави поддръжка.';
        } else if (!onboard.layout.dpi && dpiCaps) {
          onboardMessage = 'Бутоните ще се записват, но мястото на DPI в профила не е разпознато, затова DPI се прилага само веднага. ' +
            'Натисни „Копирай техническа информация“ и я изпрати, за да се добави.';
        }
      } catch (error) {
        console.error(error);
        diagnostics.onboardError = error.message;
        onboard = null;
        onboardMessage = `Профилите в паметта не могат да се прочетат: ${error.message}`;
      }
    } else {
      onboardMessage = 'Тази мишка не поддържа профили в паметта, затова бутоните не могат да се записват.';
    }

    deviceText = `${name} · ${connection}${batteryText}`;
    dpiBlock.hidden = !dpiCaps;
    buttonsBlock.hidden = !onboard;
    onboardNote.hidden = !onboardMessage;
    onboardNote.textContent = onboardMessage;
    details.hidden = false;
    connectButton.hidden = true;
    disconnectButton.hidden = false;
    renderDevice();
    renderDpi();
    if (dpiCaps) await showCurrentDpi().catch(() => {});
    setLog('Мишката е свързана.');
  };

  const disconnect = async () => {
    await mouse?.close();
    mouse = null;
    onboard = null;
    details.hidden = true;
    connectButton.hidden = false;
    disconnectButton.hidden = true;
    setLog('Връзката е прекъсната.');
  };

  const nearestDpi = (value) => dpiCaps.values.reduce(
    (best, candidate) => (Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best),
    dpiCaps.values[0]
  );

  // Прилага DPI веднага (без запис в паметта) и проверява дали мишката го е приела
  const applyDpi = async () => {
    const hasStages = !dpiStages.hidden;
    const input = hasStages ? dpiStages.querySelector(`[data-dpi-stage="${selectedStage()}"]`) : dpiInput;
    if (!input.value) throw new Error('Избраното ниво е изключено. Въведи DPI за него.');

    const dpi = nearestDpi(Number(input.value));
    input.value = dpi;
    await mouse.setDpi(dpi, dpiCaps);
    const actual = await showCurrentDpi();

    if (actual !== dpi) {
      setLog(onboard?.mode === MODE_ONBOARD
        ? 'Мишката е в режим „профил от паметта“ и използва DPI от профила. Натисни „Запиши DPI нивата в мишката“.'
        : `Мишката не прие ${dpi} DPI (отчита ${actual}).`, true);
    } else {
      setLog(hasStages
        ? `DPI е ${dpi}. За да остане и след рестарт, натисни „Запиши DPI нивата в мишката“.`
        : `DPI е ${dpi}. Мястото на DPI в профила не е разпознато, затова след рестарт на мишката ще се върне.`);
    }
  };

  // Чете нивата от полетата: празно = изключено, останалите се закръглят до поддържана стойност
  const readStageInputs = () => {
    const stages = [...dpiStages.querySelectorAll('[data-dpi-stage]')].map((input) => {
      if (!input.value) return 0;
      const dpi = nearestDpi(Number(input.value));
      input.value = dpi;
      return dpi;
    });
    if (!stages[selectedStage()]) throw new Error('Отбелязаното ниво не може да е изключено.');
    return stages;
  };

  // Записва профила (бутони + DPI) и директорията, проверява записаното и включва режима „профил от паметта“
  // buttons: 'plan' (функциите от сайта), 'factory' (фабричните) или 'keep' (без промяна)
  const writeProfile = async ({ buttons = 'plan', dpi = true } = {}) => {
    const { info, factory, userEntry, layout } = onboard;
    if (buttons !== 'keep' && layout.buttons === null) {
      throw new Error('Форматът на профила не е разпознат, затова нищо не е записано.');
    }

    const profile = (userEntry ? onboard.profile : factory).slice();
    const { plan, skipped } = buildPlan();

    if (buttons !== 'keep') {
      for (let index = 0; index < info.buttons; index += 1) {
        const offset = layout.buttons + index * 4;
        const entry = buttons === 'plan' ? plan.get(index) : null;
        const bytes = !entry || entry.encoded === 'factory' ? factory.slice(offset, offset + 4) : entry.encoded;
        profile.set(bytes, offset);
      }
    }

    const writeDpi = dpi && dpiCaps && layout.dpi;
    const stages = writeDpi ? readStageInputs() : null;
    const chosenStage = selectedStage();
    if (writeDpi) {
      // 5 нива (little-endian). Y = X само ако мишката ползва Y; иначе Y остава фабричното (0). LOD не се пипа.
      const { offset, stride, hasY, defaultIndexByte } = layout.dpi;
      stages.forEach((value, slot) => {
        const at = offset + slot * stride;
        profile[at] = value & 0xff;
        profile[at + 1] = value >> 8;
        if (hasY) {
          profile[at + 2] = value & 0xff;
          profile[at + 3] = value >> 8;
        } else if (stride >= 4) {
          profile[at + 2] = factory[at + 2];
          profile[at + 3] = factory[at + 3];
        }
      });
      if (defaultIndexByte !== null) profile[defaultIndexByte] = chosenStage;
    }

    LogitechHidpp.withCrc(profile);

    const sector = userEntry ? userEntry.sector : 0x0001;
    if (sector >= info.sectors) throw new Error('Няма свободен сектор за профила в паметта на мишката.');

    setLog('Записвам профила в мишката…');
    await mouse.writeSector(sector, profile);
    const check = await mouse.readSector(sector, info.sectorSize);
    if (!check.every((byte, index) => byte === profile[index])) {
      throw new Error('Проверката след записа не съвпада. Профилът не е активиран.');
    }

    if (!userEntry) {
      await mouse.writeSector(0x0000, LogitechHidpp.buildDirectory([{ sector, enabled: 1 }], info.sectorSize));
    }

    // Мишката чете профила от паметта при смяна на режима, затова за миг минава в „управлявана
    // от компютъра“ и обратно, после профилът се избира отново (само повторният избор не стига)
    await mouse.setMode(MODE_HOST).catch((error) => {
      diagnostics.hostModeError = error.message;
    });
    await mouse.setMode(MODE_ONBOARD);
    await mouse.setCurrentProfile(sector).catch((error) => {
      diagnostics.setCurrentProfileError = error.message;
    });
    // Мишката минава на отбелязаното ниво веднага
    if (writeDpi) {
      await mouse.setCurrentDpiIndex(chosenStage).catch((error) => {
        diagnostics.setDpiIndexError = error.message;
      });
    }
    await loadOnboard();
    renderDevice();
    renderDpi();
    const actualDpi = dpiCaps ? await showCurrentDpi() : null;

    // Проверка по текущото ниво; ако то не може да се прочете, DPI отчитането не е надеждно и не се проверява
    const expectedDpi = writeDpi ? stages[chosenStage] : null;
    diagnostics.afterWrite = { sector, expectedDpi, actualDpi, currentStage };
    if (expectedDpi !== null && currentStage !== null && currentStage !== chosenStage) {
      setLog(`Профилът е записан, но мишката е на ниво ${currentStage + 1} вместо ${chosenStage + 1}. ` +
        'Изключи и включи мишката от копчето отдолу, за да зареди новите нива, и свържи пак.', true);
      return;
    }

    if (buttons === 'factory') {
      setLog('Фабричните бутони са върнати в мишката.');
    } else if (buttons === 'keep') {
      setLog(layout.dpi.defaultIndexByte !== null
        ? `DPI нивата са записани в мишката (по подразбиране: ниво ${chosenStage + 1}).`
        : 'DPI нивата са записани в мишката. С бутона DPI превключваш между тях.');
    } else {
      setLog(`Записано в мишката.${skipped.length ? ` Пропуснати: ${skipped.length} (виж списъка).` : ''}`);
    }
  };

  const run = (action) => async (...args) => {
    if (busy) return;
    busy = true;
    panel.classList.add('is-busy');
    try {
      await action(...args);
    } catch (error) {
      console.error(error, error.cause);
      setLog(error.message || String(error), true);
      if (error.code === 'open-failed') help.hidden = false;
    } finally {
      busy = false;
      panel.classList.remove('is-busy');
    }
  };

  const actions = {
    connect: run(connect),
    'copy-commands': run(async () => {
      await navigator.clipboard.writeText(LINUX_COMMANDS);
      setLog('Командите са копирани. Постави ги в терминала.');
    }),
    'copy-diagnostics': run(async () => {
      if (mouse) {
        diagnostics.features = Object.fromEntries(Object.entries(LogitechHidpp.FEATURES).map(
          ([featureName, id]) => [featureName, mouse.featureIndexes.get(id) ?? 'не е проверена']
        ));
      }
      diagnostics.events = events;
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setLog('Техническата информация е копирана. Изпрати я, за да се добави поддръжка за тази мишка.');
    }),
    disconnect: run(disconnect),
    'apply-dpi': run(applyDpi),
    'activate-stage': run(activateStage),
    write: run(() => writeProfile()),
    'write-dpi': run(() => writeProfile({ buttons: 'keep' })),
    factory: run(() => writeProfile({ buttons: 'factory', dpi: false }))
  };

  panel.addEventListener('click', (event) => {
    const action = event.target.closest('[data-device-action]')?.dataset.deviceAction;
    if (action) actions[action](event);
  });

  // Докато панелът е отворен, текущото ниво се обновява – видимо е и когато се натисне бутонът DPI на мишката
  setInterval(() => {
    if (mouse && !busy && !panel.hidden && usesOnboardStages()) showCurrentDpi().catch(() => {});
  }, 2000);

  // Планът се обновява, когато се смени профилът или се отвори секцията
  device.addEventListener('profilechange', renderDevice);
  tab.addEventListener('click', renderDevice);

  navigator.hid?.addEventListener('disconnect', (event) => {
    if (mouse && event.device === mouse.hid) {
      mouse = null;
      onboard = null;
      details.hidden = true;
      connectButton.hidden = false;
      disconnectButton.hidden = true;
      setLog('Мишката беше изключена.', true);
    }
  });
})();
