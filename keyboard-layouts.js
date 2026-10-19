// --- ПОДРЕДБИ НА КЛАВИАТУРИТЕ ---
// Размерите са в units (u), както при истинските клавиатури: 1u е един обикновен клавиш
// (19,05 мм). Ширините следват стандартния ANSI размер: Tab 1.5u, Caps 1.75u, Enter 2.25u,
// ляв Shift 2.25u, десен Shift 2.75u, модификатори 1.25u, интервал 6.25u.
//
// Всеки ред е низ от елементи, разделени с интервал:
//   "Q"       – клавиш 1u
//   "Tab:1.5" – клавиш с ширина 1.5u
//   "+:1x2"   – клавиш 1u широк и 2u висок (numpad + и Enter)
//   "_0.5"    – празно място 0.5u
// Ред, записан като { gap: 0.5, keys: '…' }, започва с допълнително разстояние отгоре.
const F_ROW = 'Esc _1 F1 F2 F3 F4 _0.5 F5 F6 F7 F8 _0.5 F9 F10 F11 F12';
const NUMBER_ROW = '` 1 2 3 4 5 6 7 8 9 0 - = Backspace:2';
const TAB_ROW = 'Tab:1.5 Q W E R T Y U I O P [ ] \\:1.5';
const CAPS_ROW = "Caps:1.75 A S D F G H J K L ; ' Enter:2.25";
const SHIFT_ROW = 'Shift:2.25 Z X C V B N M , . / Shift:2.75';
const BOTTOM_ROW = 'Ctrl:1.25 Win:1.25 Alt:1.25 Space:6.25 Alt:1.25 Fn:1.25 Menu:1.25 Ctrl:1.25';

// Пълноразмерна клавиатура: основен блок 15u, навигация 3u и numpad 4u с разстояния 0.25u
const FULL_SIZE_ROWS = [
  `${F_ROW} _0.25 PrtSc ScrLk Pause`,
  { gap: 0.5, keys: `${NUMBER_ROW} _0.25 Ins Home PgUp _0.25 Num / * -` },
  `${TAB_ROW} _0.25 Del End PgDn _0.25 7 8 9 +:1x2`,
  `${CAPS_ROW} _3.5 4 5 6`,
  `${SHIFT_ROW} _1.25 ↑ _1.25 1 2 3 Enter:1x2`,
  `${BOTTOM_ROW} _0.25 ← ↓ → _0.25 0:2 .`
];

// storageId пази имената на старите отделни страници, за да не се губят запазените RGB настройки
const KEYBOARD_LAYOUTS = {
  60: {
    label: '60%',
    storageId: 'keyboard-60.html',
    rows: [NUMBER_ROW.replace('`', 'Esc'), TAB_ROW, CAPS_ROW, SHIFT_ROW, BOTTOM_ROW]
  },
  75: {
    label: '75%',
    storageId: 'keyboard.html',
    rows: [
      'Esc F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 PrtSc Ins Del',
      { gap: 0.25, keys: `${NUMBER_ROW} PgUp` },
      `${TAB_ROW} PgDn`,
      `${CAPS_ROW} Home`,
      'Shift:2.25 Z X C V B N M , . / Shift:1.75 ↑ End',
      'Ctrl:1.25 Win:1.25 Alt:1.25 Space:6.25 Alt Fn Ctrl ← ↓ →'
    ]
  },
  // TKL (80%) като Logitech G515 TKL: пълноразмерна без numpad, 87 клавиша
  80: {
    label: 'TKL (80%)',
    storageId: 'keyboard-tkl',
    rows: [
      `${F_ROW} _0.25 PrtSc ScrLk Pause`,
      { gap: 0.5, keys: `${NUMBER_ROW} _0.25 Ins Home PgUp` },
      `${TAB_ROW} _0.25 Del End PgDn`,
      CAPS_ROW,
      `${SHIFT_ROW} _1.25 ↑`,
      `${BOTTOM_ROW} _0.25 ← ↓ →`
    ]
  },
  100: {
    label: '100%',
    storageId: 'keyboard-100.html',
    rows: FULL_SIZE_ROWS
  },
  120: {
    label: '120%',
    storageId: 'keyboard-120.html',
    // Макро колона G1–G14 вляво, ред F13–F24, M1–M3 над навигацията и медийни клавиши над numpad-а
    rows: [
      'G1 G2 _0.5 Rec _1 F13 F14 F15 F16 _0.5 F17 F18 F19 F20 _0.5 F21 F22 F23 F24 _0.25 M1 M2 M3 _0.25 Prev Play Next Stop',
      `G3 G4 _0.5 ${FULL_SIZE_ROWS[0]} _0.25 Mute Vol- Vol+ RGB`,
      ...['G5 G6', 'G7 G8', 'G9 G10', 'G11 G12', 'G13 G14'].map((macroKeys, index) => {
        const row = FULL_SIZE_ROWS[index + 1];
        return typeof row === 'string'
          ? `${macroKeys} _0.5 ${row}`
          : { ...row, keys: `${macroKeys} _0.5 ${row.keys}` };
      })
    ]
  }
};

