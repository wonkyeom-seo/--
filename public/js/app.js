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
  download: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/></svg>',
  offline: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/></svg>',
  lock: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z"/></svg>'
};

let currentPath = new URLSearchParams(location.search).get('path') || '';
let searchTimer;
let requestVersion = 0;
const unlockedFolderPrefix = 'exam-data-library:unlocked:';
const lockerPasswordCache = new Map();

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

function lockerKey(folderPath) {
  return `${unlockedFolderPrefix}${folderPath}`;
}

function isFolderUnlocked(folderPath) {
  return sessionStorage.getItem(lockerKey(folderPath)) === '1';
}

function markFolderUnlocked(folderPath) {
  sessionStorage.setItem(lockerKey(folderPath), '1');
}

function lockerUrl(folderPath) {
  return folderPath ? `/content/${encodePath(folderPath)}/.locker` : '/content/.locker';
}

async function readLockerPassword(folderPath) {
  if (lockerPasswordCache.has(folderPath)) return lockerPasswordCache.get(folderPath);

  const response = await fetch(lockerUrl(folderPath), { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('잠금 정보를 읽지 못했습니다.');

  const password = (await response.text()).trim();
  lockerPasswordCache.set(folderPath, password);
  return password;
}

function folderDisplayName(folderPath) {
  return folderPath ? folderPath.split('/').at(-1) : '전체 자료';
}

function folderCandidates(pathValue) {
  const segments = pathValue ? pathValue.split('/').filter(Boolean) : [];
  const candidates = [''];
  let accumulated = '';
  segments.forEach((segment) => {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    candidates.push(accumulated);
  });
  return candidates;
}

async function findLockedFolder(pathValue) {
  for (const folderPath of folderCandidates(pathValue)) {
    if (isFolderUnlocked(folderPath)) continue;
    const password = await readLockerPassword(folderPath);
    if (password !== null) return { path: folderPath, password };
  }
  return null;
}

function promptForLocker(folderPath, password) {
  const folderName = folderDisplayName(folderPath);

  while (true) {
    const input = window.prompt(`"${folderName}" 폴더 비밀번호를 입력하세요.`);
    if (input === null) return false;
    if (input.trim() === password) {
      markFolderUnlocked(folderPath);
      return true;
    }
    window.alert('비밀번호가 맞지 않습니다.');
  }
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

function createActionButton(label, icon, onClick) {
  const button = document.createElement('button');
  button.className = 'action-button';
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick(button);
  });
  return button;
}

function createLockBadge(label) {
  const badge = document.createElement('span');
  badge.className = 'lock-badge';
  badge.title = label;
  badge.setAttribute('aria-label', label);
  badge.innerHTML = icons.lock;
  return badge;
}

async function ensureFolderUnlocked(folderPath) {
  const lockedFolder = await findLockedFolder(folderPath);
  return !lockedFolder || promptForLocker(lockedFolder.path, lockedFolder.password);
}

async function collectFolderPdfs(folderPath, pdfs) {
  const data = await fetchJson(`/api/browse?path=${encodeURIComponent(folderPath)}`);

  for (const entry of data.entries) {
    if (entry.type === 'file' && entry.viewable) {
      pdfs.push(entry);
    } else if (entry.type === 'directory') {
      if (await ensureFolderUnlocked(entry.path)) {
        await collectFolderPdfs(entry.path, pdfs);
      }
    }
  }
}

function setOfflineFolderButtonState(button, state, title) {
  button.dataset.state = state;
  button.disabled = state === 'saving';
  button.title = title;
  button.setAttribute('aria-label', title);
}

async function saveFolderOffline(folderPath, button) {
  if (!window.pwaControls?.supported) {
    window.alert('이 브라우저는 오프라인 저장을 지원하지 않습니다.');
    return;
  }

  const offlineMode = await window.pwaControls.getOfflineMode();
  if (!offlineMode) {
    window.alert('오프라인 모드를 켠 뒤 저장할 수 있습니다.');
    return;
  }

  setOfflineFolderButtonState(button, 'saving', '폴더 PDF를 오프라인 저장 중입니다.');
  try {
    if (!await ensureFolderUnlocked(folderPath)) return;

    const pdfs = [];
    await collectFolderPdfs(folderPath, pdfs);
    if (!pdfs.length) {
      window.alert('이 폴더 안에 저장할 PDF가 없습니다.');
      return;
    }

    let saved = 0;
    for (const pdf of pdfs) {
      const result = await window.pwaControls.cachePdf(`/content/${encodePath(pdf.path)}`);
      if (result.cached) saved += 1;
      setOfflineFolderButtonState(button, 'saving', `${saved} / ${pdfs.length}개 저장 중`);
    }

    window.alert(`${saved}개 PDF를 오프라인 저장했습니다.`);
  } catch (error) {
    window.alert(error.message || '폴더를 오프라인 저장하지 못했습니다.');
  } finally {
    setOfflineFolderButtonState(button, 'idle', '이 폴더 PDF 오프라인 저장');
  }
}

function isVisibleInSearch(entry) {
  return entry.lockedBy === undefined || isFolderUnlocked(entry.lockedBy);
}

function renderEntries(entries, searchMode = false) {
  entriesElement.replaceChildren();
  hideStatus();

  const visibleEntries = entries.filter((entry) => entry.name !== '.locker' && (!searchMode || isVisibleInSearch(entry)));

  if (!visibleEntries.length) {
    showStatus(searchMode ? '검색 결과가 없습니다.' : '이 폴더는 비어 있습니다.', searchMode ? '다른 검색어를 입력해 보세요.' : 'data 폴더에 자료를 추가하면 바로 표시됩니다.');
    return;
  }

  const fragment = document.createDocumentFragment();
  visibleEntries.forEach((entry) => {
    const card = entryTemplate.content.firstElementChild.cloneNode(true);
    const main = card.querySelector('.entry-main');
    const icon = card.querySelector('.entry-icon');
    const name = card.querySelector('.entry-name');
    const meta = card.querySelector('.entry-meta');
    const actions = card.querySelector('.entry-actions');
    const locked = entry.type === 'directory' && entry.locked && !isFolderUnlocked(entry.path);

    name.textContent = entry.name;
    icon.classList.add(entry.type === 'directory' ? 'folder' : entry.viewable ? 'pdf' : 'file');
    icon.innerHTML = icons[entry.type === 'directory' ? 'folder' : entry.viewable ? 'pdf' : 'file'];

    if (entry.type === 'directory') {
      card.classList.add('folder-card');
      if (locked) card.classList.add('locked-folder');
      meta.textContent = searchMode
        ? `${entry.path}${locked ? ' · 잠김' : ''}`
        : `${locked ? '잠김 폴더' : '폴더'} · ${formatDate(entry.modifiedAt)}`;
      if (searchMode) meta.classList.add('search-path');
      if (locked) actions.append(createLockBadge('잠긴 폴더'));
      actions.append(createActionButton('이 폴더 PDF 오프라인 저장', icons.offline, (button) => saveFolderOffline(entry.path, button)));
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
  searchInput.value = '';
  buildBreadcrumbs(pathValue);
  showStatus('잠금 확인 중입니다.');

  try {
    const lockedFolder = await findLockedFolder(pathValue);
    if (version !== requestVersion) return;
    if (lockedFolder && !promptForLocker(lockedFolder.path, lockedFolder.password)) {
      showStatus('잠긴 폴더입니다.', '비밀번호를 입력하면 열 수 있습니다.');
      return;
    }

    currentPath = pathValue;
    buildBreadcrumbs(currentPath);
    showStatus('자료를 불러오는 중입니다.');

    if (updateHistory) {
      const url = currentPath ? `/?path=${encodeURIComponent(currentPath)}` : '/';
      history.pushState({ path: currentPath }, '', url);
    }

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
