// --- SONY СЛУШАЛКИ (WH-1000XM5) ПРЕЗ WEB SERIAL ---
// Приложението на Sony говори с слушалките по Bluetooth RFCOMM услуга (V2: 956c7b26-…). Chrome 117+ я отваря
// с Web Serial, без инсталиране. Кадър: 3E | тип, номер, дължина (4 байта), данни, сума | 3C; байтовете
// 3C/3D/3E в средата се пишат като 3D, b & 0xEF. Всяко съобщение се потвърждава с ACK (тип 01, номер 1 − n).
// Протоколът следва WebMDR (github.com/abnormal749/WebMDR, MIT), Gadgetbridge и xm5-mode-switch.
const SonyMdr = (() => {
  const START = 0x3e;
  const END = 0x3c;
  const ESCAPE = 0x3d;
  const TYPE = { ACK: 0x01, COMMAND: 0x0c, COMMAND_2: 0x0e };
  const SERVICE_V2 = '956c7b26-d49a-4ba8-b03f-b17d393cb6e2';
  const SERVICE_V1 = '96cc203e-5068-46ad-b32d-e316f5e069ba';

  const encodeFrame = (type, seq, payload = []) => {
    const length = payload.length;
    const body = [type, seq, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, ...payload];
    body.push(body.reduce((sum, byte) => sum + byte, 0) & 0xff);
    const out = [START];
    body.forEach((byte) => {
      if (byte === START || byte === END || byte === ESCAPE) out.push(ESCAPE, byte & 0xef);
      else out.push(byte);
    });
    out.push(END);
    return Uint8Array.from(out);
  };

  const parseBody = (body) => {
    if (body.length < 7) return null;
    const length = ((body[2] << 24) | (body[3] << 16) | (body[4] << 8) | body[5]) >>> 0;
    if (body.length !== length + 7) return null;
    const checksum = body.slice(0, -1).reduce((sum, byte) => sum + byte, 0) & 0xff;
    if (checksum !== body[body.length - 1]) return null;
    return { type: body[0], seq: body[1], payload: body.slice(6, 6 + length) };
  };

  // Байтовете идват на парчета – декодерът пази незавършения кадър между тях
  class Decoder {
    constructor() {
      this.body = null;
      this.escaped = false;
    }

    push(bytes) {
      const frames = [];
      for (const byte of bytes) {
        if (byte === START) {
          this.body = [];
          this.escaped = false;
        } else if (!this.body) {
          // Байт извън кадър – прескача се
        } else if (byte === END) {
          const frame = parseBody(this.body);
          if (frame) frames.push(frame);
          this.body = null;
        } else if (byte === ESCAPE) {
          this.escaped = true;
        } else {
          this.body.push(this.escaped ? byte | 0x10 : byte);
          this.escaped = false;
        }
      }
      return frames;
    }
  }

  return { TYPE, SERVICE_V1, SERVICE_V2, encodeFrame, Decoder };
})();

// --- ВРЪЗКА: команди една по една, всяка чака ACK; отговорите се разпознават по код и подтип ---
class SonyHeadphones {
  constructor(port) {
    this.port = port;
    this.decoder = new SonyMdr.Decoder();
    this.txSeq = 0;
    this.ackWaiter = null;
    this.replyWaiters = [];
    this.lastReceived = '';
    this.chain = Promise.resolve();
    this.onMessage = null;
    this.onClose = null;
  }

  async open() {
    await this.port.open({ baudRate: 9600 }); // RFCOMM не ползва скорост, но Web Serial я изисква
    this.writer = this.port.writable.getWriter();
    this.reading = this.readLoop();
  }

