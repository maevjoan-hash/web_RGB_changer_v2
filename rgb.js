// --- RGB ЛОГИКА: цветове, ефекти, яркост, скорост и профили ---
(() => {
  const device = document.querySelector('.keyboard, .mouse-svg');
  // Подсветката е в лявата колона; ако страницата няма колони, се ползва единственото меню
  const settingsMenu = document.querySelector('[data-column="lighting"]') || document.querySelector('.settings-menu');
  const settingsTabs = document.querySelectorAll('.settings-tab');

  if (!device || !settingsMenu || settingsTabs.length === 0) return;

  const isKeyboard = device.classList.contains('keyboard');
  const PROFILE_COUNT = 3;
  const DEFAULT_COLOR = '#a06bff';
  const storageKey = `rgb-changer:${device.dataset.storageId || location.pathname.split('/').pop()}`;

  const PRESET_COLORS = [
    { color: '#ff1744', name: 'Червен' },
    { color: '#ff9100', name: 'Оранжев' },
    { color: '#ffea00', name: 'Жълт' },
    { color: '#00e676', name: 'Зелен' },
    { color: '#00e5ff', name: 'Циан' },
    { color: '#2979ff', name: 'Син' },
    { color: '#a06bff', name: 'Лилав' },
    { color: '#ff4081', name: 'Розов' },
    { color: '#ffffff', name: 'Бял' }
  ];

  const EFFECTS = [
    { id: 'static', label: 'Статичен', usesColors: true, usesSpeed: false },
    { id: 'breathing', label: 'Дишане', usesColors: true, usesSpeed: true },
    { id: 'wave', label: 'Вълна', usesColors: false, usesSpeed: true },
    { id: 'spectrum', label: 'Дъга', usesColors: false, usesSpeed: true },
    { id: 'off', label: 'Изключено', usesColors: false, usesSpeed: false }
  ];

  const getEffect = (id) => EFFECTS.find((effect) => effect.id === id) || EFFECTS[0];

  // Скорост 1 (бавно) – 10 (бързо) се превръща в продължителност на анимацията
  const speedToSeconds = (speed) => (8 - ((speed - 1) * 7) / 9).toFixed(2);

  const createProfile = () => ({
    color: DEFAULT_COLOR,
    leds: {},
    effect: 'static',
    brightness: 100,
    speed: 5
  });

  // --- LED ЗОНИ НА УСТРОЙСТВОТО ---
  const leds = [];

  if (isKeyboard) {
    device.querySelectorAll('.key').forEach((el, index) => leds.push({ id: el.dataset.keyId || `k${index}`, el }));
  } else {
    device.querySelectorAll('.mouse-btn-group').forEach((el) => leds.push({ id: el.dataset.btn, el }));
    device.querySelectorAll('.mouse-rgb-strip, .mouse-gaming-logo, .mouse-logo-ring').forEach((el) => {
      el.classList.add('mouse-led-zone');
      leds.push({ id: el.classList.contains('mouse-rgb-strip') ? 'strip' : 'logo', el });
    });
  }

  leds.forEach(({ id, el }) => {
    el.dataset.led = id;
  });

  // Позиция по хоризонтала (0–1), нужна за ефекта „Вълна“
  const updateWavePositions = () => {
    const box = device.getBoundingClientRect();
    if (!box.width) return;

    leds.forEach(({ el }) => {
      const rect = el.getBoundingClientRect();
      const position = (rect.left + rect.width / 2 - box.left) / box.width;
      el.style.setProperty('--wave-pos', position.toFixed(3));
    });
  };

  // --- СЪХРАНЕНИЕ ---
  const loadState = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));

      if (saved && Array.isArray(saved.profiles)) {
        return {
          active: Math.min(Math.max(Number(saved.active) || 0, 0), PROFILE_COUNT - 1),
          profiles: Array.from({ length: PROFILE_COUNT }, (_, index) => {
            const profile = { ...createProfile(), ...saved.profiles[index] };
            profile.effect = getEffect(profile.effect).id;
            profile.leds = profile.leds && typeof profile.leds === 'object' ? profile.leds : {};
            return profile;
          })
        };
      }
    } catch (error) {
      console.warn('Неуспешно зареждане на RGB настройките', error);
    }

    return { active: 0, profiles: Array.from({ length: PROFILE_COUNT }, createProfile) };
  };

  const state = loadState();
  device.dataset.profileCount = String(PROFILE_COUNT);
  const currentProfile = () => state.profiles[state.active];

  const saveState = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (error) {
      console.warn('Неуспешно запазване на RGB настройките', error);
    }
  };

  // --- ПАНЕЛИ С НАСТРОЙКИ ---

  const panels = settingsMenu.querySelector('.settings-panels') || settingsMenu.appendChild(document.createElement('div'));
  panels.className = 'settings-panels';
  panels.innerHTML = `
    <div class="settings-panel" data-panel="1">
      <div class="color-row">
        <label class="color-picker">
          <input type="color" id="rgb-color-input" />
          <span id="rgb-color-value"></span>
        </label>
        <span class="selection-count" id="rgb-selection-count"></span>
      </div>
      <div class="color-presets" role="group" aria-label="Готови цветове">
        ${PRESET_COLORS.map(
          ({ color, name }) =>
            `<button type="button" class="color-swatch" data-color="${color}" aria-label="${name}" title="${name}"></button>`
        ).join('')}
      </div>
      <p class="panel-note" id="rgb-color-note" hidden></p>
      <div class="panel-actions">
        <button type="button" class="panel-btn" data-action="select-all">Избери всички</button>
        <button type="button" class="panel-btn" data-action="clear-selection">Изчисти избора</button>
        <button type="button" class="panel-btn" data-action="reset-colors">Нулирай цветовете</button>
      </div>
    </div>

    <div class="settings-panel" data-panel="2">
      <fieldset class="effect-options">
        <legend class="visually-hidden">Светлинен ефект</legend>
        ${EFFECTS.map(
          ({ id, label }) =>
            `<label class="effect-option"><input type="radio" name="rgb-effect" value="${id}" /><span>${label}</span></label>`
        ).join('')}
      </fieldset>
    </div>

    <div class="settings-panel" data-panel="3">
      <label class="range-field">
        <span class="range-field__label">Яркост <output id="rgb-brightness-value"></output></span>
        <input type="range" id="rgb-brightness" min="10" max="100" step="5" />
      </label>
      <label class="range-field">
        <span class="range-field__label">Скорост на ефекта <output id="rgb-speed-value"></output></span>
        <input type="range" id="rgb-speed" min="1" max="10" step="1" />
      </label>
    </div>
  `;

  // Профилите са в лентата под устройството (data-profiles), заедно с бутоните за запис
  const profilesBar = document.querySelector('[data-profiles]') || panels;
  const profileControls = document.createElement('div');
  profileControls.className = 'panel-actions save-bar__row';
  profileControls.setAttribute('role', 'group');
  profileControls.setAttribute('aria-label', 'Профили');
  profileControls.innerHTML = `
    ${Array.from(
      { length: PROFILE_COUNT },
      (_, index) => `<button type="button" class="panel-btn profile-btn" data-profile="${index}">Профил ${index + 1}</button>`
    ).join('')}
    <button type="button" class="panel-btn" data-action="reset-profile">Нулирай профила</button>
  `;
  profilesBar.append(profileControls);

  const colorInput = panels.querySelector('#rgb-color-input');
  const colorValue = panels.querySelector('#rgb-color-value');
  const colorNote = panels.querySelector('#rgb-color-note');
  const selectionCount = panels.querySelector('#rgb-selection-count');
  const brightnessInput = panels.querySelector('#rgb-brightness');
  const brightnessValue = panels.querySelector('#rgb-brightness-value');
  const speedInput = panels.querySelector('#rgb-speed');
  const speedValue = panels.querySelector('#rgb-speed-value');
  const effectInputs = panels.querySelectorAll('input[name="rgb-effect"]');
  const profileButtons = profileControls.querySelectorAll('.profile-btn');

  panels.querySelectorAll('.color-swatch').forEach((swatch) => {
    swatch.style.setProperty('--swatch', swatch.dataset.color);
  });

  // --- МЕНЮТАТА НА КОЛОНИТЕ ---
  // Всяка колона („Подсветка“ и „Бутони“) има свое меню и свои панели; бутонът показва отворената секция.
  // Панелите се търсят при всеки избор, защото други скриптове (bindings.js, logitech.js) добавят свои.
  const selectTab = (tabToSelect) => {
    const column = tabToSelect.closest('.settings-menu');
    column.querySelectorAll('.settings-tab').forEach((tab) => {
      const isSelected = tab === tabToSelect;
      tab.classList.toggle('active', isSelected);
      if (isSelected) tab.setAttribute('aria-current', 'true');
      else tab.removeAttribute('aria-current');
    });
    column.querySelectorAll('.settings-panel').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tabToSelect.dataset.tab;
    });
    const menuButton = column.querySelector('[data-settings-menu-btn]');
    if (menuButton) {
      menuButton.textContent = `${menuButton.dataset.menuTitle || 'Всички настройки'}: ${tabToSelect.textContent} ▾`;
    }
  };

  settingsTabs.forEach((tab) => {
    const panel = panels.querySelector(`[data-panel="${tab.dataset.tab}"]`);
    if (panel) {
      panel.id = `settings-panel-${tab.dataset.tab}`;
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', tab.textContent);
      tab.setAttribute('aria-controls', panel.id);
    }

    tab.addEventListener('click', () => selectTab(tab));
  });

  document.querySelectorAll('.settings-menu').forEach((column) => {
    const firstTab = column.querySelector('.settings-tab');
    if (firstTab) selectTab(firstTab);
  });

  // Кликовете върху устройството отиват към колоната, ползвана последно (bindings.js слуша събитието)
  const columns = document.querySelectorAll('.settings-column');
  const setActiveColumn = (activeColumn) => {
    if (activeColumn.classList.contains('is-active')) return;
    columns.forEach((column) => column.classList.toggle('is-active', column === activeColumn));
    document.dispatchEvent(new CustomEvent('settings-column-change', { detail: { column: activeColumn.dataset.column } }));
  };
  columns.forEach((column) => {
    column.addEventListener('pointerdown', () => setActiveColumn(column));
    column.addEventListener('focusin', () => setActiveColumn(column));
  });
  if (columns.length > 0) setActiveColumn(columns[0]);

  // --- ИЗБОР НА ЗОНИ ---
  const selected = new Set();

  const setSelected = (led, isSelected) => {
    if (isSelected) selected.add(led.id);
    else selected.delete(led.id);

    led.el.classList.toggle('is-selected', isSelected);
    if (led.el.getAttribute('role') === 'button') {
      led.el.setAttribute('aria-pressed', String(isSelected));
    }
  };

  const toggleLed = (el) => {
    const led = leds.find((item) => item.el === el);
    if (!led) return;
    setSelected(led, !selected.has(led.id));
    render();
  };

  // Докато е отворена секцията „Функции на бутоните“, кликовете избират бутон там (bindings.js)
  const isBindingsMode = () => device.classList.contains('bindings-mode');

  device.addEventListener('click', (event) => {
    const el = event.target.closest('[data-led]');
    if (el && device.contains(el) && !isBindingsMode()) toggleLed(el);
  });

  device.addEventListener('keydown', (event) => {
    if (isBindingsMode()) return;
    const el = event.target.closest('[data-led][role="button"]');
    if (!el || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    toggleLed(el);
  });

  // --- ПРОМЕНИ ПО НАСТРОЙКИТЕ ---
  const update = (change) => {
    change(currentProfile());
    saveState();
    render();
  };

  const applyColor = (color) => {
    update((profile) => {
      if (selected.size > 0) {
        selected.forEach((id) => {
          profile.leds[id] = color;
        });
      } else {
        profile.color = color;
        profile.leds = {};
      }

      // Ефектите без собствени цветове се сменят на статичен, за да се види изборът
      if (!getEffect(profile.effect).usesColors) profile.effect = 'static';
    });
  };

  colorInput.addEventListener('input', () => applyColor(colorInput.value.toLowerCase()));

  const onSettingsClick = (event) => {
    const swatch = event.target.closest('.color-swatch');
    if (swatch) {
      applyColor(swatch.dataset.color);
      return;
    }

    const profileButton = event.target.closest('.profile-btn');
    if (profileButton) {
      state.active = Number(profileButton.dataset.profile);
      saveState();
      render();
      return;
    }

    const action = event.target.closest('[data-action]')?.dataset.action;

    if (action === 'select-all') {
      leds.forEach((led) => setSelected(led, true));
      render();
    } else if (action === 'clear-selection') {
      leds.forEach((led) => setSelected(led, false));
      render();
    } else if (action === 'reset-colors') {
      update((profile) => {
        if (selected.size > 0) {
          selected.forEach((id) => delete profile.leds[id]);
        } else {
          profile.leds = {};
        }
      });
    } else if (action === 'reset-profile') {
      state.profiles[state.active] = createProfile();
      saveState();
      device.dispatchEvent(new CustomEvent('profilereset', { detail: { profile: state.active } }));
      render();
    }
  };

  panels.addEventListener('click', onSettingsClick);
  if (profilesBar !== panels) profilesBar.addEventListener('click', onSettingsClick);

  effectInputs.forEach((input) => {
    input.addEventListener('change', () => update((profile) => {
      profile.effect = input.value;
    }));
  });

  brightnessInput.addEventListener('input', () => update((profile) => {
    profile.brightness = Number(brightnessInput.value);
  }));

  speedInput.addEventListener('input', () => update((profile) => {
    profile.speed = Number(speedInput.value);
  }));

  // Текущата подсветка за другите скриптове (logitech-keyboard.js я праща към клавиатурата)
  window.RgbChanger = window.RgbChanger || {};
  window.RgbChanger.getLighting = () => {
    const profile = currentProfile();
    return {
      effect: getEffect(profile.effect).id,
      color: profile.color,
      leds: { ...profile.leds },
      brightness: profile.brightness,
      periodMs: Math.round(Number(speedToSeconds(profile.speed)) * 1000)
    };
  };

  // --- ВИЗУАЛИЗАЦИЯ ---
  function render() {
    const profile = currentProfile();

    // Активният профил се вижда и от другите скриптове (bindings.js пази функции за всеки профил)
    if (device.dataset.profile !== String(state.active)) {
      device.dataset.profile = String(state.active);
      device.dispatchEvent(new CustomEvent('profilechange', { detail: { profile: state.active } }));
    }
    const effect = getEffect(profile.effect);

    device.classList.toggle('rgb-on', effect.id !== 'off');
    EFFECTS.forEach(({ id }) => device.classList.toggle(`rgb-effect-${id}`, id === effect.id));
    device.style.setProperty('--rgb-brightness', String(profile.brightness / 100));
    device.style.setProperty('--rgb-duration', `${speedToSeconds(profile.speed)}s`);

    leds.forEach(({ id, el }) => {
      el.style.setProperty('--led', profile.leds[id] || profile.color);
    });

    // Цветът в полето е на първата избрана зона или основният цвят
    const firstSelected = selected.values().next().value;
    const shownColor = (firstSelected && profile.leds[firstSelected]) || profile.color;
    colorInput.value = shownColor;
    colorValue.textContent = shownColor.toUpperCase();
    selectionCount.textContent = selected.size > 0 ? `Избрани: ${selected.size}` : 'Избрано: цялото устройство';

    colorNote.hidden = effect.usesColors;
    colorNote.textContent = `Ефектът „${effect.label}“ не използва избраните цветове. При избор на цвят ще се включи „Статичен“.`;

    effectInputs.forEach((input) => {
      input.checked = input.value === effect.id;
    });

    brightnessInput.value = profile.brightness;
    brightnessValue.textContent = `${profile.brightness}%`;
    speedInput.value = profile.speed;
    speedValue.textContent = profile.speed;
    speedInput.disabled = !effect.usesSpeed;

    profileButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.profile) === state.active));
    });

    device.dispatchEvent(new CustomEvent('rgbchange'));
  }

  updateWavePositions();
  window.addEventListener('resize', updateWavePositions);
  render();
})();
