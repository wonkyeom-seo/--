(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js')
        .then(() => {
          document.documentElement.dataset.pwaReady = 'true';
        })
        .catch((error) => {
          console.warn('서비스 워커를 등록하지 못했습니다.', error);
        });
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'PDF_CACHED') {
        document.documentElement.dataset.pdfCached = event.data.url;
      }
    });
  }

  const installButton = document.querySelector('#installButton');
  if (!installButton) return;

  let installPrompt;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installButton.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installButton.hidden = true;
  });
})();
