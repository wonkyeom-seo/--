import * as pdfjsLib from '/vendor/pdfjs/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

const params = new URLSearchParams(location.search);
const relativePath = params.get('path') || '';
const fileName = relativePath.split('/').at(-1) || 'PDF';
const parentPath = relativePath.split('/').slice(0, -1).join('/');

const stage = document.querySelector('#viewerStage');
const status = document.querySelector('#viewerStatus');
const pagesElement = document.querySelector('#pdfPages');
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
const continuousViewButton = document.querySelector('#continuousView');
const spreadViewButton = document.querySelector('#spreadView');
const printButton = document.querySelector('#printButton');
const downloadLink = document.querySelector('#downloadLink');
const backLink = document.querySelector('#backLink');
const fileTreeToggle = document.querySelector('#fileTreeToggle');
const fileTreePanel = document.querySelector('#fileTreePanel');
const fileTreeClose = document.querySelector('#fileTreeClose');
const fileTreeBackdrop = document.querySelector('#fileTreeBackdrop');
const fileTreeElement = document.querySelector('#fileTree');
const fileTreeSearch = document.querySelector('#fileTreeSearch');

let pdf;
let currentPage = 1;
let zoom = 1;
let fitMode = true;
let viewMode = 'single';
let resizeTimer;
let scrollFrame;
let renderGeneration = 0;
let pageObserver;
let defaultPageRatio = 1.414;
let loadingFinished = false;
let printUrl = '';
let treeLoaded = false;
let treeSearchTimer;
const renderTasks = new Set();
const directoryNodes = new Map();

const treeIcons = {
  chevron: '<svg class="tree-chevron" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  folder: '<svg class="tree-entry-icon folder" aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6.5h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11Z"/></svg>',
  file: '<svg class="tree-entry-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h5"/></svg>'
};

function encodePath(pathValue) {
  return pathValue.split('/').map(encodeURIComponent).join('/');
}

function setStatus(title, detail = '', isError = false) {
  status.classList.remove('hidden');
  status.innerHTML = `${isError ? '' : '<span class="spinner"></span>'}<strong>${title}</strong><small>${detail}</small>`;
  pagesElement.classList.remove('visible');
}

function hideStatus() {
  status.classList.add('hidden');
  pagesElement.classList.add('visible');
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '파일 목록을 불러오지 못했습니다.');
  return body;
}

function createTreeRow(entry, depth) {
  const item = document.createElement('div');
  item.className = 'tree-item';
  item.setAttribute('role', 'treeitem');

  const row = document.createElement(entry.type === 'directory' ? 'button' : 'a');
  row.className = 'tree-row';
  row.style.setProperty('--tree-depth', depth);
  row.dataset.path = entry.path;
  row.title = entry.name;

  if (entry.type === 'directory') {
    row.type = 'button';
    row.setAttribute('aria-expanded', 'false');
    row.innerHTML = `${treeIcons.chevron}${treeIcons.folder}<span>${entry.name}</span>`;
    const children = document.createElement('div');
    children.className = 'tree-children';
    children.setAttribute('role', 'group');
    item.append(row, children);
    directoryNodes.set(entry.path, { row, children, loaded: false });
    row.addEventListener('click', () => toggleDirectory(entry.path));
  } else {
    row.innerHTML = `<span class="tree-chevron-spacer"></span>${treeIcons.file}<span>${entry.name}</span>`;
    if (entry.path === relativePath) {
      row.classList.add('active');
      row.setAttribute('aria-current', 'page');
    }
    if (entry.viewable) {
      row.href = `/viewer.html?path=${encodeURIComponent(entry.path)}`;
    } else {
      row.href = `/download/${encodePath(entry.path)}`;
      row.setAttribute('download', '');
    }
    item.append(row);
  }

  return item;
}

async function loadDirectoryTree(pathValue, container, depth) {
  container.innerHTML = '<div class="tree-loading">불러오는 중...</div>';
  try {
    const data = await fetchJson(`/api/browse?path=${encodeURIComponent(pathValue)}`);
    container.replaceChildren(...data.entries.map((entry) => createTreeRow(entry, depth)));
  } catch (error) {
    container.innerHTML = `<div class="tree-loading">${error.message}</div>`;
  }
}

