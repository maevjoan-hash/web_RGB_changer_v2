// --- SONY WH-1000XM5: ШУМОПОТИСКАНЕ, ЕКВАЛАЙЗЕР И ФУНКЦИИ ---
// Връзката със слушалките (Web Serial през Bluetooth RFCOMM) се добавя в следващата стъпка.
(() => {
  // --- ИНТЕРФЕЙС ---
  const svg = document.querySelector('.headphones-svg');
  const bar = document.querySelector('[data-device-actions]');
  const columns = document.querySelectorAll('.settings-column');
  if (!svg || !bar || columns.length < 2) return;

  const EQ_BANDS = ['400', '1k', '2.5k', '6.3k', '16k'];
  const MODES = [
    { id: 'nc', label: 'Шумопотискане' },
    { id: 'ambient', label: 'Околен звук' },
    { id: 'off', label: 'Изключено' }
  ];

  const [soundPanels, devicePanels] = [...columns].map((column) => column.querySelector('.settings-panels'));
  soundPanels.innerHTML = `
    <div class="settings-panel" data-panel="1">
      <fieldset class="effect-options hp-control">
        <legend class="visually-hidden">Режим</legend>
        ${MODES.map(({ id, label }) => `<label class="effect-option"><input type="radio" name="hp-mode" value="${id}" /><span>${label}</span></label>`).join('')}
      </fieldset>
      <label class="range-field hp-control">
        <span class="range-field__label">Ниво на околния звук <output id="hp-level-value"></output></span>
        <input type="range" id="hp-level" min="1" max="20" step="1" />
      </label>
      <label class="hp-toggle hp-control">
        <input type="checkbox" id="hp-voice" />
        <span>Фокус върху гласа<small>Пропуска говор, заглушава останалия околен шум</small></span>
      </label>
    </div>
    <div class="settings-panel" data-panel="2">
      <label class="field hp-control">
        <span class="field__label">Готова настройка</span>
        <select class="field__select" id="hp-eq-preset"></select>
      </label>
      <label class="range-field hp-control">
        <span class="range-field__label">Clear Bass <output id="hp-bass-value"></output></span>
        <input type="range" id="hp-bass" min="-10" max="10" step="1" />
      </label>
      <div class="hp-eq hp-control" role="group" aria-label="Ленти на еквалайзера">
        ${EQ_BANDS.map((band, index) => `
          <label class="hp-eq__band">
            <output id="hp-band-value-${index}"></output>
            <input type="range" data-band="${index}" min="-10" max="10" step="1" aria-label="${band} Hz" />
            <span>${band}</span>
          </label>`).join('')}
      </div>
      <p class="settings-hint">Промяна на лентите превключва на „Ръчна“ настройка.</p>
    </div>
  `;
  devicePanels.innerHTML = `
    <div class="settings-panel" data-panel="3">
      <label class="hp-toggle hp-control">
        <input type="checkbox" id="hp-dsee" />
        <span>DSEE Extreme<small>Възстановява детайли в компресирана музика</small></span>
      </label>
      <label class="hp-toggle hp-control">
        <input type="checkbox" id="hp-stc" />
        <span>Speak-to-Chat<small>Спира музиката, когато заговориш</small></span>
      </label>
    </div>
    <div class="settings-panel" data-panel="4">
      <dl class="hp-info">
        <dt>Модел</dt><dd id="hp-info-model">–</dd>
        <dt>Фърмуер</dt><dd id="hp-info-firmware">–</dd>
        <dt>Батерия</dt><dd id="hp-info-battery">–</dd>
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
})();
