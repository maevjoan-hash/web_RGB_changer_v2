// --- УЕБ КАМЕРА: КАРТИНА, ФОКУС, ЕКСПОНАЦИЯ И ПРОФИЛИ ---
// USB камерите (UVC) приемат настройките си направо от браузъра: MediaStreamTrack.getCapabilities() казва
// какво поддържа камерата, а applyConstraints() го променя. Без инсталиране и без протокол на конкретна марка.
// Настройките се пазят по профили за всяка камера и се прилагат при пускане.
(() => {
  const { t } = I18n;
  const video = document.querySelector('#webcam-video');
  const bar = document.querySelector('[data-device-actions]');
  const profilesBar = document.querySelector('[data-profiles]');
  const columns = document.querySelectorAll('.settings-column');
  if (!video || !bar || !profilesBar || columns.length < 2) return;

  const STORAGE_KEY = 'rgb-changer-webcam';
  const PROFILE_COUNT = 3;
  const MODE_LABELS = { continuous: t('Автоматичен'), manual: t('Ръчен'), 'single-shot': t('Еднократен'), none: t('Без') };
  // manual: коя настройка за режим трябва да е „manual“, за да има ефект тази стойност
  const CONTROLS = [
    { key: 'brightness', label: t('Яркост'), panel: 1 },
    { key: 'contrast', label: t('Контраст'), panel: 1 },
    { key: 'saturation', label: t('Наситеност'), panel: 1 },
    { key: 'sharpness', label: t('Острота'), panel: 1 },
    { key: 'backgroundBlur', label: t('Размазан фон'), panel: 1, toggle: true },
    { key: 'exposureMode', label: t('Експонация'), panel: 2, mode: true },
    { key: 'exposureTime', label: t('Време на експонация'), panel: 2, manual: 'exposureMode' },
    { key: 'exposureCompensation', label: t('Корекция на експонацията'), panel: 2 },
    { key: 'whiteBalanceMode', label: t('Баланс на бялото'), panel: 2, mode: true },
    { key: 'colorTemperature', label: t('Цветна температура'), panel: 2, manual: 'whiteBalanceMode', unit: 'K' },
    { key: 'focusMode', label: t('Фокус'), panel: 3, mode: true },
    { key: 'focusDistance', label: t('Разстояние на фокуса'), panel: 3, manual: 'focusMode' },
    { key: 'zoom', label: t('Мащаб'), panel: 3 },
    { key: 'pan', label: t('Завъртане наляво/надясно'), panel: 3 },
    { key: 'tilt', label: t('Наклон нагоре/надолу'), panel: 3 }
  ];
  const RESOLUTIONS = [[640, 480], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]];
  const FRAME_RATES = [15, 24, 30, 60];

  // --- ПАНЕЛИ ---
  const [imagePanels, cameraPanels] = [...columns].map((column) => column.querySelector('.settings-panels'));
  const controlPanel = (panel) => `
    <div class="settings-panel" data-panel="${panel}">
      <p class="settings-hint" data-cam-hint>${t('Пусни камерата, за да видиш настройките, които поддържа.')}</p>
      <div class="webcam-controls" data-controls="${panel}"></div>
    </div>`;
  imagePanels.innerHTML = controlPanel(1) + controlPanel(2);
  cameraPanels.innerHTML = `${controlPanel(3)}
    <div class="settings-panel" data-panel="4">
      <label class="field">
        <span class="field__label">${t('Камера')}</span>
        <select class="field__select" id="cam-device"><option value="">${t('По подразбиране')}</option></select>
      </label>
      <div class="webcam-row">
        <label class="field">
          <span class="field__label">${t('Резолюция')}</span>
          <select class="field__select" id="cam-resolution"></select>
        </label>
        <label class="field">
          <span class="field__label">${t('Кадри в секунда')}</span>
          <select class="field__select" id="cam-fps"></select>
        </label>
      </div>
      <label class="hp-toggle">
        <input type="checkbox" id="cam-mirror" />
        <span>${t('Огледален образ')}<small>${t('Само за показване тук и за снимките')}</small></span>
      </label>
      <dl class="hp-info">
        <dt>${t('Камера')}</dt><dd id="cam-info-name">–</dd>
        <dt>${t('Образ')}</dt><dd id="cam-info-format">–</dd>
        <dt>${t('Настройки')}</dt><dd id="cam-info-controls">–</dd>
      </dl>
    </div>`;

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

  bar.innerHTML = `
    <div class="device-bar">
      <div class="panel-actions save-bar__row">
        <button type="button" class="panel-btn panel-btn--primary" data-cam-action="start">${t('Пусни камерата')}</button>
        <span class="save-bar__group" data-running hidden>
          <button type="button" class="panel-btn panel-btn--primary" data-cam-action="snapshot">${t('Снимка')}</button>
          <details class="action-menu">
            <summary class="panel-btn">${t('Още')} ▾</summary>
            <div class="action-menu__list">
              <button type="button" class="panel-btn" data-cam-action="reset">${t('Нулирай настройките на профила')}</button>
              <hr />
              <button type="button" class="panel-btn panel-btn--danger" data-cam-action="stop">${t('Спри камерата')}</button>
            </div>
          </details>
        </span>
      </div>
      <p class="device-log" id="device-log" role="status"></p>
    </div>`;
  profilesBar.innerHTML = `
    <div class="panel-actions save-bar__row">
      <div class="segmented" role="group" aria-label="${t('Профили')}">
        ${Array.from({ length: PROFILE_COUNT }, (_, index) =>
          `<button type="button" class="panel-btn profile-btn" data-profile="${index}">${t('Профил {n}', { n: index + 1 })}</button>`).join('')}
      </div>
    </div>`;

  const $ = (selector) => document.querySelector(selector);
  const log = $('#device-log');
  const placeholder = $('#webcam-placeholder');
  const badge = $('#webcam-badge');
  const runningGroup = bar.querySelector('[data-running]');
  const startButton = bar.querySelector('[data-cam-action="start"]');
  const deviceSelect = $('#cam-device');
  const resolutionSelect = $('#cam-resolution');
  const fpsSelect = $('#cam-fps');
  const mirrorInput = $('#cam-mirror');

  const setLog = (message, isError = false) => {
    log.textContent = message;
    log.classList.toggle('device-log--error', isError);
  };

  // --- ЗАПАЗЕНИ НАСТРОЙКИ ---
  const loadStore = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  };
  const store = { cameras: {}, resolution: '1280x720', fps: 30, mirror: true, ...loadStore() };
  const saveStore = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // Без localStorage настройките важат до затваряне на страницата
    }
  };

  let stream = null;
  let track = null;
  let capabilities = {};
  let camera = null; // запис в store.cameras за текущата камера

  const currentProfile = () => camera.profiles[camera.active];
  // Стойностите на профила върху началните стойности на камерата
  const profileValues = () => ({ ...camera.defaults, ...currentProfile() });

  // --- КОНТРОЛИ ПО ВЪЗМОЖНОСТИТЕ НА КАМЕРАТА ---
  const supported = (control) => {
    const capability = capabilities[control.key];
    if (control.mode) return Array.isArray(capability) && capability.length > 1;
    if (control.toggle) return Array.isArray(capability) && capability.includes(true);
    return capability && typeof capability.max === 'number' && capability.max > capability.min;
  };

  const formatValue = (control, value) => {
    if (typeof value !== 'number') return '';
    const rounded = Number.isInteger(value) ? value : Number(value.toFixed(2));
    return control.unit ? `${rounded} ${control.unit}` : String(rounded);
  };

  const renderControls = () => {
    const values = profileValues();
    for (let panel = 1; panel <= 3; panel += 1) {
      const holder = document.querySelector(`[data-controls="${panel}"]`);
      const list = CONTROLS.filter((control) => control.panel === panel && supported(control));
      holder.innerHTML = list.map((control) => {
        const capability = capabilities[control.key];
        if (control.mode) {
          return `<label class="field"><span class="field__label">${control.label}</span>
            <select class="field__select" data-control="${control.key}">
              ${capability.map((mode) => `<option value="${mode}">${MODE_LABELS[mode] || mode}</option>`).join('')}
            </select></label>`;
        }
        if (control.toggle) {
          return `<label class="hp-toggle"><input type="checkbox" data-control="${control.key}" /><span>${control.label}</span></label>`;
        }
        return `<label class="range-field">
          <span class="range-field__label">${control.label} <output data-output="${control.key}"></output></span>
          <input type="range" data-control="${control.key}" min="${capability.min}" max="${capability.max}"
            step="${capability.step || (capability.max - capability.min) / 100}" />
        </label>`;
      }).join('');
      const hint = holder.closest('.settings-panel').querySelector('[data-cam-hint]');
      hint.textContent = t('Тази камера не поддържа тези настройки.');
      hint.hidden = list.length > 0;
    }
    document.querySelectorAll('[data-control]').forEach((input) => {
      const control = CONTROLS.find(({ key }) => key === input.dataset.control);
      const value = values[control.key];
      if (control.toggle) input.checked = Boolean(value);
      else if (value !== undefined) input.value = value;
      const output = document.querySelector(`[data-output="${control.key}"]`);
      if (output) output.textContent = formatValue(control, value);
    });
    updateManualState();
  };

  // Ръчните стойности се виждат като активни само при ръчен режим
  const updateManualState = () => {
    const values = profileValues();
    CONTROLS.filter((control) => control.manual).forEach((control) => {
      const input = document.querySelector(`[data-control="${control.key}"]`);
      if (input && supported(CONTROLS.find(({ key }) => key === control.manual))) {
        input.closest('.range-field').classList.toggle('is-auto', values[control.manual] !== 'manual');
      }
    });
  };

  const apply = async (values) => {
    const constraints = {};
    Object.entries(values).forEach(([key, value]) => {
      const control = CONTROLS.find((candidate) => candidate.key === key);
      if (control && supported(control) && value !== undefined) constraints[key] = value;
    });
    if (Object.keys(constraints).length) await track.applyConstraints({ advanced: [constraints] });
  };

  // Промяна от контрола: при ръчна стойност режимът ѝ минава на „ръчен“
  const timers = {};
  const changeControl = (key, value) => {
    const control = CONTROLS.find((candidate) => candidate.key === key);
    const profile = currentProfile();
    profile[key] = value;
    const changes = { [key]: value };
    if (control.manual && supported(CONTROLS.find(({ key: modeKey }) => modeKey === control.manual)) &&
      profileValues()[control.manual] !== 'manual') {
      profile[control.manual] = 'manual';
      changes[control.manual] = 'manual';
      const modeSelect = document.querySelector(`[data-control="${control.manual}"]`);
      if (modeSelect) modeSelect.value = 'manual';
    }
    saveStore();
    updateManualState();
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      apply(changes)
        .then(showSaved)
        .catch((error) => setLog(t('Камерата не прие „{label}“: {error}', { label: control.label, error: error.message }), true));
    }, 60);
  };

  // Всяка промяна се пази веднага в профила – съобщението го показва
  const showSaved = () => {
    setLog(t('✓ Запазено в профил {n}. Прилага се при всяко пускане на камерата.', { n: camera.active + 1 }));
  };

  function onControl(event) {
    const input = event.target.closest('[data-control]');
    if (!input || !track) return;
    const control = CONTROLS.find(({ key }) => key === input.dataset.control);
    const value = control.mode ? input.value : control.toggle ? input.checked : Number(input.value);
    const output = document.querySelector(`[data-output="${control.key}"]`);
    if (output) output.textContent = formatValue(control, value);
    changeControl(control.key, value);
  }
  document.querySelector('.settings-columns').addEventListener('input', onControl);

  // --- ПРОФИЛИ ---
  const renderProfiles = () => {
    profilesBar.querySelectorAll('.profile-btn').forEach((button) => {
      const isActive = Boolean(camera) && Number(button.dataset.profile) === camera.active;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
      button.disabled = !camera;
    });
  };

  profilesBar.addEventListener('click', async (event) => {
    const button = event.target.closest('.profile-btn');
    if (!button || !camera) return;
    camera.active = Number(button.dataset.profile);
    saveStore();
    renderProfiles();
    renderControls();
    await apply(profileValues()).catch((error) => setLog(error.message, true));
    setLog(t('Профил {n} е приложен.', { n: camera.active + 1 }));
  });

  // --- КАМЕРА ---
  const fillSelects = () => {
    const maxWidth = capabilities.width?.max || 1920;
    const maxHeight = capabilities.height?.max || 1080;
    const resolutions = RESOLUTIONS.filter(([width, height]) => width <= maxWidth && height <= maxHeight);
    resolutionSelect.innerHTML = resolutions.map(([width, height]) =>
      `<option value="${width}x${height}">${width} × ${height}</option>`).join('');
    resolutionSelect.value = resolutions.some(([w, h]) => `${w}x${h}` === store.resolution)
      ? store.resolution
      : resolutionSelect.options[resolutionSelect.options.length - 1]?.value;
    const maxFps = capabilities.frameRate?.max || 30;
    const rates = FRAME_RATES.filter((rate) => rate <= Math.round(maxFps));
    fpsSelect.innerHTML = rates.map((rate) => `<option value="${rate}">${rate}</option>`).join('');
    fpsSelect.value = rates.includes(store.fps) ? String(store.fps) : String(rates[rates.length - 1] || 30);
  };

  const listCameras = async () => {
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    deviceSelect.innerHTML = cameras.map((device, index) =>
      `<option value="${device.deviceId}">${device.label || t('Камера {n}', { n: index + 1 })}</option>`).join('');
    if (track) deviceSelect.value = track.getSettings().deviceId || deviceSelect.value;
  };

  const renderInfo = () => {
    const settings = track.getSettings();
    const format = `${settings.width} × ${settings.height}${settings.frameRate ? ` · ${Math.round(settings.frameRate)} fps` : ''}`;
    $('#cam-info-name').textContent = track.label || '–';
    $('#cam-info-format').textContent = format;
    $('#cam-info-controls').textContent = t('{supported} от {total}', { supported: CONTROLS.filter(supported).length, total: CONTROLS.length });
    badge.textContent = format;
    badge.hidden = false;
  };

  const showRunning = (isRunning) => {
    startButton.hidden = isRunning;
    runningGroup.hidden = !isRunning;
    placeholder.hidden = isRunning;
    if (!isRunning) badge.hidden = true;
    video.classList.toggle('is-mirrored', store.mirror);
  };

  const stop = () => {
    stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
    stream = null;
    track = null;
    video.srcObject = null;
    showRunning(false);
  };

  const start = async (deviceId = store.deviceId) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('Браузърът не дава достъп до камерата.'));
    stop();
    const [width, height] = store.resolution.split('x').map(Number);
    setLog(t('Пускам камерата…'));
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: store.fps }
        }
      });
    } catch (error) {
      if (deviceId && error.name === 'OverconstrainedError') return start('');
      const messages = {
        NotAllowedError: t('Достъпът до камерата е отказан. Разреши го от иконата до адреса.'),
        NotFoundError: t('Няма свързана камера.'),
        NotReadableError: t('Камерата се използва от друга програма.')
      };
      throw new Error(messages[error.name] || error.message);
    }
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    capabilities = track.getCapabilities?.() || {};
    store.deviceId = track.getSettings().deviceId || '';

    // Началните стойности на камерата се помнят веднъж – „Нулирай настройките“ се връща към тях
    const cameraKey = track.label || store.deviceId || 'camera';
    const settings = track.getSettings();
    if (!store.cameras[cameraKey]) {
      const defaults = {};
      CONTROLS.forEach(({ key }) => {
        if (settings[key] !== undefined) defaults[key] = settings[key];
      });
      store.cameras[cameraKey] = { defaults, profiles: Array.from({ length: PROFILE_COUNT }, () => ({})), active: 0 };
    }
    camera = store.cameras[cameraKey];
    store.running = true;
    saveStore();

    showRunning(true);
    fillSelects();
    renderControls();
    renderProfiles();
    await apply(profileValues()).catch(() => {});
    await listCameras();
    renderInfo();
    setLog(track.label
      ? t('{name} е пусната. Настройките се прилагат веднага.', { name: track.label })
      : t('Камерата е пусната. Настройките се прилагат веднага.'));
  };

  const snapshot = () => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (store.mirror) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      const link = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      link.href = URL.createObjectURL(blob);
      link.download = `${t('snimka')}-${stamp}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }, 'image/png');
    setLog(t('Снимката е изтеглена.'));
  };

  // --- СЪБИТИЯ ---
  const actions = {
    start: () => start(),
    stop: () => {
      stop();
      store.running = false;
      saveStore();
      setLog(t('Камерата е спряна.'));
    },
    snapshot,
    reset: async () => {
      camera.profiles[camera.active] = {};
      saveStore();
      renderControls();
      await apply(camera.defaults);
      setLog(t('✓ Профил {n} е върнат към началните настройки на камерата и е запазен.', { n: camera.active + 1 }));
    }
  };
  bar.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-cam-action]')?.dataset.camAction;
    if (!action) return;
    try {
      await actions[action]();
    } catch (error) {
      console.error(error);
      setLog(error.message || String(error), true);
    }
  });

  deviceSelect.addEventListener('change', () => start(deviceSelect.value).catch((error) => setLog(error.message, true)));
  resolutionSelect.addEventListener('change', () => {
    store.resolution = resolutionSelect.value;
    saveStore();
    if (track) start(store.deviceId).catch((error) => setLog(error.message, true));
  });
  fpsSelect.addEventListener('change', () => {
    store.fps = Number(fpsSelect.value);
    saveStore();
    if (track) start(store.deviceId).catch((error) => setLog(error.message, true));
  });
  mirrorInput.checked = store.mirror;
  mirrorInput.addEventListener('change', () => {
    store.mirror = mirrorInput.checked;
    saveStore();
    video.classList.toggle('is-mirrored', store.mirror);
  });

  showRunning(false);
  renderProfiles();

  // Ако камерата е била пусната и браузърът вече има разрешение, тръгва сама
  if (store.running && navigator.permissions) {
    navigator.permissions.query({ name: 'camera' }).then((status) => {
      if (status.state === 'granted') start().catch((error) => setLog(error.message, true));
    }).catch(() => {});
  }
})();
