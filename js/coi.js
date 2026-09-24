// Registers the service worker, which adds COOP/COEP headers (GitHub Pages cannot set them).
// Cross-origin isolation enables multithreaded WASM for PP-OCRv5; one reload is needed the first time.
(function () {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (!window.crossOriginIsolated && navigator.serviceWorker.controller && !sessionStorage.getItem('coiReloaded')) {
      sessionStorage.setItem('coiReloaded', '1'); location.reload();
    }
    reg.addEventListener('updatefound', () => {
      const w = reg.installing; w && w.addEventListener('statechange', () => {
        if (w.state === 'activated' && !window.crossOriginIsolated && !sessionStorage.getItem('coiReloaded')) {
          sessionStorage.setItem('coiReloaded', '1'); location.reload();
        }
      });
    });
  }).catch(e => console.warn('SW registration failed', e));
})();
