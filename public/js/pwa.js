(() => {
  async function removeLegacyServiceWorkers() {
    let registrations = [];
    if ('serviceWorker' in navigator) {
      registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }

    if ('caches' in window) {
      const legacyPrefixes = [
        'app-shell-',
        'pdf-files-',
        'api-lists-',
        'runtime-assets-',
        'pwa-settings-',
        'pdf-metadata-'
      ];
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => legacyPrefixes.some((prefix) => name.startsWith(prefix)))
          .map((name) => caches.delete(name))
      );
    }

    if (registrations.length && !sessionStorage.getItem('exam-library:service-worker-cleaned')) {
      sessionStorage.setItem('exam-library:service-worker-cleaned', '1');
      location.reload();
    } else {
      sessionStorage.removeItem('exam-library:service-worker-cleaned');
    }
  }

  removeLegacyServiceWorkers().catch((error) => {
    console.warn('이전 백그라운드 캐시를 정리하지 못했습니다.', error);
  });

  const installBanner = document.querySelector('#installBanner');
  const installButton = document.querySelector('#installButton');
  const closeButton = document.querySelector('#installBannerClose');
  if (!installButton) return;

  let installPrompt;
  const dismissed = () => sessionStorage.getItem('exam-library:install-banner-dismissed') === '1';
  const showInstallUi = () => {
    if (dismissed()) return;
    installButton.hidden = false;
    if (installBanner) installBanner.hidden = false;
  };
  const hideInstallUi = () => {
    installButton.hidden = true;
    if (installBanner) installBanner.hidden = true;
  };

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    showInstallUi();
  });

  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    hideInstallUi();
  });

  closeButton?.addEventListener('click', () => {
    sessionStorage.setItem('exam-library:install-banner-dismissed', '1');
    hideInstallUi();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    hideInstallUi();
  });
})();
