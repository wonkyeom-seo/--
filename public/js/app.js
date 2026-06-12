const entriesElement = document.querySelector('#entries');
const statusElement = document.querySelector('#status');
const breadcrumbsElement = document.querySelector('#breadcrumbs');
const searchInput = document.querySelector('#searchInput');
const refreshButton = document.querySelector('#refreshButton');
const entryTemplate = document.querySelector('#entryTemplate');

const icons = {
  folder: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6.5h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11Z"/></svg>',
  pdf: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h5M8.5 15.5h7M8.5 12h7"/></svg>',
  file: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h5"/></svg>',
  view: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  download: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/></svg>'
};

let currentPath = new URLSearchParams(location.search).get('path') || '';
let searchTimer;
let requestVersion = 0;

function encodePath(relativePath) {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(new Date(isoDate));
}

function showStatus(title, detail = '') {
  entriesElement.replaceChildren();
  statusElement.classList.add('visible');
  statusElement.innerHTML = `<strong>${title}</strong><small>${detail}</small>`;
}

function hideStatus() {
  statusElement.classList.remove('visible');
  statusElement.replaceChildren();
}

function buildBreadcrumbs(pathValue) {
  breadcrumbsElement.replaceChildren();
  const segments = pathValue ? pathValue.split('/') : [];
  const parts = [{ name: '전체 자료', path: '' }];
  segments.forEach((name, index) => {
    parts.push({ name, path: segments.slice(0, index + 1).join('/') });
  });

  parts.forEach((part, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'crumb-separator';
      separator.textContent = '/';
      breadcrumbsElement.append(separator);
    }
    const button = document.createElement('button');
    button.className = 'crumb';
    button.type = 'button';
    button.textContent = part.name;
    button.addEventListener('click', () => navigateTo(part.path));
    breadcrumbsElement.append(button);
  });

  requestAnimationFrame(() => {
    breadcrumbsElement.scrollLeft = breadcrumbsElement.scrollWidth;
  });
}

function createActionLink(label, href, icon, download = false) {
  const link = document.createElement('a');
  link.className = 'action-link';
  link.href = href;
  link.title = label;
  link.setAttribute('aria-label', label);
  if (download) link.setAttribute('download', '');
  link.innerHTML = icon;
  link.addEventListener('click', (event) => event.stopPropagation());
  return link;
}

function renderEntries(entries, searchMode = false) {
  entriesElement.replaceChildren();
  hideStatus();

  if (!entries.length) {
    showStatus(searchMode ? '검색 결과가 없습니다.' : '이 폴더는 비어 있습니다.', searchMode ? '다른 검색어를 입력해 보세요.' : 'data 폴더에 자료를 추가하면 바로 표시됩니다.');
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.forEach((entry) => {
    const card = entryTemplate.content.firstElementChild.cloneNode(true);
    const main = card.querySelector('.entry-main');
    const icon = card.querySelector('.entry-icon');
    const name = card.querySelector('.entry-name');
    const meta = card.querySelector('.entry-meta');
    const actions = card.querySelector('.entry-actions');

    name.textContent = entry.name;
    icon.classList.add(entry.type === 'directory' ? 'folder' : entry.viewable ? 'pdf' : 'file');
    icon.innerHTML = icons[entry.type === 'directory' ? 'folder' : entry.viewable ? 'pdf' : 'file'];

    if (entry.type === 'directory') {
      card.classList.add('folder-card');
      meta.textContent = searchMode ? entry.path : `폴더 · ${formatDate(entry.modifiedAt)}`;
      if (searchMode) meta.classList.add('search-path');
      main.addEventListener('click', () => navigateTo(entry.path));
    } else {
      meta.textContent = searchMode ? `${entry.path} · ${formatSize(entry.size)}` : `${formatSize(entry.size)} · ${formatDate(entry.modifiedAt)}`;
      if (searchMode) meta.classList.add('search-path');
      const encodedPath = encodePath(entry.path);
      if (entry.viewable) {
        const viewerUrl = `/viewer.html?path=${encodeURIComponent(entry.path)}`;
        main.addEventListener('click', () => location.assign(viewerUrl));
        actions.append(createActionLink('PDF 보기', viewerUrl, icons.view));
      } else {
        main.addEventListener('click', () => location.assign(`/download/${encodedPath}`));
      }
      actions.append(createActionLink('다운로드', `/download/${encodedPath}`, icons.download, true));
    }
    fragment.append(card);
  });
  entriesElement.append(fragment);
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '자료를 불러오지 못했습니다.');
  return body;
}

async function loadDirectory(pathValue, updateHistory = false) {
  const version = ++requestVersion;
  currentPath = pathValue;
  searchInput.value = '';
  buildBreadcrumbs(currentPath);
  showStatus('자료를 불러오는 중입니다.');

  if (updateHistory) {
    const url = currentPath ? `/?path=${encodeURIComponent(currentPath)}` : '/';
    history.pushState({ path: currentPath }, '', url);
  }

  try {
    const data = await fetchJson(`/api/browse?path=${encodeURIComponent(currentPath)}`);
    if (version === requestVersion) renderEntries(data.entries);
  } catch (error) {
    if (version === requestVersion) showStatus('자료를 불러오지 못했습니다.', error.message);
  }
}

function navigateTo(pathValue) {
  loadDirectory(pathValue, true);
}

async function search(query) {
  const version = ++requestVersion;
  const trimmed = query.trim();
  if (!trimmed) {
    loadDirectory(currentPath);
    return;
  }

  breadcrumbsElement.innerHTML = '<span class="crumb">전체 자료 검색</span>';
  showStatus('검색 중입니다.');
  try {
    const data = await fetchJson(`/api/search?q=${encodeURIComponent(trimmed)}`);
    if (version === requestVersion) renderEntries(data.entries, true);
  } catch (error) {
    if (version === requestVersion) showStatus('검색하지 못했습니다.', error.message);
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(searchInput.value), 250);
});

refreshButton.addEventListener('click', () => {
  if (searchInput.value.trim()) search(searchInput.value);
  else loadDirectory(currentPath);
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  }
});

window.addEventListener('popstate', () => {
  currentPath = new URLSearchParams(location.search).get('path') || '';
  loadDirectory(currentPath);
});

loadDirectory(currentPath);
