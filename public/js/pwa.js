(() => {
  const supportsServiceWorker = 'serviceWorker' in navigator;
  const pendingMessages = new Map();
  let messageId = 0;
  let registrationPromise;

  function registerServiceWorker() {
    if (!supportsServiceWorker) return Promise.reject(new Error('서비스 워커를 지원하지 않습니다.'));
    if (!registrationPromise) {
      registrationPromise = navigator.serviceWorker.register('/service-worker.js')
        .then((registration) => {
          document.documentElement.dataset.pwaReady = 'true';
          return registration;
        })
        .catch((error) => {
          document.documentElement.dataset.pwaReady = 'false';
          console.warn('서비스 워커를 등록하지 못했습니다.', error);
          throw error;
        });
    }
    return registrationPromise;
  }

  function postToServiceWorker(type, payload = {}) {
    if (!supportsServiceWorker) return Promise.reject(new Error('서비스 워커를 지원하지 않습니다.'));

    return registerServiceWorker()
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => new Promise((resolve, reject) => {
        const target = navigator.serviceWorker.controller || registration.active;
        if (!target) {
          reject(new Error('활성화된 서비스 워커가 없습니다.'));
          return;
        }

        const id = `pwa-${Date.now()}-${++messageId}`;
        const timeout = setTimeout(() => {
          pendingMessages.delete(id);
          reject(new Error('서비스 워커 응답 시간이 초과되었습니다.'));
        }, 120000);

        pendingMessages.set(id, {
          resolve: (data) => {
            clearTimeout(timeout);
            resolve(data);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          }
        });
        target.postMessage({ id, type, ...payload });
      }));
  }

  if (supportsServiceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.id && pendingMessages.has(data.id)) {
        const pending = pendingMessages.get(data.id);
        pendingMessages.delete(data.id);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data);
      }

      if (data.type === 'PDF_CACHED') {
        document.documentElement.dataset.pdfCached = data.url;
        window.dispatchEvent(new CustomEvent('pwa:pdf-cached', { detail: data }));
      }
    });

    registerServiceWorker().catch(() => {});
  }

  const unsupported = () => Promise.reject(new Error('서비스 워커를 지원하지 않습니다.'));
  window.pwaControls = {
    supported: supportsServiceWorker,
    ready: supportsServiceWorker ? registerServiceWorker().then(() => navigator.serviceWorker.ready) : Promise.resolve(null),
    getOfflineMode: () => supportsServiceWorker
      ? postToServiceWorker('GET_OFFLINE_MODE').then((data) => data.enabled === true).catch(() => false)
      : Promise.resolve(false),
    setOfflineMode: (enabled) => supportsServiceWorker
      ? postToServiceWorker('SET_OFFLINE_MODE', { enabled }).then((data) => data.enabled !== false)
      : Promise.resolve(false),
    cachePdf: (url) => supportsServiceWorker ? postToServiceWorker('CACHE_PDF', { url }) : unsupported(),
    isPdfCached: (url) => supportsServiceWorker ? postToServiceWorker('IS_PDF_CACHED', { url }) : Promise.resolve({ cached: false, entry: null })
  };

  function setOfflineToggleState(toggle, enabled, disabled = false) {
    toggle.checked = enabled;
    toggle.disabled = disabled;
    document.documentElement.dataset.offlineMode = enabled ? 'on' : 'off';
    const status = document.querySelector('#offlineToggleStatus');
    if (status) status.textContent = enabled ? '켜짐' : '꺼짐';
  }

  function bindOfflineToggle() {
    const toggle = document.querySelector('#offlineToggle');
    if (!toggle) return;

    if (!supportsServiceWorker) {
      setOfflineToggleState(toggle, false, true);
      return;
    }

    setOfflineToggleState(toggle, false, true);
    window.pwaControls.getOfflineMode()
      .then((enabled) => setOfflineToggleState(toggle, enabled, false))
      .catch(() => setOfflineToggleState(toggle, false, false));

    toggle.addEventListener('change', async () => {
      setOfflineToggleState(toggle, toggle.checked, true);
      try {
        const enabled = await window.pwaControls.setOfflineMode(toggle.checked);
        setOfflineToggleState(toggle, enabled, false);
        window.dispatchEvent(new CustomEvent('pwa:offline-mode-change', { detail: { enabled } }));
      } catch (error) {
        console.warn('오프라인 모드를 변경하지 못했습니다.', error);
        const enabled = await window.pwaControls.getOfflineMode();
        setOfflineToggleState(toggle, enabled, false);
      }
    });
  }

  function bindInstallBanner() {
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
  }

  bindOfflineToggle();
  bindInstallBanner();
})();
