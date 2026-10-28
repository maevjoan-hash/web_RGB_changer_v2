// --- ЛОГИКА ЗА ЗВЕЗДНИЯ ФОН ---
const canvas = document.getElementById('space-background');
if (canvas) {
  const ctx = canvas.getContext('2d');
  let width, height;

  const stars = [];
  const numStars = 150;

  for (let i = 0; i < numStars; i++) {
    stars.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      radius: Math.random() * 1.5,
      speed: Math.random() * 0.5 + 0.1,
      opacity: Math.random()
    });
  }

  function resize() {
    const oldWidth = width;
    const oldHeight = height;

    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;

    // Разпределяме звездите пропорционално, за да покриват целия нов размер
    if (oldWidth && oldHeight) {
      stars.forEach((star) => {
        star.x = (star.x / oldWidth) * width;
        star.y = (star.y / oldHeight) * height;
      });
    }
  }

  // При „намалено движение“ в системата звездите се рисуват веднъж и остават неподвижни
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let animationId = null;

  function drawStars() {
    ctx.clearRect(0, 0, width, height);

    stars.forEach((star) => {
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity})`;
      ctx.fill();

      if (reducedMotion.matches) return;

      star.y -= star.speed;

      if (star.y < 0) {
        star.y = height;
        star.x = Math.random() * width;
      }
    });

    animationId = reducedMotion.matches ? null : requestAnimationFrame(drawStars);
  }

  window.addEventListener('resize', () => {
    resize();
    // Смяната на размера изчиства платното, затова неподвижният фон се рисува отново
    if (animationId === null) drawStars();
  });
  reducedMotion.addEventListener('change', () => {
    if (animationId === null) drawStars();
  });

  resize();
  drawStars();
}

// --- ОТВОРЕН КАТО ФАЙЛ ---
// Браузърът не позволява връзка с устройства (WebHID, Web Serial) от страница, отворена като файл (file://).
// На Windows start.bat отваря сайта през http://localhost, без да се инсталира нищо (виж windows/server.ps1).
window.SiteEnv = (() => {
  const { t } = I18n;
  const isWindows = /Windows/i.test(navigator.userAgent);
  return {
    isWindows,
    isFile: location.protocol === 'file:',
    fileMessage: () => (isWindows
      ? t('Сайтът е отворен като файл и браузърът не позволява връзка с устройства. Отвори го със start.bat от папката на сайта – без инсталиране.')
      : t('Сайтът е отворен като файл и браузърът не позволява връзка с устройства. Отвори го през http://localhost или https://.'))
  };
})();

if (SiteEnv.isFile) {
  const notice = document.createElement('p');
  notice.className = 'site-notice';
  notice.setAttribute('role', 'alert');
  notice.textContent = SiteEnv.fileMessage();
  document.querySelector('.app-header')?.after(notice);
}

// --- ЛОГИКА ЗА БУТОНИТЕ ---
const connectedDevicesBtn = document.querySelector('#connected-devices-btn');
const layoutSwitchers = document.querySelectorAll('.layout-switcher');

layoutSwitchers.forEach((switcher) => {
  const button = switcher.querySelector('.layout-switcher__btn');
  const options = switcher.querySelector('.layout-options');

  if (!button || !options) return;

  const setOpen = (isOpen) => {
    switcher.classList.toggle('is-open', isOpen);
    button.setAttribute('aria-expanded', String(isOpen));
  };

  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', options.id);

  button.addEventListener('click', () => {
    setOpen(!switcher.classList.contains('is-open'));
  });

  // Изборът на опция затваря менюто (за линковете страницата така или иначе се сменя)
  options.addEventListener('click', (event) => {
    if (event.target.closest('.layout-option')) setOpen(false);
  });

  document.addEventListener('click', (event) => {
    if (!switcher.contains(event.target)) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && switcher.classList.contains('is-open')) {
      setOpen(false);
      button.focus();
    }
  });
});

if (connectedDevicesBtn) {
  const deviceStatus = document.createElement('p');
  deviceStatus.className = 'device-status';
  deviceStatus.setAttribute('role', 'status');
  deviceStatus.hidden = true;
  (connectedDevicesBtn.closest('.app-header') || connectedDevicesBtn).after(deviceStatus);

  const { t } = I18n;
  const showStatus = (message, isError = false) => {
    deviceStatus.textContent = message;
    deviceStatus.classList.toggle('device-status--error', isError);
    deviceStatus.hidden = false;
  };

  connectedDevicesBtn.addEventListener('click', async () => {
    if (SiteEnv.isFile) {
      showStatus(SiteEnv.fileMessage(), true);
      return;
    }

    if (!navigator.hid) {
      showStatus(t('Браузърът не поддържа WebHID. Използвай Chrome или Edge.'), true);
      return;
    }

    if (!window.isSecureContext) {
      showStatus(t('WebHID работи само през https:// или http://localhost.'), true);
      return;
    }

    try {
      const devices = await navigator.hid.requestDevice({ filters: [] });

      if (devices.length === 0) {
        showStatus(t('Не е избрано устройство.'));
        return;
      }

      const names = devices.map((device) => device.productName || t('Неизвестно устройство'));
      showStatus(t('Свързани устройства: {devices}', { devices: [...new Set(names)].join(', ') }));
    } catch (error) {
      console.error(error);
      showStatus(t('Възникна грешка при търсенето на устройства.'), true);
    }
  });
}

// --- МЕНЮТА „ОЩЕ“ ---
// Второстепенните действия на устройствата са в <details class="action-menu">; затварят се след избор,
// при клик извън тях и с Escape
document.addEventListener('click', (event) => {
  document.querySelectorAll('.action-menu[open]').forEach((menu) => {
    if (!menu.contains(event.target) || event.target.closest('.action-menu__list button')) menu.open = false;
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('.action-menu[open]').forEach((menu) => {
    menu.open = false;
    menu.querySelector('summary').focus();
  });
});
