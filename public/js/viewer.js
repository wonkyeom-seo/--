import * as pdfjsLib from '/vendor/pdfjs/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

const params = new URLSearchParams(location.search);
const relativePath = params.get('path') || '';
const fileName = relativePath.split('/').at(-1) || 'PDF';
const parentPath = relativePath.split('/').slice(0, -1).join('/');

const canvas = document.querySelector('#pdfCanvas');
const stage = document.querySelector('#viewerStage');
const status = document.querySelector('#viewerStatus');
const fileNameElement = document.querySelector('#fileName');
const pageSummary = document.querySelector('#pageSummary');
const pageNumberInput = document.querySelector('#pageNumber');
const pageCountElement = document.querySelector('#pageCount');
const prevButton = document.querySelector('#prevPage');
const nextButton = document.querySelector('#nextPage');
const zoomOutButton = document.querySelector('#zoomOut');
const zoomInButton = document.querySelector('#zoomIn');
const zoomValue = document.querySelector('#zoomValue');
const fitWidthButton = document.querySelector('#fitWidth');
const downloadLink = document.querySelector('#downloadLink');
const backLink = document.querySelector('#backLink');

let pdf;
let currentPage = 1;
let zoom = 1;
let fitMode = true;
let renderTask;
let resizeTimer;

function encodePath(pathValue) {
  return pathValue.split('/').map(encodeURIComponent).join('/');
}

function setStatus(title, detail = '', isError = false) {
  status.classList.remove('hidden');
  status.innerHTML = `${isError ? '' : '<span class="spinner"></span>'}<strong>${title}</strong><small>${detail}</small>`;
  canvas.classList.remove('visible');
}

function updateControls() {
  pageNumberInput.value = currentPage;
  pageNumberInput.max = pdf?.numPages || 1;
  pageCountElement.textContent = pdf?.numPages || '-';
  prevButton.disabled = !pdf || currentPage <= 1;
  nextButton.disabled = !pdf || currentPage >= pdf.numPages;
  zoomOutButton.disabled = zoom <= 0.5;
  zoomInButton.disabled = zoom >= 3;
  zoomValue.textContent = fitMode ? '맞춤' : `${Math.round(zoom * 100)}%`;
  pageSummary.textContent = pdf ? `${currentPage} / ${pdf.numPages} 페이지` : 'PDF 불러오는 중';
}

async function renderPage() {
  if (!pdf) return;
  if (renderTask) renderTask.cancel();

  const page = await pdf.getPage(currentPage);
  const baseViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(stage.clientWidth - (innerWidth <= 760 ? 16 : 56), 240);
  const fitScale = availableWidth / baseViewport.width;
  const displayScale = fitMode ? fitScale : zoom;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: displayScale * pixelRatio });
  const displayViewport = page.getViewport({ scale: displayScale });
  const context = canvas.getContext('2d', { alpha: false });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(displayViewport.width)}px`;
  canvas.style.height = `${Math.floor(displayViewport.height)}px`;

  renderTask = page.render({ canvasContext: context, viewport });
  try {
    await renderTask.promise;
    status.classList.add('hidden');
    canvas.classList.add('visible');
    stage.scrollTo({ top: 0, left: Math.max((canvas.offsetWidth - stage.clientWidth) / 2, 0), behavior: 'instant' });
    updateControls();
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') {
      setStatus('페이지를 표시하지 못했습니다.', error.message, true);
    }
  } finally {
    renderTask = null;
  }
}

function goToPage(pageNumber) {
  if (!pdf) return;
  currentPage = Math.min(Math.max(Number(pageNumber) || 1, 1), pdf.numPages);
  updateControls();
  renderPage();
}

function changeZoom(delta) {
  fitMode = false;
  zoom = Math.min(Math.max(Math.round((zoom + delta) * 10) / 10, 0.5), 3);
  updateControls();
  renderPage();
}

async function loadPdf() {
  if (!relativePath.toLowerCase().endsWith('.pdf')) {
    setStatus('올바른 PDF 경로가 아닙니다.', '자료 목록으로 돌아가 파일을 다시 선택해 주세요.', true);
    return;
  }

  fileNameElement.textContent = fileName;
  document.title = `${fileName} - PDF 뷰어`;
  const encodedPath = encodePath(relativePath);
  downloadLink.href = `/download/${encodedPath}`;
  backLink.href = parentPath ? `/?path=${encodeURIComponent(parentPath)}` : '/';

  try {
    const loadingTask = pdfjsLib.getDocument({
      url: `/content/${encodedPath}`,
      cMapUrl: '/vendor/pdfjs/cmaps/',
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      rangeChunkSize: 128 * 1024,
      disableAutoFetch: true,
      disableStream: true
    });
    loadingTask.onProgress = ({ loaded, total }) => {
      if (total) {
        pageSummary.textContent = `${Math.round((loaded / total) * 100)}% 불러오는 중`;
      }
    };
    pdf = await loadingTask.promise;
    updateControls();
    await renderPage();
  } catch (error) {
    console.error(error);
    setStatus('PDF를 불러오지 못했습니다.', '파일이 손상되었거나 서버 연결이 끊겼습니다.', true);
  }
}

prevButton.addEventListener('click', () => goToPage(currentPage - 1));
nextButton.addEventListener('click', () => goToPage(currentPage + 1));
pageNumberInput.addEventListener('change', () => goToPage(pageNumberInput.value));
pageNumberInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    goToPage(pageNumberInput.value);
    pageNumberInput.blur();
  }
});
zoomOutButton.addEventListener('click', () => changeZoom(-0.1));
zoomInButton.addEventListener('click', () => changeZoom(0.1));
fitWidthButton.addEventListener('click', () => {
  fitMode = true;
  updateControls();
  renderPage();
});

window.addEventListener('keydown', (event) => {
  if (document.activeElement === pageNumberInput) return;
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') goToPage(currentPage - 1);
  if (event.key === 'ArrowRight' || event.key === 'PageDown') goToPage(currentPage + 1);
});

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (fitMode) renderPage();
  }, 180);
});

loadPdf();
