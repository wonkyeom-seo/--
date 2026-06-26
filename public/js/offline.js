const entriesElement = document.querySelector('#offlineEntries');
const statusElement = document.querySelector('#offlineStatus');
const searchInput = document.querySelector('#offlineSearchInput');
const refreshButton = document.querySelector('#offlineRefreshButton');
const countElement = document.querySelector('#offlineCount');

const icons = {
  pdf: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h5M8.5 15.5h7M8.5 12h7"/></svg>',
  view: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  delete: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>'
};

let cachedEntries = [];

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
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(isoDate));
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

function openUrl(entry) {
  return `/viewer.html?path=${encodeURIComponent(entry.path)}&offline=1`;
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
    onClick();
  });
  return button;
}

function createActionLink(label, href, icon) {
  const link = document.createElement('a');
  link.className = 'action-link';
  link.href = href;
  link.title = label;
  link.setAttribute('aria-label', label);
  link.innerHTML = icon;
  link.addEventListener('click', (event) => event.stopPropagation());
  return link;
}

async function deleteEntry(entry) {
  if (!window.confirm(`"${entry.name}" 저장본을 삭제할까요?`)) return;
  await window.pwaControls.deleteCachedPdf(entry.url);
  await loadEntries();
}

function renderEntries() {
  const query = searchInput.value.trim().toLocaleLowerCase('ko');
  const visibleEntries = cachedEntries.filter((entry) => (
    !query ||
    entry.name.toLocaleLowerCase('ko').includes(query) ||
    entry.path.toLocaleLowerCase('ko').includes(query)
  ));

  countElement.textContent = `${cachedEntries.length}개 저장됨`;
  entriesElement.replaceChildren();
  hideStatus();

  if (!visibleEntries.length) {
    showStatus(cachedEntries.length ? '검색 결과가 없습니다.' : '저장된 PDF가 없습니다.', cachedEntries.length ? '다른 검색어를 입력해 보세요.' : 'PDF를 열면 오프라인 저장 목록에 추가됩니다.');
    return;
  }

  const fragment = document.createDocumentFragment();
  visibleEntries.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'entry-card';

    const main = document.createElement('button');
    main.className = 'entry-main';
    main.type = 'button';
    main.addEventListener('click', () => location.assign(openUrl(entry)));

    const icon = document.createElement('span');
    icon.className = 'entry-icon pdf';
    icon.innerHTML = icons.pdf;

    const copy = document.createElement('span');
    copy.className = 'entry-copy';

    const name = document.createElement('strong');
    name.className = 'entry-name';
    name.textContent = entry.name;

    const meta = document.createElement('span');
    meta.className = 'entry-meta';
    meta.textContent = `${entry.path} · ${formatSize(entry.size)} · ${formatDate(entry.cachedAt)}`;

    copy.append(name, meta);
    main.append(icon, copy);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    actions.append(
      createActionLink('저장본 열기', openUrl(entry), icons.view),
      createActionButton('저장본 삭제', icons.delete, () => deleteEntry(entry))
    );

    card.append(main, actions);
    fragment.append(card);
  });
  entriesElement.append(fragment);
}

async function loadEntries() {
  if (!window.pwaControls?.supported) {
    countElement.textContent = '지원 안 함';
    showStatus('오프라인 저장을 사용할 수 없습니다.', '이 브라우저는 서비스 워커를 지원하지 않습니다.');
    return;
  }

  showStatus('저장 목록을 불러오는 중입니다.');
  try {
    cachedEntries = await window.pwaControls.listCachedPdfs();
    renderEntries();
  } catch (error) {
    countElement.textContent = '불러오기 실패';
    showStatus('저장 목록을 불러오지 못했습니다.', error.message);
  }
}

searchInput.addEventListener('input', renderEntries);
refreshButton.addEventListener('click', loadEntries);

loadEntries();