  async readLoop() {
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.decoder.push(value).forEach((frame) => this.handle(frame));
      }
    } catch {
      // Връзката е прекъсната
    } finally {
      this.reader.releaseLock();
      this.onClose?.();
    }
  }

  async close() {
    this.onClose = null;
    await this.reader?.cancel().catch(() => {});
    await this.reading?.catch(() => {});
    this.writer?.releaseLock();
    await this.port.close().catch(() => {});
  }

  write(type, seq, payload) {
    return this.writer.write(SonyMdr.encodeFrame(type, seq, payload));
  }

  handle(frame) {
    if (frame.type === SonyMdr.TYPE.ACK) {
      // Слушалките потвърждават с номер 1 − нашия
      if (frame.seq !== this.txSeq && this.ackWaiter) this.ackWaiter();
      return;
    }
    this.write(SonyMdr.TYPE.ACK, 1 - frame.seq, []).catch(() => {});
    // Повторно изпратено съобщение (същият номер и данни) се потвърждава, но не се обработва пак
    const key = `${frame.seq}:${frame.payload.join(',')}`;
    if (key === this.lastReceived) return;
    this.lastReceived = key;

    const [code, subtype] = frame.payload;
    this.replyWaiters = this.replyWaiters.filter((waiter) => {
      if (waiter.code !== code || waiter.subtype !== subtype) return true;
      waiter.resolve(frame.payload);
      return false;
    });
    this.onMessage?.(frame.payload);
  }

  send(payload, type = SonyMdr.TYPE.COMMAND) {
    const task = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiter = null;
        reject(new Error(I18n.t('Слушалките не потвърдиха командата.')));
      }, 1500);
      this.ackWaiter = () => {
        clearTimeout(timer);
        this.ackWaiter = null;
        this.txSeq = 1 - this.txSeq;
        resolve();
      };
      this.write(type, this.txSeq, payload).catch((error) => {
        clearTimeout(timer);
        this.ackWaiter = null;
        reject(error);
      });
    });
    const result = this.chain.then(task, task);
    this.chain = result.catch(() => {});
    return result;
  }

  // Изпраща заявка и чака отговора с даден код (подтипът е същият като на заявката)
  request(payload, replyCode, timeout = 2500) {
    let waiter;
    const reply = new Promise((resolve, reject) => {
      waiter = { code: replyCode, subtype: payload[1], resolve };
      this.replyWaiters.push(waiter);
      setTimeout(() => {
        this.replyWaiters = this.replyWaiters.filter((other) => other !== waiter);
        reject(new Error(I18n.t('Слушалките не отговориха.')));
      }, timeout);
    });
    reply.catch(() => {});
    return this.send(payload).then(() => reply);
  }
}

// --- СТРАНИЦАТА ЗА СЛУШАЛКИТЕ ---

