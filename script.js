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
  connectedDevicesBtn.after(deviceStatus);

  const showStatus = (message, isError = false) => {
    deviceStatus.textContent = message;
    deviceStatus.classList.toggle('device-status--error', isError);
    deviceStatus.hidden = false;
  };

  connectedDevicesBtn.addEventListener('click', async () => {
    if (!navigator.hid) {
      showStatus('Браузърът не поддържа WebHID. Използвай Chrome или Edge.', true);
      return;
    }

    if (!window.isSecureContext) {
      showStatus('WebHID работи само през https:// или http://localhost.', true);
      return;
    }

    try {
      const devices = await navigator.hid.requestDevice({ filters: [] });

      if (devices.length === 0) {
        showStatus('Не е избрано устройство.');
        return;
      }

      const names = devices.map((device) => device.productName || 'Неизвестно устройство');
      showStatus(`Свързани устройства: ${[...new Set(names)].join(', ')}`);
    } catch (error) {
      console.error(error);
      showStatus('Възникна грешка при търсенето на устройства.', true);
    }
  });
}
