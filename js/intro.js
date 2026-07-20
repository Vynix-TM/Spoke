(function () {
  const SHOW_MS = 2000;

  const splash = document.getElementById('boot-splash');
  if (!splash) return;

  document.body.classList.add('boot-lock');

  window.addEventListener('load', () => {
    setTimeout(() => {
      splash.remove();
      document.body.classList.remove('boot-lock');
    }, SHOW_MS);
  });
})();