(() => {
  const { t } = I18n;

  // Готовите настройки на еквалайзера (кодове от Gadgetbridge)
  const EQ_PRESETS = [
    { id: 0x00, label: t('Изключен') },
    { id: 0x10, label: t('Ярък') },
    { id: 0x11, label: t('Енергичен') },
    { id: 0x12, label: t('Мек') },
    { id: 0x13, label: t('Спокоен') },
    { id: 0x14, label: t('Вокали') },
    { id: 0x15, label: t('Усилени високи') },
    { id: 0x16, label: t('Усилен бас') },
    { id: 0x17, label: t('Реч') },
    { id: 0xa0, label: t('Ръчна') },
    { id: 0xa1, label: t('Потребителска 1') },
    { id: 0xa2, label: t('Потребителска 2') }
  ];

  // --- ИНТЕРФЕЙС ---
  const svg = document.querySelector('.headphones-svg');
  const bar = document.querySelector('[data-device-actions]');
  const columns = document.querySelectorAll('.settings-column');
  if (!svg || !bar || columns.length < 2) return;

  const EQ_BANDS = ['400', '1k', '2.5k', '6.3k', '16k'];
  const MODES = [
    { id: 'nc', label: t('Шумопотискане') },
    { id: 'ambient', label: t('Околен звук') },
    { id: 'off', label: t('Изключено') }
  ];

  const [soundPanels, devicePanels] = [...columns].map((column) => column.querySelector('.settings-panels'));
  soundPanels.innerHTML = `
    <div class="settings-panel" data-panel="1">
      <fieldset class="effect-options hp-modes hp-control">
        <legend class="visually-hidden">${t('Режим')}</legend>
        ${MODES.map(({ id, label }) => `<label class="effect-option"><input type="radio" name="hp-mode" value="${id}" /><span>${label}</span></label>`).join('')}
      </fieldset>
      <label class="range-field hp-control">
        <span class="range-field__label">${t('Ниво на околния звук')} <output id="hp-level-value"></output></span>
        <input type="range" id="hp-level" min="1" max="20" step="1" />
      </label>
      <label class="hp-toggle hp-control">
        <input type="checkbox" id="hp-voice" />
        <span>${t('Фокус върху гласа')}<small>${t('Пропуска говор, заглушава останалия околен шум')}</small></span>
      </label>
    </div>
    <div class="settings-panel" data-panel="2">
      <label class="field hp-control">
        <span class="field__label">${t('Готова настройка')}</span>
        <select class="field__select" id="hp-eq-preset"></select>
      </label>
      <label class="range-field hp-control">
        <span class="range-field__label">Clear Bass <output id="hp-bass-value"></output></span>
        <input type="range" id="hp-bass" min="-10" max="10" step="1" />
      </label>
      <div class="hp-eq hp-control" role="group" aria-label="${t('Ленти на еквалайзера')}">
        ${EQ_BANDS.map((band, index) => `
          <label class="hp-eq__band">
            <output id="hp-band-value-${index}"></output>
            <input type="range" data-band="${index}" min="-10" max="10" step="1" aria-label="${band} Hz" />
            <span>${band}</span>
          </label>`).join('')}
      </div>
      <p class="settings-hint">${t('Промяна на лентите превключва на „Ръчна“ настройка.')}</p>
    </div>
  `;
  devicePanels.innerHTML = `
    <div class="settings-panel" data-panel="3">
      <label class="hp-toggle hp-control">
        <input type="checkbox" id="hp-dsee" />
        <span>DSEE Extreme<small>${t('Възстановява детайли в компресирана музика')}</small></span>
      </label>
      <label class="hp-toggle hp-control">
        <input type="checkbox" id="hp-stc" />
        <span>Speak-to-Chat<small>${t('Спира музиката, когато заговориш')}</small></span>
      </label>
    </div>
    <div class="settings-panel" data-panel="4">
      <dl class="hp-info">
        <dt>${t('Модел')}</dt><dd id="hp-info-model">–</dd>
        <dt>${t('Фърмуер')}</dt><dd id="hp-info-firmware">–</dd>
        <dt>${t('Батерия')}</dt><dd id="hp-info-battery">–</dd>
      </dl>
    </div>
  `;

  // Менютата на двете колони (същото поведение като на другите страници)
  const selectTab = (tab) => {
    const column = tab.closest('.settings-menu');
    column.querySelectorAll('.settings-tab').forEach((other) => {
      other.classList.toggle('active', other === tab);
      if (other === tab) other.setAttribute('aria-current', 'true');
      else other.removeAttribute('aria-current');
    });
    column.querySelectorAll('.settings-panel').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
    const menuButton = column.querySelector('[data-settings-menu-btn]');
    menuButton.textContent = `${menuButton.dataset.menuTitle}: ${tab.textContent} ▾`;
  };
  document.querySelectorAll('.settings-tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab)));
  columns.forEach((column) => selectTab(column.querySelector('.settings-tab')));

  // --- СЪСТОЯНИЕ И ПОКАЗВАНЕ ---
  const state = {
    connected: false,
    mode: null, // nc | ambient | off
    ambientLevel: 10,
    focusVoice: false,
    eqPreset: null,
    clearBass: 0,
    bands: [0, 0, 0, 0, 0],
    dsee: null,
    speakToChat: null,
    battery: null, // { level, charging }
    model: '',
    firmware: ''
  };

  const $ = (selector) => document.querySelector(selector);
  const modeInputs = document.querySelectorAll('input[name="hp-mode"]');
  const levelInput = $('#hp-level');
  const voiceInput = $('#hp-voice');
  const presetSelect = $('#hp-eq-preset');
  const bassInput = $('#hp-bass');
  const bandInputs = document.querySelectorAll('[data-band]');
  const dseeInput = $('#hp-dsee');
  const stcInput = $('#hp-stc');

  presetSelect.innerHTML = EQ_PRESETS.map(({ id, label }) => `<option value="${id}">${label}</option>`).join('');

  const render = () => {
    svg.dataset.mode = state.connected ? state.mode || 'unknown' : 'unknown';
    const modeLabel = MODES.find(({ id }) => id === state.mode)?.label;
    $('#hp-status-mode').textContent = !state.connected
      ? t('Не са свързани')
      : state.mode === 'ambient' ? `${modeLabel} · ${state.ambientLevel}` : modeLabel || t('Свързани');
    const batteryText = !state.battery ? ''
      : t(state.battery.charging ? 'Батерия {level}% · зарежда' : 'Батерия {level}%', { level: state.battery.level });
    $('#hp-status-battery').textContent = state.connected ? batteryText : '';

    modeInputs.forEach((input) => {
      input.checked = input.value === state.mode;
    });
    levelInput.value = state.ambientLevel;
    levelInput.disabled = state.mode !== 'ambient';
    $('#hp-level-value').textContent = state.ambientLevel;
    voiceInput.checked = state.focusVoice;
    voiceInput.disabled = state.mode !== 'ambient';

    if (state.eqPreset !== null) presetSelect.value = String(state.eqPreset);
    bassInput.value = state.clearBass;
    $('#hp-bass-value').textContent = state.clearBass > 0 ? `+${state.clearBass}` : state.clearBass;
    bandInputs.forEach((input, index) => {
      input.value = state.bands[index];
      $(`#hp-band-value-${index}`).textContent = state.bands[index] > 0 ? `+${state.bands[index]}` : state.bands[index];
    });
    dseeInput.checked = Boolean(state.dsee);
    dseeInput.closest('.hp-toggle').hidden = state.connected && state.dsee === null;
    stcInput.checked = Boolean(state.speakToChat);
    stcInput.closest('.hp-toggle').hidden = state.connected && state.speakToChat === null;

    $('#hp-info-model').textContent = state.model || '–';
    $('#hp-info-firmware').textContent = state.firmware || '–';
    $('#hp-info-battery').textContent = batteryText || '–';

    document.querySelectorAll('.settings-panel').forEach((panel) => {
      panel.classList.toggle('is-disabled', !state.connected);
    });
  };

  // --- ВРЪЗКА СЪС СЛУШАЛКИТЕ ---
  bar.innerHTML = `
    <div class="device-bar">
      <div class="panel-actions save-bar__row">
        <button type="button" class="panel-btn panel-btn--primary" data-hp-action="connect">${t('Свържи слушалките')}</button>
        <span class="save-bar__group" data-connected hidden>
          <button type="button" class="panel-btn" data-hp-action="refresh">${t('Обнови')}</button>
          <details class="action-menu">
            <summary class="panel-btn">${t('Още')} ▾</summary>
            <div class="action-menu__list">
              <button type="button" class="panel-btn" data-hp-action="copy-diagnostics">${t('Техническа информация')}</button>
              <hr />
              <button type="button" class="panel-btn panel-btn--danger" data-hp-action="disconnect">${t('Прекъсни')}</button>
            </div>
          </details>
        </span>
      </div>
      <p class="device-log" id="device-log" role="status"></p>
      <div class="device-help" id="hp-help" hidden>
        <p>${t('Слушалките трябва да са сдвоени с компютъра по Bluetooth.')}
          ${t('Приложението Sony Headphones Connect на телефона заема същия канал – затвори го или изключи Bluetooth на телефона и опитай пак.')}
          ${t('Нужен е Chrome или Edge 117+ на компютър.')}</p>
      </div>
    </div>
  `;
  const deviceBar = bar.querySelector('.device-bar');
  const connectButton = bar.querySelector('[data-hp-action="connect"]');
  const connectedGroup = bar.querySelector('[data-connected]');
  const log = bar.querySelector('#device-log');
  const help = bar.querySelector('#hp-help');
  const AUTO_KEY = 'rgb-changer-sony-auto';
  const SERVICES = [SonyMdr.SERVICE_V2, SonyMdr.SERVICE_V1];
  const events = [];
  let headphones = null;
  let batteryTimer = null;
  let diagnostics = {};

  const setLog = (message, isError = false) => {
    log.textContent = message;
    log.classList.toggle('device-log--error', isError);
    events.push(`${new Date().toLocaleTimeString(I18n.locale)}${isError ? ` [${t('грешка')}]` : ''} ${message}`);
    if (events.length > 30) events.shift();
  };
  const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
  const setAuto = (enabled) => {
    try {
      localStorage.setItem(AUTO_KEY, enabled ? 'on' : 'off');
    } catch {
      // Без localStorage няма автоматично свързване
    }
  };

  // Съобщенията от слушалките (отговори и известия при натискане на бутон) обновяват състоянието
  const onMessage = (payload) => {
    const [code, subtype] = payload;
    if ((code === 0x67 || code === 0x69) && subtype === 0x17) {
      // 7 байта: 01 E T V L; при 8 байта има байт за вятър на позиция 5
      const [enabled, type] = [payload[3], payload[4]];
      const [voice, level] = payload.length >= 8 ? [payload[6], payload[7]] : [payload[5], payload[6]];
      state.mode = !enabled ? 'off' : type ? 'ambient' : 'nc';
      state.focusVoice = Boolean(voice);
      if (level >= 1 && level <= 20) state.ambientLevel = level;
    } else if ((code === 0x23 || code === 0x25) && subtype === 0x00) {
      state.battery = { level: payload[2], charging: Boolean(payload[3]) };
    } else if ((code === 0x57 || code === 0x59) && subtype === 0x00) {
      state.eqPreset = payload[2];
      if (payload[3] >= 6 && payload.length >= 10) {
        state.clearBass = payload[4] - 10;
        state.bands = [...payload.slice(5, 10)].map((value) => value - 10);
      }
      if (![...presetSelect.options].some((option) => Number(option.value) === state.eqPreset)) {
        presetSelect.add(new Option(t('Настройка {code}', { code: `0x${state.eqPreset.toString(16)}` }), state.eqPreset));
      }
    } else if ((code === 0xe7 || code === 0xe9) && subtype === 0x01) {
      state.dsee = Boolean(payload[2]);
    } else if ((code === 0xf7 || code === 0xf9) && subtype === 0x0c) {
      state.speakToChat = payload[2] === 0x00; // 00 = включено (по Gadgetbridge)
    } else if (code === 0x05 && subtype === 0x02) {
      state.firmware = new TextDecoder().decode(Uint8Array.from(payload.slice(3, 3 + payload[2])));
    } else {
      return;
    }
    render();
  };

  // Незадължителните функции (DSEE, Speak-to-Chat) се скриват, ако слушалките не отговорят
  const optional = (promise, field) => promise.catch(() => {
    state[field] = null;
  });

  const readAll = async () => {
    await headphones.request([0x04, 0x02], 0x05).catch(() => {});
    await headphones.request([0x66, 0x17], 0x67);
    await headphones.request([0x22, 0x00], 0x23).catch(() => {});
    await headphones.request([0x56, 0x00], 0x57).catch(() => {});
    await optional(headphones.request([0xe6, 0x01], 0xe7, 1500), 'dsee');
    await optional(headphones.request([0xf6, 0x0c], 0xf7, 1500), 'speakToChat');
    render();
  };

  const showConnected = (isConnected) => {
    state.connected = isConnected;
    connectButton.hidden = isConnected;
    connectedGroup.hidden = !isConnected;
    render();
  };

  const connectTo = async (port, automatic) => {
    const service = port.getInfo().bluetoothServiceClassId;
    if (!automatic) setLog(t('Свързвам се със слушалките…'));
    headphones = new SonyHeadphones(port);
    headphones.onMessage = onMessage;
    headphones.onClose = () => {
      clearInterval(batteryTimer);
      headphones = null;
      showConnected(false);
      setLog(t('Връзката със слушалките прекъсна.'), true);
    };
    await headphones.open();

    // Начална заявка: 8 байта отговор = протокол V2 (WH-1000XM5); при V1 командите са други
    const init = await headphones.request([0x00, 0x00], 0x01);
    diagnostics = { service, init: hex(init), userAgent: navigator.userAgent };
    if (init.length < 8) {
      await disconnect(false);
      throw new Error(t('Тези слушалки ползват по-стара версия на протокола на Sony, която страницата още не поддържа.'));
    }

    state.model = 'Sony WH-1000XM5';
    state.dsee = false;
    state.speakToChat = false;
    showConnected(true);
    await readAll();
    batteryTimer = setInterval(() => {
      headphones?.request([0x22, 0x00], 0x23).catch(() => {});
    }, 60000);
    setAuto(true);
    help.hidden = true;
    setLog(automatic ? t('Слушалките са свързани автоматично.') : t('Слушалките са свързани.'));
  };

  const connect = async () => {
    if (window.SiteEnv?.isFile) throw new Error(SiteEnv.fileMessage());
    if (!navigator.serial) {
      help.hidden = false;
      throw new Error(t('Браузърът не поддържа Web Serial. Използвай Chrome или Edge на компютър.'));
    }
    let port;
    try {
      port = await navigator.serial.requestPort({
        filters: SERVICES.map((id) => ({ bluetoothServiceClassId: id })),
        allowedBluetoothServiceClassIds: SERVICES
      });
    } catch (error) {
      if (error.name === 'NotFoundError') {
        help.hidden = false;
        setLog(t('Не са избрани слушалки. Ако не са в списъка, сдвои ги първо с компютъра по Bluetooth.'));
        return;
      }
      throw error;
    }
    try {
      await connectTo(port, false);
    } catch (error) {
      help.hidden = false;
      await headphones?.close();
      headphones = null;
      showConnected(false);
      throw error;
    }
  };

  // При отваряне на страницата – тихо към слушалки, за които браузърът вече има разрешение
  const autoConnect = async () => {
    try {
      if (!navigator.serial || window.SiteEnv?.isFile || localStorage.getItem(AUTO_KEY) !== 'on') return;
    } catch {
      return;
    }
    const ports = await navigator.serial.getPorts().catch(() => []);
    const port = ports.find((candidate) => SERVICES.includes(candidate.getInfo().bluetoothServiceClassId));
    if (!port) return;
    try {
      await connectTo(port, true);
    } catch {
      await headphones?.close();
      headphones = null;
      showConnected(false);
    }
  };

  const disconnect = async (manual = true) => {
    clearInterval(batteryTimer);
    await headphones?.close();
    headphones = null;
    showConnected(false);
    if (manual) {
      setAuto(false);
      setLog(t('Връзката със слушалките е прекъсната.'));
    }
  };

  // --- ПРОМЕНИ ОТ СТРАНИЦАТА ---
  // Командата за режима носи режим, глас и ниво заедно – винаги се пращат последно известните стойности
  const sendAmbient = () => {
    const enabled = state.mode === 'off' ? 0 : 1;
    const ambient = state.mode === 'ambient' ? 1 : 0;
    return headphones.send([0x68, 0x17, 0x01, enabled, ambient, state.focusVoice ? 1 : 0, state.ambientLevel]);
  };

  const sendEqualizer = () => headphones.send([0x58, 0x00, 0xa0, 0x06, state.clearBass + 10, ...state.bands.map((value) => value + 10)]);

  const run = (task) => async () => {
    if (!headphones) return;
    try {
      await task();
      render();
    } catch (error) {
      console.error(error);
      setLog(error.message || String(error), true);
    }
  };

  const debounce = (task, ms) => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(task, ms);
    };
  };

  modeInputs.forEach((input) => input.addEventListener('change', run(async () => {
    state.mode = input.value;
    await sendAmbient();
  })));
  const sendLevel = debounce(run(sendAmbient), 200);
  levelInput.addEventListener('input', () => {
    state.ambientLevel = Number(levelInput.value);
    render();
    sendLevel();
  });
  voiceInput.addEventListener('change', run(async () => {
    state.focusVoice = voiceInput.checked;
    await sendAmbient();
  }));

  presetSelect.addEventListener('change', run(async () => {
    state.eqPreset = Number(presetSelect.value);
    await headphones.send([0x58, 0x00, state.eqPreset, 0x00]);
    // Лентите на готовата настройка идват с отговора
    await headphones.request([0x56, 0x00], 0x57).catch(() => {});
  }));
  const sendBands = debounce(run(sendEqualizer), 250);
  const onBandsInput = () => {
    state.clearBass = Number(bassInput.value);
    state.bands = [...bandInputs].map((input) => Number(input.value));
    state.eqPreset = 0xa0;
    render();
    sendBands();
  };
  bassInput.addEventListener('input', onBandsInput);
  bandInputs.forEach((input) => input.addEventListener('input', onBandsInput));

  dseeInput.addEventListener('change', run(async () => {
    state.dsee = dseeInput.checked;
    await headphones.send([0xe8, 0x01, state.dsee ? 1 : 0]);
  }));
  stcInput.addEventListener('change', run(async () => {
    state.speakToChat = stcInput.checked;
    await headphones.send([0xf8, 0x0c, state.speakToChat ? 0x00 : 0x01, 0x01]);
    await headphones.request([0xf6, 0x0c], 0xf7, 1500).catch(() => {});
  }));

  // --- БУТОНИ ---
  let busy = false;
  const actions = {
    connect,
    disconnect,
    refresh: async () => {
      await readAll();
      setLog(t('Състоянието е обновено от слушалките.'));
    },
    'copy-diagnostics': async () => {
      await navigator.clipboard.writeText(JSON.stringify({ ...diagnostics, state, events }, null, 2));
      setLog(t('Техническата информация е копирана.'));
    }
  };
  bar.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-hp-action]')?.dataset.hpAction;
    if (!action || busy) return;
    busy = true;
    deviceBar.classList.add('is-busy');
    try {
      await actions[action]();
    } catch (error) {
      console.error(error);
      setLog(error.message || String(error), true);
    } finally {
      busy = false;
      deviceBar.classList.remove('is-busy');
    }
  });

  navigator.serial?.addEventListener('disconnect', (event) => {
    if (headphones && event.target === headphones.port) headphones.onClose?.();
  });

  render();
  autoConnect();
})();
