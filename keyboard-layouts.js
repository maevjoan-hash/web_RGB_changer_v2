// --- ПОДРЕДБИ НА КЛАВИАТУРИТЕ ---
// Всеки ред е низ от елементи, разделени с интервал:
//   "Q"       – обикновен клавиш
//   "Esc:esc" – клавиш с размер (класът става key--esc)
//   "_"       – празно място между клавиши
//   "__"      – празен ред, който пази височината в секциите
const MAIN_ROWS = [
  'Esc:esc _ F1 F2 F3 F4 _ F5 F6 F7 F8 _ F9 F10 F11 F12',
  '` 1 2 3 4 5 6 7 8 9 0 - = Backspace:wide',
  'Tab:wide Q W E R T Y U I O P [ ] \\:wide',
  "Caps:caps A S D F G H J K L ; ' Enter:enter",
  'Shift:shift Z X C V B N M , . / Shift:shift',
  'Ctrl:mod Win:mod Alt:mod Space:space Alt:mod Fn:mod Ctrl:mod'
];

const NAV_ROWS = ['PrtSc ScrLk Pause', 'Ins Home PgUp', 'Del End PgDn', '__', '_ ↑ _', '← ↓ →'];

const NUMPAD_ROWS = ['Num / * -', '7 8 9 +', '4 5 6 +', '1 2 3 Ent', '0:wide . Ent'];

// storageId пази имената на старите отделни страници, за да не се губят запазените RGB настройки
const KEYBOARD_LAYOUTS = {
  60: {
    label: '60%',
    storageId: 'keyboard-60.html',
    rows: [
      'Esc:esc 1 2 3 4 5 6 7 8 9 0 - = Backspace:wide',
      ...MAIN_ROWS.slice(2, 5),
      'Ctrl:mod Win:mod Alt:mod Space:space Alt:mod Fn:mod Menu:mod Ctrl:mod'
    ]
  },
  75: {
    label: '75%',
    storageId: 'keyboard.html',
    rows: MAIN_ROWS
  },
  100: {
    label: '100%',
    storageId: 'keyboard-100.html',
    sections: [
      ['main', MAIN_ROWS],
      ['nav', NAV_ROWS],
      ['numpad', [...NUMPAD_ROWS, '__']]
    ]
  },
  120: {
    label: '120%',
    storageId: 'keyboard-120.html',
    sections: [
      ['macro', ['G1 G2', 'G3 G4', 'G5 G6', 'G7 G8', 'G9 G10', 'G11 G12', 'G13 G14']],
      ['main', ['Rec:esc _ F13 F14 F15 F16 _ F17 F18 F19 F20 _ F21 F22 F23 F24', ...MAIN_ROWS]],
      ['nav', ['M1 M2 M3', ...NAV_ROWS]],
      ['numpad', ['Prev Play Next Stop', 'Mute Vol- Vol+ RGB', ...NUMPAD_ROWS]]
    ]
  }
};

const DEFAULT_KEYBOARD_LAYOUT = '75';

(() => {
  const displayArea = document.querySelector('[data-keyboard-display]');
  const layoutOptions = document.querySelector('[data-keyboard-layout-options]');
  if (!displayArea) return;

  const requestedLayout = new URLSearchParams(location.search).get('layout');
  const layoutId = Object.hasOwn(KEYBOARD_LAYOUTS, requestedLayout) ? requestedLayout : DEFAULT_KEYBOARD_LAYOUT;
  const layout = KEYBOARD_LAYOUTS[layoutId];

  const renderRow = (row) => {
    const rowElement = document.createElement('div');
    rowElement.className = 'keyboard-row';

    row.split(' ').forEach((token) => {
      const element = document.createElement('div');

      if (token === '_') {
        element.className = 'key-spacer';
      } else if (token === '__') {
        element.className = 'key-spacer-row';
      } else {
        const [label, size] = token.split(':');
        element.className = size ? `key key--${size}` : 'key';
        element.textContent = label;
      }

      rowElement.append(element);
    });

    return rowElement;
  };

  const keyboard = document.createElement('div');
  keyboard.className = layoutId === DEFAULT_KEYBOARD_LAYOUT ? 'keyboard' : `keyboard keyboard--${layoutId}`;
  keyboard.dataset.storageId = layout.storageId;
  keyboard.setAttribute('aria-hidden', 'true');

  if (layout.sections) {
    layout.sections.forEach(([name, rows]) => {
      const section = document.createElement('div');
      section.className = `kb-section kb-section-${name}`;
      section.append(...rows.map(renderRow));
      keyboard.append(section);
    });
  } else {
    keyboard.append(...layout.rows.map(renderRow));
  }

  displayArea.append(keyboard);

  // Подсказка, когато клавиатурата е по-широка от екрана и трябва да се плъзга
  const scrollHint = document.createElement('p');
  scrollHint.className = 'keyboard-scroll-hint';
  scrollHint.textContent = '← Плъзни настрани, за да видиш цялата клавиатура →';
  displayArea.closest('.device-preview').after(scrollHint);

  const updateScrollHint = () => {
    scrollHint.hidden = displayArea.scrollWidth <= displayArea.clientWidth;
  };
  new ResizeObserver(updateScrollHint).observe(displayArea);

  document.title = `Конфигуратор на клавиатура - ${layout.label}`;

  if (layoutOptions) {
    Object.entries(KEYBOARD_LAYOUTS).forEach(([id, { label }]) => {
      const option = document.createElement('a');
      option.href = id === DEFAULT_KEYBOARD_LAYOUT ? 'keyboard.html' : `keyboard.html?layout=${id}`;
      option.className = 'layout-option';
      option.textContent = label;

      if (id === layoutId) {
        option.classList.add('active');
        option.setAttribute('aria-current', 'page');
      }

      layoutOptions.append(option);
    });
  }
})();
