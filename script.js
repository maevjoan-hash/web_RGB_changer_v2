// --- ЛОГИКА ЗА ЗВЕЗДНИЯ ФОН ---
const canvas = document.getElementById('space-background');
if (canvas) {
  const ctx = canvas.getContext('2d');
  let width, height;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }

  window.addEventListener('resize', resize);
  resize();

  const stars = [];
  const numStars = 150;

  for (let i = 0; i < numStars; i++) {
    stars.push({
      x: Math.random() * width,
      y: Math.random() * height,
      radius: Math.random() * 1.5,
      speed: Math.random() * 0.5 + 0.1,
      opacity: Math.random()
    });
  }

  function drawStars() {
    ctx.clearRect(0, 0, width, height);

    stars.forEach((star) => {
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity})`;
      ctx.fill();

      star.y -= star.speed;

      if (star.y < 0) {
        star.y = height;
        star.x = Math.random() * width;
      }
    });

    requestAnimationFrame(drawStars);
  }

  drawStars();
}

// --- ЛОГИКА ЗА БУТОНИТЕ ---
const connectedDevicesBtn = document.querySelector('#connected-devices-btn');
const settingsTabs = document.querySelectorAll('.settings-tab');
const layoutSwitchers = document.querySelectorAll('.layout-switcher');

layoutSwitchers.forEach((switcher) => {
  const button = switcher.querySelector('#layout-switcher-btn');
  const options = switcher.querySelector('#layout-options');

  if (!button || !options) return;

  const setOpen = (isOpen) => {
    switcher.classList.toggle('is-open', isOpen);
    options.classList.toggle('open', isOpen);
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

document.querySelectorAll('.mouse-btn-group').forEach((mouseButton) => {
  const togglePressed = () => {
    const isPressed = mouseButton.getAttribute('aria-pressed') === 'true';
    mouseButton.setAttribute('aria-pressed', String(!isPressed));
    mouseButton.classList.toggle('is-active', !isPressed);
  };

  mouseButton.addEventListener('click', togglePressed);
  mouseButton.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      togglePressed();
    }
  });
});

if (connectedDevicesBtn) {
  connectedDevicesBtn.addEventListener('click', async () => {
    try {
      const devices = await navigator.hid.requestDevice({ filters: [] });
      console.log(devices);
    } catch (error) {
      console.error(error);
    }
  });
}

settingsTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    console.log(`Натиснат е бутон ${tab.dataset.tab}`);
  });
});