const DEFAULT_KEYBOARD_LAYOUT = '75';

// Превръща редовете в клавиши с позиция (x, y) и размер (w, h) в units
const parseKeyboardLayout = (rows) => {
  const keys = [];
  let y = 0;
  let width = 0;

  rows.forEach((row) => {
    const { gap = 0, keys: tokens } = typeof row === 'string' ? { keys: row } : row;
    let x = 0;
    y += gap;

    tokens.split(' ').forEach((token) => {
      if (token.startsWith('_')) {
        x += Number(token.slice(1));
        return;
      }

      const separator = token.lastIndexOf(':');
      const label = separator > 0 ? token.slice(0, separator) : token;
      const [w = 1, h = 1] = separator > 0 ? token.slice(separator + 1).split('x').map(Number) : [];

      keys.push({ label, x, y, w, h });
      x += w;
    });

    width = Math.max(width, x);
    y += 1;
  });

  const height = Math.max(...keys.map((key) => key.y + key.h));
  return { keys, width, height };
};

(() => {
  const displayArea = document.querySelector('[data-keyboard-display]');
  const layoutOptions = document.querySelector('[data-keyboard-layout-options]');
  if (!displayArea) return;

  const requestedLayout = new URLSearchParams(location.search).get('layout');
  const layoutId = Object.hasOwn(KEYBOARD_LAYOUTS, requestedLayout) ? requestedLayout : DEFAULT_KEYBOARD_LAYOUT;
  const layout = KEYBOARD_LAYOUTS[layoutId];
  const { keys, width, height } = parseKeyboardLayout(layout.rows);

  const keyboard = document.createElement('div');
  keyboard.className = `keyboard keyboard--${layoutId}`;
  keyboard.dataset.storageId = layout.storageId;
  keyboard.style.setProperty('--kb-w', width);
  keyboard.style.setProperty('--kb-h', height);
  keyboard.setAttribute('aria-hidden', 'true');

  const plate = document.createElement('div');
  plate.className = 'keyboard__plate';

  // Стабилен идентификатор за RGB настройките: етикет + пореден номер при повторение (Shift, Shift#2)
  const labelCounts = {};

  keys.forEach(({ label, x, y, w, h }) => {
    labelCounts[label] = (labelCounts[label] || 0) + 1;

    const key = document.createElement('div');
    key.className = label.length > 4 && w < 1.5 ? 'key key--small' : 'key';
    key.dataset.keyId = labelCounts[label] > 1 ? `${label}#${labelCounts[label]}` : label;
    key.style.cssText = `--x: ${x}; --y: ${y}; --w: ${w}; --h: ${h}`;

    const top = document.createElement('span');
    top.className = 'key__top';
    top.textContent = label;

    key.append(top);
    plate.append(key);
  });

  keyboard.append(plate);
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