async function openDirectory(pathValue) {
  const node = directoryNodes.get(pathValue);
  if (!node) return;
  if (!node.loaded) {
    await loadDirectoryTree(pathValue, node.children, pathValue.split('/').length);
    node.loaded = true;
  }
  node.row.setAttribute('aria-expanded', 'true');
  node.row.classList.add('expanded');
  node.children.classList.add('open');
}

async function toggleDirectory(pathValue) {
  const node = directoryNodes.get(pathValue);
  if (!node) return;
  if (node.row.getAttribute('aria-expanded') === 'true') {
    node.row.setAttribute('aria-expanded', 'false');
    node.row.classList.remove('expanded');
    node.children.classList.remove('open');
    return;
  }
  await openDirectory(pathValue);
}

async function revealCurrentFile() {
  const folders = relativePath.split('/').slice(0, -1);
  let accumulated = '';
  for (const folder of folders) {
    accumulated = accumulated ? `${accumulated}/${folder}` : folder;
    await openDirectory(accumulated);
  }
  requestAnimationFrame(() => {
    fileTreeElement.querySelector('.tree-row.active')?.scrollIntoView({ block: 'center' });
  });
}

async function loadTree() {
  if (treeLoaded) return;
  treeLoaded = true;
  await loadDirectoryTree('', fileTreeElement, 0);
  await revealCurrentFile();
}

async function searchTree(query) {
  const trimmed = query.trim();
  directoryNodes.clear();
  if (!trimmed) {
    treeLoaded = false;
    await loadTree();
    return;
  }

  fileTreeElement.innerHTML = '<div class="tree-loading">검색 중...</div>';
  try {
    const data = await fetchJson(`/api/search?q=${encodeURIComponent(trimmed)}`);
    const results = data.entries.filter((entry) => entry.type === 'directory' || entry.viewable);
    fileTreeElement.replaceChildren(...results.map((entry) => createTreeRow(entry, 0)));
    if (!results.length) fileTreeElement.innerHTML = '<div class="tree-loading">검색 결과 없음</div>';
  } catch (error) {
    fileTreeElement.innerHTML = `<div class="tree-loading">${error.message}</div>`;
  }
}

function setTreeOpen(open) {
  fileTreePanel.classList.toggle('open', open);
  fileTreeBackdrop.classList.toggle('open', open);
  fileTreePanel.setAttribute('aria-hidden', String(!open));
  fileTreeToggle.setAttribute('aria-expanded', String(open));
  fileTreeToggle.setAttribute('aria-label', open ? '파일 목록 닫기' : '파일 목록 열기');
  if (open) loadTree();
}

function updateControls() {
  const pageStep = viewMode === 'spread' ? 2 : 1;
  pageNumberInput.value = currentPage;
  pageNumberInput.max = pdf?.numPages || 1;
  pageCountElement.textContent = pdf?.numPages || '-';
  prevButton.disabled = !pdf || currentPage <= 1;
  nextButton.disabled = !pdf || currentPage + pageStep > pdf.numPages;
  zoomOutButton.disabled = zoom <= 0.5;
  zoomInButton.disabled = zoom >= 3;
  zoomValue.textContent = fitMode ? '맞춤' : `${Math.round(zoom * 100)}%`;
  continuousViewButton.setAttribute('aria-pressed', String(viewMode === 'continuous'));
  spreadViewButton.setAttribute('aria-pressed', String(viewMode === 'spread'));
  pageSummary.textContent = pdf ? `${currentPage} / ${pdf.numPages} 페이지` : 'PDF 불러오는 중';
}

function cancelRenders() {
  renderGeneration += 1;
  pageObserver?.disconnect();
  pageObserver = null;
  for (const task of renderTasks) task.cancel();
  renderTasks.clear();
}

function getPageWidth() {
  const stagePadding = innerWidth <= 620 ? 10 : 44;
  const availableWidth = Math.max(stage.clientWidth - stagePadding, 240);
  if (viewMode === 'spread') return Math.max((availableWidth - 12) / 2, 150);
  return availableWidth;
}

