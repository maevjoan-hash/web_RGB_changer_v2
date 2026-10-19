// --- ФУНКЦИИ НА БУТОНИТЕ: преназначаване, комбинации, макроси, медия ---
// Страницата записва какво трябва да прави всеки бутон. Към истинското устройство това се
// изпраща едва след връзка през WebHID с протокола на конкретния производител, затова тук
// „Изпробвай“ само показва действието (а медийните действия пускат демо мелодия).
(() => {
  const { t } = I18n;
  const device = document.querySelector('.keyboard, .mouse-svg');
  const bindingsTab = document.querySelector('.settings-tab[data-tab="5"]');
  const bindingsColumn = bindingsTab?.closest('.settings-menu');
  const panels = bindingsColumn?.querySelector('.settings-panels') || document.querySelector('.settings-panels');
  const settingsTabs = document.querySelectorAll('.settings-tab');

  if (!device || !panels || !bindingsTab) return;

  const isKeyboard = device.classList.contains('keyboard');
  const storageKey = `rgb-changer-bindings:${device.dataset.storageId || location.pathname.split('/').pop()}`;

  const MEDIA_ACTIONS = {
    'play-pause': t('Пусни / пауза'),
    next: t('Следваща песен'),
    prev: t('Предишна песен'),
    stop: t('Стоп'),
    'volume-up': t('Звук +'),
    'volume-down': t('Звук −'),
    mute: t('Без звук')
  };

  const MOUSE_ACTIONS = {
    left: t('Ляв клик'),
    right: t('Десен клик'),
    middle: t('Среден клик'),
    double: t('Двоен клик'),
    back: t('Назад (браузър)'),
    forward: t('Напред (браузър)'),
    'dpi-up': 'DPI +',
    'dpi-down': 'DPI −',
    sniper: t('Нисък DPI докато е натиснат'),
    'rapid-fire': t('Бърза стрелба (повтаря клик)')
  };

  const SHORTCUTS = {
    copy: [t('Копирай'), 'Ctrl + C'],
    paste: [t('Постави'), 'Ctrl + V'],
    cut: [t('Изрежи'), 'Ctrl + X'],
    undo: [t('Отмени'), 'Ctrl + Z'],
    'switch-window': [t('Смени прозореца'), 'Alt + Tab'],
    screenshot: [t('Снимка на част от екрана'), 'Win + Shift + S'],
    desktop: [t('Покажи работния плот'), 'Win + D'],
    'task-manager': [t('Диспечер на задачите'), 'Ctrl + Shift + Esc'],
    lock: [t('Заключи компютъра'), 'Win + L']
  };

  const BINDING_TYPES = {
    default: t('Оригинална функция'),
    combo: t('Клавиш или комбинация'),
    macro: t('Макро (поредица от клавиши)'),
    shortcut: t('Бърза команда'),
    media: t('Медия (музика и звук)'),
    mouse: t('Функция на мишката'),
    disabled: t('Изключен бутон')
  };

  const MACRO_MAX_STEPS = 16;

  // --- БУТОНИ, КОИТО МОГАТ ДА СЕ ПРЕНАЗНАЧАВАТ ---
  // Светещите зони на мишката (лента, лого) не са бутони, затова са изключени
  const targets = isKeyboard
    ? [...device.querySelectorAll('.key')].map((el) => ({ id: el.dataset.keyId, el, name: el.dataset.keyId }))
    : [...device.querySelectorAll('.mouse-btn-group')].map((el) => ({
      id: el.dataset.btn,
      el,
      name: `${el.getAttribute('aria-label')} (${el.dataset.btn})`
    }));

  const findTarget = (id) => targets.find((target) => target.id === id);

  // Оригиналната функция на всеки бутон
  const KEYBOARD_MEDIA_KEYS = {
    Play: 'play-pause',
    Next: 'next',
    Prev: 'prev',
    Stop: 'stop',
    Mute: 'mute',
    'Vol+': 'volume-up',
    'Vol-': 'volume-down'
  };
  const MOUSE_DEFAULTS = {
    LMB: 'left',
    RMB: 'right',
    Scroll: 'middle',
    'DPI+': 'dpi-up',
    'DPI-': 'dpi-down',
    Sniper: 'sniper',
    Fire: 'rapid-fire'
  };

  const defaultBinding = ({ id, el }) => {
    if (isKeyboard) {
      return KEYBOARD_MEDIA_KEYS[id]
        ? { type: 'media', value: KEYBOARD_MEDIA_KEYS[id] }
        : { type: 'combo', value: id.split('#')[0] };
    }

    const label = el.getAttribute('aria-label') || '';
    if (MOUSE_DEFAULTS[id]) return { type: 'mouse', value: MOUSE_DEFAULTS[id] };
    // aria-label вече е преведен от I18n.translateTree(), затова се сравнява и с превода на целия надпис
    if (label.includes('Назад') || label === t('Страничен бутон Назад')) return { type: 'mouse', value: 'back' };
    if (label.includes('Напред') || label === t('Страничен бутон Напред')) return { type: 'mouse', value: 'forward' };
    return { type: 'none' };
  };

  const describe = (binding) => {
    switch (binding.type) {
      case 'combo':
        return binding.value;
      case 'macro':
        return t('Макро: {steps}', { steps: binding.value.join(' → ') });
      case 'shortcut':
        return `${SHORTCUTS[binding.value][0]} (${SHORTCUTS[binding.value][1]})`;
      case 'media':
        return MEDIA_ACTIONS[binding.value];
      case 'mouse':
        return MOUSE_ACTIONS[binding.value];
      case 'disabled':
        return t('Изключен');
      default:
        return t('Без функция');
    }
  };

  // --- СЪХРАНЕНИЕ ---
  const isValidBinding = (binding) => {
    if (!binding || typeof binding !== 'object') return false;
    switch (binding.type) {
      case 'combo':
        return typeof binding.value === 'string' && binding.value.length > 0;
      case 'macro':
        return Array.isArray(binding.value) && binding.value.length > 0;
      case 'shortcut':
        return Object.hasOwn(SHORTCUTS, binding.value);
      case 'media':
        return Object.hasOwn(MEDIA_ACTIONS, binding.value);
      case 'mouse':
        return Object.hasOwn(MOUSE_ACTIONS, binding.value);
      case 'disabled':
        return true;
      default:
        return false;
    }
  };

  // Функциите са отделни за всеки профил. Активният профил идва от rgb.js (data-profile на устройството).
  const activeProfile = () => device.dataset.profile || '0';

  const sanitize = (saved) => Object.fromEntries(
    Object.entries(saved && typeof saved === 'object' ? saved : {})
      .filter(([id, binding]) => findTarget(id) && isValidBinding(binding))
  );

  const loadStore = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));

      if (saved?.profiles && typeof saved.profiles === 'object') {
        return {
          profiles: Object.fromEntries(
            Object.entries(saved.profiles).map(([profile, profileBindings]) => [profile, sanitize(profileBindings)])
          )
        };
      }

      // Старият формат беше общ за всички профили: копира се във всеки, за да не се загуби нищо
      if (saved && typeof saved === 'object') {
        const profileCount = Number(device.dataset.profileCount) || 1;
        return {
          profiles: Object.fromEntries(
            Array.from({ length: profileCount }, (_, index) => [String(index), sanitize(saved)])
          )
        };
      }
    } catch (error) {
      console.warn('Неуспешно зареждане на функциите на бутоните', error);
    }
    return { profiles: {} };
  };

  const store = loadStore();

  const profileBindings = () => {
    const profile = activeProfile();
    if (!Object.hasOwn(store.profiles, profile)) store.profiles[profile] = {};
    return store.profiles[profile];
  };

  const saveBindings = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(store));
    } catch (error) {
      console.warn('Неуспешно запазване на функциите на бутоните', error);
    }
  };

  const currentBinding = (target) => profileBindings()[target.id] || defaultBinding(target);

  // --- ДЕМО ПЛЕЪР ЗА МЕДИЙНИТЕ ДЕЙСТВИЯ ---
  // Кратки мелодии, генерирани с Web Audio, за да се чуе какво прави бутонът
  const player = (() => {
    const TRACKS = [
      { name: t('Космическа мелодия'), notes: [262, 330, 392, 523, 392, 330] },
      { name: t('Неонов ритъм'), notes: [220, 277, 330, 440, 330, 277] },
      { name: t('Нощно каране'), notes: [196, 247, 294, 392, 294, 247] }
    ];
    let audio = null;
    let output = null;
    let timer = null;
    let track = 0;
    let step = 0;
    let volume = 0.5;
    let muted = false;

    const applyVolume = () => {
      if (output) output.gain.value = muted ? 0 : volume * 0.25;
    };

    const ensureAudio = () => {
      if (!audio) {
        audio = new AudioContext();
        output = audio.createGain();
        output.connect(audio.destination);
      }
      audio.resume();
      applyVolume();
    };

    const playNote = () => {
      const { notes } = TRACKS[track];
      const oscillator = audio.createOscillator();
      const envelope = audio.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = notes[step % notes.length];
      envelope.gain.setValueAtTime(1, audio.currentTime);
      envelope.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
      oscillator.connect(envelope).connect(output);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.26);
      step += 1;
    };

    const play = () => {
      ensureAudio();
      if (!timer) timer = setInterval(playNote, 220);
    };

    const pause = () => {
      clearInterval(timer);
      timer = null;
    };

    const changeTrack = (direction) => {
      track = (track + direction + TRACKS.length) % TRACKS.length;
      step = 0;
      play();
    };

    const status = () => {
      const sound = muted ? t('без звук') : t('звук {volume}%', { volume: Math.round(volume * 100) });
      return `${timer ? '▶' : '⏸'} ${TRACKS[track].name} · ${sound}`;
    };

    return {
      run(action) {
        if (!window.AudioContext) return t('Браузърът не поддържа Web Audio.');

        if (action === 'play-pause') {
          if (timer) pause();
          else play();
        } else if (action === 'stop') {
          pause();
          step = 0;
        } else if (action === 'next') {
          changeTrack(1);
        } else if (action === 'prev') {
          changeTrack(-1);
        } else if (action === 'volume-up' || action === 'volume-down') {
          ensureAudio();
          volume = Math.min(1, Math.max(0, volume + (action === 'volume-up' ? 0.1 : -0.1)));
          muted = false;
          applyVolume();
        } else if (action === 'mute') {
          ensureAudio();
          muted = !muted;
          applyVolume();
        }

        return status();
      }
    };
  })();

  // --- СЪОБЩЕНИЯ ---
  const toast = document.createElement('div');
  toast.className = 'binding-toast';
  toast.setAttribute('role', 'status');
  toast.hidden = true;
  document.body.append(toast);
  let toastTimer = null;

  const showToast = (message) => {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2500);
  };

  let macroTimers = [];

  const execute = (target) => {
    const binding = currentBinding(target);
    macroTimers.forEach(clearTimeout);
    macroTimers = [];

    if (binding.type === 'media') {
      showToast(`${MEDIA_ACTIONS[binding.value]}: ${player.run(binding.value)}`);
    } else if (binding.type === 'macro') {
      binding.value.forEach((step, index) => {
        macroTimers.push(setTimeout(() => {
          showToast(t('Макро {step}/{total}: {keys}', { step: index + 1, total: binding.value.length, keys: step }));
        }, index * 450));
      });
    } else if (binding.type === 'disabled') {
      showToast(t('Бутонът е изключен и не прави нищо.'));
    } else if (binding.type === 'none') {
      showToast(t('Този бутон няма функция по подразбиране.'));
    } else {
      showToast(t('Изпълнява: {action}', { action: describe(binding) }));
    }
  };

  // --- ЗАПИС НА КОМБИНАЦИИ ОТ КЛАВИАТУРАТА ---
  const MODIFIER_KEYS = { Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Meta: 'Win' };
  const CODE_NAMES = {
    Space: 'Space',
    Enter: 'Enter',
    NumpadEnter: 'Enter',
    Escape: 'Esc',
    Backspace: 'Backspace',
    Tab: 'Tab',
    CapsLock: 'Caps',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Delete: 'Del',
    Insert: 'Ins',
    Home: 'Home',
    End: 'End',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    PrintScreen: 'PrtSc',
    ScrollLock: 'ScrLk',
    Pause: 'Pause',
    ContextMenu: 'Menu',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/'
  };

  // event.code е физическият клавиш, затова комбинацията е еднаква при кирилица и латиница
  const keyName = ({ code, key }) => {
    if (CODE_NAMES[code]) return CODE_NAMES[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
    if (/^F\d+$/.test(code)) return code;
    return key.length === 1 ? key.toUpperCase() : key;
  };

  const comboFromEvent = (event) => {
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.shiftKey) parts.push('Shift');
    if (event.altKey) parts.push('Alt');
    if (event.metaKey) parts.push('Win');
    if (!MODIFIER_KEYS[event.key]) parts.push(keyName(event));
    return parts.join(' + ');
  };

  // recording: { mode: 'combo' | 'macro', steps: [], pendingModifier: '' }
  let recording = null;

  // --- ПАНЕЛ ---
  const noTargetText = isKeyboard
    ? t('Няма избран бутон. Кликни клавиш от клавиатурата.')
    : t('Няма избран бутон. Кликни бутон от мишката.');
  const optionsHtml = (entries) => entries.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  panel.dataset.panel = bindingsTab.dataset.tab;
  panel.hidden = !bindingsTab.classList.contains('active');
  panel.innerHTML = `
    <p class="binding-profile" id="binding-profile"></p>
    <p class="binding-target" id="binding-target"></p>

    <div class="binding-editor" id="binding-editor">
      <p class="binding-current">${t('Сега прави:')} <strong id="binding-current"></strong></p>

      <label class="field">
        <span class="field__label">${t('Нова функция')}</span>
        <select class="field__select" id="binding-type">${optionsHtml(Object.entries(BINDING_TYPES))}</select>
      </label>

      <div class="binding-field" data-binding-field="combo">
        <button type="button" class="panel-btn" data-binding-action="record-combo">${t('Запиши комбинация')}</button>
        <span class="binding-recorded" id="binding-combo-value"></span>
      </div>

      <div class="binding-field" data-binding-field="macro">
        <button type="button" class="panel-btn" data-binding-action="record-macro">${t('Запиши макро')}</button>
        <button type="button" class="panel-btn" data-binding-action="stop-macro">${t('Спри записа')}</button>
        <span class="binding-recorded" id="binding-macro-value"></span>
      </div>

      <label class="field" data-binding-field="shortcut">
        <span class="field__label">${t('Команда')}</span>
        <select class="field__select" id="binding-shortcut">
          ${optionsHtml(Object.entries(SHORTCUTS).map(([id, [name, keys]]) => [id, `${name} (${keys})`]))}
        </select>
      </label>

      <label class="field" data-binding-field="media">
        <span class="field__label">${t('Медийно действие')}</span>
        <select class="field__select" id="binding-media">${optionsHtml(Object.entries(MEDIA_ACTIONS))}</select>
      </label>

      <label class="field" data-binding-field="mouse">
        <span class="field__label">${t('Действие на мишката')}</span>
        <select class="field__select" id="binding-mouse">${optionsHtml(Object.entries(MOUSE_ACTIONS))}</select>
      </label>

      <p class="panel-note" id="binding-note" hidden></p>

      <div class="panel-actions">
        <button type="button" class="panel-btn" data-binding-action="test">${t('Изпробвай')}</button>
        <button type="button" class="panel-btn" data-binding-action="reset">${t('Върни оригинала')}</button>
      </div>
    </div>

    <div class="binding-summary">
      <p class="field__label">${t('Зададени функции')}</p>
      <ul class="binding-list" id="binding-list"></ul>
    </div>
  `;
  panels.append(panel);

  panel.id = `settings-panel-${bindingsTab.dataset.tab}`;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', bindingsTab.textContent);
  bindingsTab.setAttribute('aria-controls', panel.id);

  const profileText = panel.querySelector('#binding-profile');
  const targetText = panel.querySelector('#binding-target');
  const editor = panel.querySelector('#binding-editor');
  const currentText = panel.querySelector('#binding-current');
  const typeSelect = panel.querySelector('#binding-type');
  const comboValue = panel.querySelector('#binding-combo-value');
  const macroValue = panel.querySelector('#binding-macro-value');
  const shortcutSelect = panel.querySelector('#binding-shortcut');
  const mediaSelect = panel.querySelector('#binding-media');
  const mouseSelect = panel.querySelector('#binding-mouse');
  const note = panel.querySelector('#binding-note');
  const list = panel.querySelector('#binding-list');
  const fields = panel.querySelectorAll('[data-binding-field]');
  const recordComboButton = panel.querySelector('[data-binding-action="record-combo"]');
  const recordMacroButton = panel.querySelector('[data-binding-action="record-macro"]');
  const stopMacroButton = panel.querySelector('[data-binding-action="stop-macro"]');

  // Значка върху бутоните на мишката с променена функция (на клавиатурата е ::after в CSS)
  if (!isKeyboard) {
    targets.forEach(({ el }) => {
      const shape = el.querySelector('.mouse-btn');
      if (!shape) return;
      const box = shape.getBBox();
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      badge.setAttribute('class', 'binding-badge');
      badge.setAttribute('cx', box.x + box.width - 3);
      badge.setAttribute('cy', box.y + 3);
      badge.setAttribute('r', 4.5);
      el.append(badge);
    });
  }

  let selectedId = null;
  let draftType = null;

  const stopRecording = () => {
    if (recording?.mode === 'macro' && recording.steps.length > 0) {
      profileBindings()[selectedId] = { type: 'macro', value: recording.steps };
      draftType = null;
      saveBindings();
    }
    recording = null;
  };

  const render = () => {
    const target = selectedId ? findTarget(selectedId) : null;
    const bindings = profileBindings();

    profileText.textContent = t('Профил {n}', { n: Number(activeProfile()) + 1 });

    targets.forEach(({ id, el }) => {
      el.classList.toggle('is-binding-target', id === selectedId);
      el.classList.toggle('has-binding', Object.hasOwn(bindings, id));
    });

    editor.hidden = !target;
    targetText.textContent = target ? t('Избран бутон: {name}', { name: target.name }) : noTargetText;

    list.replaceChildren(...Object.entries(bindings).map(([id, binding]) => {
      const item = document.createElement('li');
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'binding-list__name';
      select.dataset.bindingSelect = id;
      select.textContent = `${findTarget(id).name} → ${describe(binding)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'binding-list__remove';
      remove.dataset.bindingRemove = id;
      remove.setAttribute('aria-label', t('Върни оригинала на {button}', { button: id }));
      remove.textContent = '×';
      item.append(select, remove);
      return item;
    }));
    if (list.children.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'binding-list__empty';
      empty.textContent = t('Все още няма променени бутони.');
      list.append(empty);
    }

    if (!target) return;

    const saved = bindings[target.id];
    const type = draftType || (saved ? saved.type : 'default');
    currentText.textContent = saved ? describe(saved) : t('{action} (оригинал)', { action: describe(defaultBinding(target)) });
    typeSelect.value = type;
    fields.forEach((field) => {
      field.hidden = field.dataset.bindingField !== type;
    });

    if (saved?.type === 'shortcut') shortcutSelect.value = saved.value;
    if (saved?.type === 'media') mediaSelect.value = saved.value;
    if (saved?.type === 'mouse') mouseSelect.value = saved.value;

    const isRecordingCombo = recording?.mode === 'combo';
    const isRecordingMacro = recording?.mode === 'macro';
    recordComboButton.textContent = isRecordingCombo ? t('Натисни клавишите…') : t('Запиши комбинация');
    recordMacroButton.disabled = isRecordingMacro;
    stopMacroButton.hidden = !isRecordingMacro;
    comboValue.textContent = saved?.type === 'combo' ? saved.value : '';
    macroValue.textContent = isRecordingMacro
      ? recording.steps.join(' → ') || '…'
      : saved?.type === 'macro' ? saved.value.join(' → ') : '';

    note.hidden = !recording;
    note.textContent = isRecordingMacro
      ? t('Натискай клавишите поред (до {max}), после „Спри записа“.', { max: MACRO_MAX_STEPS })
      : t('Натисни клавиша или комбинацията. Някои комбинации (напр. Ctrl + W) браузърът не позволява да се запишат.');
  };

  const selectTarget = (id) => {
    stopRecording();
    selectedId = id;
    draftType = null;
    render();
  };

  const setBinding = (binding) => {
    profileBindings()[selectedId] = binding;
    draftType = null;
    saveBindings();
    render();
  };

  const removeBinding = (id) => {
    if (id === selectedId) stopRecording();
    delete profileBindings()[id];
    draftType = null;
    saveBindings();
    render();
  };

  // --- СЪБИТИЯ ---
  const setMode = (isActive) => {
    device.classList.toggle('bindings-mode', isActive);
    if (!isActive) {
      stopRecording();
      render();
    }
  };

  // Кликовете върху устройството избират бутон, когато „Функции на бутоните“ е отворена
  // в колоната, ползвана последно (иначе избират зони за подсветката)
  const updateMode = () => {
    const columnIsActive = !bindingsColumn?.classList.contains('settings-column') || bindingsColumn.classList.contains('is-active');
    setMode(bindingsTab.classList.contains('active') && columnIsActive);
  };
  settingsTabs.forEach((tab) => tab.addEventListener('click', updateMode));
  document.addEventListener('settings-column-change', updateMode);

  // Смяна на профила показва неговите функции; нулирането на профила изтрива и тях
  device.addEventListener('profilechange', () => {
    recording = null;
    draftType = null;
    render();
  });

  device.addEventListener('profilereset', (event) => {
    delete store.profiles[String(event.detail.profile)];
    saveBindings();
    render();
  });

  device.addEventListener('click', (event) => {
    if (!device.classList.contains('bindings-mode')) return;
    const target = targets.find(({ el }) => el.contains(event.target));
    if (target) selectTarget(target.id);
  });

  device.addEventListener('keydown', (event) => {
    if (!device.classList.contains('bindings-mode') || (event.key !== 'Enter' && event.key !== ' ')) return;
    const target = targets.find(({ el }) => el === event.target);
    if (!target) return;
    event.preventDefault();
    selectTarget(target.id);
  });

  typeSelect.addEventListener('change', () => {
    stopRecording();
    const type = typeSelect.value;

    if (type === 'default') {
      removeBinding(selectedId);
    } else if (type === 'disabled') {
      setBinding({ type: 'disabled' });
    } else if (type === 'shortcut') {
      setBinding({ type, value: shortcutSelect.value });
    } else if (type === 'media') {
      setBinding({ type, value: mediaSelect.value });
    } else if (type === 'mouse') {
      setBinding({ type, value: mouseSelect.value });
    } else {
      // Комбинацията и макрото се записват едва когато потребителят ги натисне
      draftType = type;
      render();
    }
  });

  shortcutSelect.addEventListener('change', () => setBinding({ type: 'shortcut', value: shortcutSelect.value }));
  mediaSelect.addEventListener('change', () => setBinding({ type: 'media', value: mediaSelect.value }));
  mouseSelect.addEventListener('change', () => setBinding({ type: 'mouse', value: mouseSelect.value }));

  panel.addEventListener('click', (event) => {
    const action = event.target.closest('[data-binding-action]')?.dataset.bindingAction;
    const selectId = event.target.closest('[data-binding-select]')?.dataset.bindingSelect;
    const removeId = event.target.closest('[data-binding-remove]')?.dataset.bindingRemove;

    if (selectId) {
      selectTarget(selectId);
    } else if (removeId) {
      removeBinding(removeId);
    } else if (action === 'record-combo') {
      recording = { mode: 'combo', steps: [], pendingModifier: '' };
      render();
    } else if (action === 'record-macro') {
      recording = { mode: 'macro', steps: [], pendingModifier: '' };
      render();
    } else if (action === 'stop-macro') {
      stopRecording();
      render();
    } else if (action === 'test') {
      execute(findTarget(selectedId));
    } else if (action === 'reset') {
      removeBinding(selectedId);
    }
  });

  const addRecordedCombo = (combo) => {
    if (recording.mode === 'combo') {
      recording = null;
      setBinding({ type: 'combo', value: combo });
      return;
    }

    recording.steps.push(combo);
    if (recording.steps.length >= MACRO_MAX_STEPS) stopRecording();
    render();
  };

  // Записът хваща клавишите преди браузъра, за да не местят фокуса (Tab) или да натискат бутони
  window.addEventListener('keydown', (event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;

    if (MODIFIER_KEYS[event.key]) {
      recording.pendingModifier = comboFromEvent(event) || MODIFIER_KEYS[event.key];
      return;
    }

    recording.pendingModifier = '';
    addRecordedCombo(comboFromEvent(event));
  }, true);

  // Самостоятелен модификатор (напр. само Ctrl) се записва, когато бъде пуснат
  window.addEventListener('keyup', (event) => {
    if (!recording || !MODIFIER_KEYS[event.key] || !recording.pendingModifier) return;
    event.preventDefault();
    const combo = recording.pendingModifier;
    recording.pendingModifier = '';
    addRecordedCombo(combo);
  }, true);

  // Функциите на активния профил за други скриптове (logitech.js ги записва в мишката).
  // Бързите команди се подават като обикновени комбинации.
  window.RgbChanger = window.RgbChanger || {};
  window.RgbChanger.getButtonFunctions = () => targets.map((target) => {
    const saved = profileBindings()[target.id];
    const binding = saved?.type === 'shortcut' ? { type: 'combo', value: SHORTCUTS[saved.value][1] } : saved;
    return {
      id: target.id,
      name: target.name,
      binding: binding || null,
      description: saved ? describe(saved) : t('Оригинална функция'),
      defaultBinding: defaultBinding(target)
    };
  });
  window.RgbChanger.activeProfile = () => Number(activeProfile());

  render();
})();
