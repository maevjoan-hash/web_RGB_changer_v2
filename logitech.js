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
  const PROFILE_BUTTONS_OFFSET = 32;
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
    <p class="settings-hint">Свържи Logitech мишка (напр. G309), за да запишеш DPI и функциите на бутоните
      в паметта ѝ. Нужен е Chrome или Edge на компютър. При Bluetooth мишката трябва първо да е сдвоена със системата.</p>
    <div class="panel-actions">
      <button type="button" class="panel-btn" data-device-action="connect">Свържи мишката</button>
      <button type="button" class="panel-btn" data-device-action="disconnect" hidden>Прекъсни</button>
    </div>

    <div class="device-details" id="device-details" hidden>
      <p class="device-summary" id="device-summary"></p>

      <div class="device-block" id="device-dpi-block" hidden>
        <label class="field">
          <span class="field__label">DPI (чувствителност) <span id="device-dpi-range"></span></span>
          <input type="number" class="field__select" id="device-dpi" />
        </label>
        <div class="panel-actions">
          <button type="button" class="panel-btn" data-device-action="apply-dpi">Приложи DPI веднага</button>
        </div>
      </div>

      <div class="device-block" id="device-buttons-block" hidden>
        <p class="field__label">Бутоните в мишката сега</p>
        <ul class="binding-list" id="device-buttons"></ul>
        <p class="field__label" id="device-plan-title"></p>
        <ul class="binding-list" id="device-plan"></ul>
        <div class="panel-actions">
          <button type="button" class="panel-btn" data-device-action="write">Запиши в мишката</button>
          <button type="button" class="panel-btn" data-device-action="factory">Върни фабричните бутони</button>
        </div>
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
  const buttonsBlock = panel.querySelector('#device-buttons-block');
  const buttonsList = panel.querySelector('#device-buttons');
  const planTitle = panel.querySelector('#device-plan-title');
  const planList = panel.querySelector('#device-plan');
  const log = panel.querySelector('#device-log');
  const help = panel.querySelector('#device-help');
  const isLinux = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

  // Същото правило като linux/42-logitech-webhid.rules в проекта
  const LINUX_COMMANDS = [
    "sudo tee /etc/udev/rules.d/42-logitech-webhid.rules > /dev/null << 'EOF'",
    'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="046d", TAG+="uaccess"',
    'SUBSYSTEM=="hidraw", KERNELS=="0005:046D:*", TAG+="uaccess"',
    'EOF',
    'sudo udevadm control --reload-rules && sudo udevadm trigger'
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
  let busy = false;

  const setLog = (message, isError = false) => {
    log.textContent = message;
    log.classList.toggle('device-log--error', isError);
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

    buttonsList.replaceChildren(...listItems(
      Array.from({ length: onboard.info.buttons }, (_, index) => {
        const bytes = onboard.profile.slice(PROFILE_BUTTONS_OFFSET + index * 4, PROFILE_BUTTONS_OFFSET + index * 4 + 4);
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
          const factory = onboard.factory.slice(PROFILE_BUTTONS_OFFSET + index * 4, PROFILE_BUTTONS_OFFSET + index * 4 + 4);
          return `${name} → ${LogitechButtons.describe(factory)} (фабрично)`;
        }
        return `${name} → ${entry.description}`;
      }),
      ...skipped.map((text) => `Пропуснато – ${text}`)
    ]));
  };

  // Чете профилите от паметта. Ако потребителски профил няма, работи с копие на фабричния.
  const loadOnboard = async () => {
    const info = await mouse.readOnboardInfo();
    if (info.memory !== 0x01 || info.format > 0x05) {
      throw new Error('Форматът на паметта на тази мишка не се поддържа.');
    }

    const romDirectory = LogitechHidpp.parseDirectory(await mouse.readSector(0x0100, info.sectorSize));
    const userDirectory = LogitechHidpp.parseDirectory(await mouse.readSector(0x0000, info.sectorSize));
    if (romDirectory.length === 0) throw new Error('Не са намерени фабрични профили в мишката.');

    const factory = await mouse.readSector(romDirectory[0].sector, info.sectorSize);
    const userEntry = userDirectory.find((entry) => entry.enabled) || userDirectory[0];
    const profile = userEntry ? await mouse.readSector(userEntry.sector, info.sectorSize) : factory.slice();

    onboard = { info, factory, profile, userEntry, mode: await mouse.readMode() };
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
    }

    onboard = null;
    if (await mouse.supports(LogitechHidpp.FEATURES.ONBOARD_PROFILES)) await loadOnboard();

    deviceText = `${name} · ${connection}${batteryText}`;
    dpiBlock.hidden = !dpiCaps;
    buttonsBlock.hidden = !onboard;
    details.hidden = false;
    connectButton.hidden = true;
    disconnectButton.hidden = false;
    renderDevice();
    setLog(onboard ? 'Мишката е свързана.' : 'Мишката е свързана, но не поддържа профили в паметта.');
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

  const applyDpi = async () => {
    const dpi = nearestDpi(Number(dpiInput.value));
    dpiInput.value = dpi;
    await mouse.setDpi(dpi, dpiCaps);
    setLog(`DPI е зададен на ${dpi}. За да остане и след рестарт на мишката, натисни „Запиши в мишката“.`);
  };

  // Записва профила (бутони + DPI) и директорията, проверява записаното и включва режима „профил от паметта“
  const writeProfile = async ({ factoryButtons = false } = {}) => {
    const { info, factory, userEntry } = onboard;
    const profile = (userEntry ? onboard.profile : factory).slice();
    const { plan, skipped } = buildPlan();

    for (let index = 0; index < info.buttons; index += 1) {
      const offset = PROFILE_BUTTONS_OFFSET + index * 4;
      const entry = factoryButtons ? null : plan.get(index);
      const bytes = !entry || entry.encoded === 'factory' ? factory.slice(offset, offset + 4) : entry.encoded;
      profile.set(bytes, offset);
    }

    if (dpiCaps && !factoryButtons) {
      // DPI по подразбиране е на индекс profile[1] в списъка от 5 стойности (little-endian) от байт 3
      const dpi = nearestDpi(Number(dpiInput.value));
      const slot = Math.min(profile[1], 4);
      profile[3 + slot * 2] = dpi & 0xff;
      profile[4 + slot * 2] = dpi >> 8;
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

    await mouse.setMode(MODE_ONBOARD);
    await loadOnboard();
    renderDevice();
    setLog(factoryButtons
      ? 'Фабричните бутони са върнати в мишката.'
      : `Записано в мишката.${skipped.length ? ` Пропуснати: ${skipped.length} (виж списъка).` : ''}`);
  };

  const run = (action) => async () => {
    if (busy) return;
    busy = true;
    panel.classList.add('is-busy');
    try {
      await action();
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
    disconnect: run(disconnect),
    'apply-dpi': run(applyDpi),
    write: run(() => writeProfile()),
    factory: run(() => writeProfile({ factoryButtons: true }))
  };

  panel.addEventListener('click', (event) => {
    const action = event.target.closest('[data-device-action]')?.dataset.deviceAction;
    if (action) actions[action]();
  });

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