function createPageShell(pageNumber, width = getPageWidth()) {
  const shell = document.createElement('div');
  shell.className = 'pdf-page-shell';
  shell.dataset.pageNumber = pageNumber;
  shell.style.width = `${Math.round(width)}px`;
  shell.style.minHeight = `${Math.round(width * defaultPageRatio)}px`;

  const canvas = document.createElement('canvas');
  canvas.width = 0;
  canvas.height = 0;
  canvas.setAttribute('aria-label', `${pageNumber} 페이지`);
  shell.append(canvas);
  return shell;
}

function getOutputScale(displayViewport) {
  const preferredScale = viewMode === 'continuous'
    ? Math.max(window.devicePixelRatio || 1, 1.5)
    : Math.max(window.devicePixelRatio || 1, 2);
  const maxPixels = viewMode === 'continuous' ? 12_000_000 : 20_000_000;
  const maxDimension = 8192;
  const pixelScale = Math.sqrt(maxPixels / (displayViewport.width * displayViewport.height));
  const dimensionScale = Math.min(maxDimension / displayViewport.width, maxDimension / displayViewport.height);
  return Math.max(Math.min(preferredScale, pixelScale, dimensionScale), 1);
}

async function renderPageIntoShell(shell, generation) {
  if (shell.dataset.rendered === 'true' || shell.dataset.rendering === 'true' || generation !== renderGeneration) return;
  shell.dataset.rendering = 'true';
  let task;

  try {
    const page = await pdf.getPage(Number(shell.dataset.pageNumber));
    if (generation !== renderGeneration) return;

    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = fitMode ? getPageWidth() : baseViewport.width * zoom;
    const displayScale = targetWidth / baseViewport.width;
    const displayViewport = page.getViewport({ scale: displayScale });
    const outputScale = getOutputScale(displayViewport);
    const viewport = page.getViewport({ scale: displayScale * outputScale });
    const canvas = shell.querySelector('canvas');
    const context = canvas.getContext('2d', { alpha: false });

    shell.style.width = `${Math.floor(displayViewport.width)}px`;
    shell.style.minHeight = `${Math.floor(displayViewport.height)}px`;
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(displayViewport.width)}px`;
    canvas.style.height = `${Math.floor(displayViewport.height)}px`;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    task = page.render({ canvasContext: context, viewport });
    renderTasks.add(task);
    await task.promise;
    if (generation === renderGeneration) shell.dataset.rendered = 'true';
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') {
      console.error(error);
      shell.innerHTML = '<div class="pdf-page-error">페이지를 표시하지 못했습니다.</div>';
    }
  } finally {
    if (task) renderTasks.delete(task);
    delete shell.dataset.rendering;
  }
}

async function renderSingleOrSpread(generation) {
  pagesElement.className = `pdf-pages ${viewMode}`;
  const pageNumbers = [currentPage];
  if (viewMode === 'spread' && currentPage < pdf.numPages) pageNumbers.push(currentPage + 1);
  const shells = pageNumbers.map((pageNumber) => createPageShell(pageNumber));
  pagesElement.replaceChildren(...shells);
  await Promise.all(shells.map((shell) => renderPageIntoShell(shell, generation)));
  if (generation !== renderGeneration) return;
  hideStatus();
  stage.scrollTo({ top: 0, left: 0, behavior: 'instant' });
}

function renderContinuous(generation) {
  pagesElement.className = 'pdf-pages continuous';
  const width = getPageWidth();
  const fragment = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    fragment.append(createPageShell(pageNumber, width));
  }
  pagesElement.replaceChildren(fragment);
  hideStatus();

  pageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) renderPageIntoShell(entry.target, generation);
      });
    },
    { root: stage, rootMargin: '500px 0px', threshold: 0.01 }
  );
  pagesElement.querySelectorAll('.pdf-page-shell').forEach((shell) => pageObserver.observe(shell));

  requestAnimationFrame(() => {
    pagesElement.querySelector(`[data-page-number="${currentPage}"]`)?.scrollIntoView({ block: 'start' });
  });
}

async function renderDocument() {
  if (!pdf) return;
  cancelRenders();
  const generation = renderGeneration;
  setStatus('페이지를 표시하는 중입니다.');
  updateControls();
  if (viewMode === 'continuous') renderContinuous(generation);
  else await renderSingleOrSpread(generation);
}

function goToPage(pageNumber) {
  if (!pdf) return;
  currentPage = Math.min(Math.max(Number(pageNumber) || 1, 1), pdf.numPages);
  updateControls();
  if (viewMode === 'continuous') {
    pagesElement.querySelector(`[data-page-number="${currentPage}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } else {
    renderDocument();
  }
}

function changeZoom(delta) {
  fitMode = false;
  zoom = Math.min(Math.max(Math.round((zoom + delta) * 10) / 10, 0.5), 3);
  renderDocument();
}

function toggleViewMode(mode) {
  viewMode = viewMode === mode ? 'single' : mode;
  renderDocument();
}

function updateContinuousPage() {
  if (viewMode !== 'continuous') return;
  const stageTop = stage.getBoundingClientRect().top;
  let closestPage = currentPage;
  let closestDistance = Infinity;
  pagesElement.querySelectorAll('.pdf-page-shell').forEach((shell) => {
    const distance = Math.abs(shell.getBoundingClientRect().top - stageTop - 8);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestPage = Number(shell.dataset.pageNumber);
    }
  });
  if (closestPage !== currentPage) {
    currentPage = closestPage;
    updateControls();
  }
}

async function loadPdf() {
  if (!relativePath.toLowerCase().endsWith('.pdf')) {
    setStatus('올바른 PDF 경로가 아닙니다.', '자료 목록으로 돌아가 파일을 다시 선택해 주세요.', true);
    return;
  }

  fileNameElement.textContent = fileName;
  document.title = `${fileName} - PDF 뷰어`;
  const encodedPath = encodePath(relativePath);
  printUrl = `/content/${encodedPath}`;
  printButton.disabled = false;
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
      if (!loadingFinished && total) pageSummary.textContent = `${Math.round((loaded / total) * 100)}% 불러오는 중`;
    };
    pdf = await loadingTask.promise;
    loadingFinished = true;
    const firstPage = await pdf.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    defaultPageRatio = firstViewport.height / firstViewport.width;
    await renderDocument();
  } catch (error) {
    console.error(error);
    setStatus('PDF를 불러오지 못했습니다.', '파일이 손상되었거나 서버 연결이 끊겼습니다.', true);
  }
}

prevButton.addEventListener('click', () => goToPage(currentPage - (viewMode === 'spread' ? 2 : 1)));
nextButton.addEventListener('click', () => goToPage(currentPage + (viewMode === 'spread' ? 2 : 1)));
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
  renderDocument();
});
continuousViewButton.addEventListener('click', () => toggleViewMode('continuous'));
spreadViewButton.addEventListener('click', () => toggleViewMode('spread'));
printButton.addEventListener('click', () => {
  if (!printUrl) return;
  const printWindow = window.open(printUrl, '_blank');
  if (!printWindow) return;

  const requestPrint = () => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch {
      // Some mobile browsers only allow printing from their PDF viewer menu.
    }
  };
  printWindow.addEventListener('load', () => setTimeout(requestPrint, 700), { once: true });
  setTimeout(requestPrint, 1800);
});
fileTreeToggle.addEventListener('click', () => setTreeOpen(!fileTreePanel.classList.contains('open')));
fileTreeClose.addEventListener('click', () => setTreeOpen(false));
fileTreeBackdrop.addEventListener('click', () => setTreeOpen(false));
fileTreeSearch.addEventListener('input', () => {
  clearTimeout(treeSearchTimer);
  treeSearchTimer = setTimeout(() => searchTree(fileTreeSearch.value), 250);
});

stage.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    updateContinuousPage();
  });
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && fileTreePanel.classList.contains('open')) {
    setTreeOpen(false);
    return;
  }
  if (document.activeElement === pageNumberInput || document.activeElement === fileTreeSearch) return;
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') goToPage(currentPage - (viewMode === 'spread' ? 2 : 1));
  if (event.key === 'ArrowRight' || event.key === 'PageDown') goToPage(currentPage + (viewMode === 'spread' ? 2 : 1));
});

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (fitMode) renderDocument();
  }, 180);
});

loadPdf();
