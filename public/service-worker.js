const APP_CACHE = 'app-shell-v2';
const PDF_CACHE = 'pdf-files-v1';
const API_CACHE = 'api-lists-v1';
const RUNTIME_CACHE = 'runtime-assets-v1';
const SETTINGS_CACHE = 'pwa-settings-v1';
const PDF_META_CACHE = 'pdf-metadata-v1';

const PDF_PATH_PREFIX = '/content/';
const OFFLINE_MODE_KEY = '/__pwa/offline-mode';
const PDF_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const pdfRefreshTimes = new Map();

const APP_SHELL = [
  '/',
  '/index.html',
  '/viewer.html',
  '/offline.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/viewer.js',
  '/js/pwa.js',
  '/js/offline.js',
  '/manifest.webmanifest',
  '/icons/app-icon.svg',
  '/vendor/pdfjs/build/pdf.mjs',
  '/vendor/pdfjs/build/pdf.worker.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([APP_CACHE, PDF_CACHE, API_CACHE, RUNTIME_CACHE, SETTINGS_CACHE, PDF_META_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isPdfUrl(url) {
  return isSameOrigin(url) && url.pathname.startsWith(PDF_PATH_PREFIX) && url.pathname.toLowerCase().endsWith('.pdf');
}

function isApiListUrl(url) {
  return isSameOrigin(url) && (url.pathname === '/api/browse' || url.pathname === '/api/search');
}

function isRuntimeAssetUrl(url) {
  return isSameOrigin(url) && (
    url.pathname.startsWith('/vendor/pdfjs/cmaps/') ||
    url.pathname.startsWith('/vendor/pdfjs/standard_fonts/') ||
    url.pathname.startsWith('/vendor/pdfjs/wasm/')
  );
}

function canonicalPdfUrl(urlValue) {
  const url = new URL(urlValue, self.location.origin);
  url.search = '';
  url.hash = '';
  return url;
}

function pdfCacheKey(urlValue) {
  const url = canonicalPdfUrl(urlValue);
  return new Request(url.href, { method: 'GET', credentials: 'same-origin' });
}

function apiCacheKey(request) {
  const url = new URL(request.url);
  return new Request(url.href, { method: 'GET', credentials: 'same-origin' });
}

function appShellKey(url) {
  if (url.pathname === '/') return '/';
  if (APP_SHELL.includes(url.pathname)) return url.pathname;
  return null;
}

function metaKey(urlValue) {
  const url = canonicalPdfUrl(urlValue);
  return new Request(`/__pwa/pdf-meta?url=${encodeURIComponent(url.href)}`, { method: 'GET' });
}

function decodePdfPath(urlValue) {
  const url = canonicalPdfUrl(urlValue);
  const relative = url.pathname.slice(PDF_PATH_PREFIX.length);
  return relative.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
}

function pdfName(pathValue) {
  return pathValue.split('/').at(-1) || pathValue;
}

async function getOfflineMode() {
  const cache = await caches.open(SETTINGS_CACHE);
  const response = await cache.match(OFFLINE_MODE_KEY);
  if (!response) return true;
  const body = await response.json().catch(() => ({ enabled: true }));
  return body.enabled !== false;
}

async function setOfflineMode(enabled) {
  const cache = await caches.open(SETTINGS_CACHE);
  await cache.put(OFFLINE_MODE_KEY, new Response(JSON.stringify({ enabled: Boolean(enabled) }), {
    headers: { 'Content-Type': 'application/json' }
  }));
  return Boolean(enabled);
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function rangeResponse(response, rangeHeader) {
  const blob = await response.blob();
  const range = parseRange(rangeHeader, blob.size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${blob.size}` }
    });
  }

  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(range.end - range.start + 1));
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${blob.size}`);
  return new Response(blob.slice(range.start, range.end + 1, 'application/pdf'), {
    status: 206,
    statusText: 'Partial Content',
    headers
  });
}

async function responseForPdfRequest(request, response) {
  const rangeHeader = request.headers.get('range');
  return rangeHeader ? rangeResponse(response, rangeHeader) : response;
}

async function writePdfMeta(key, response) {
  const url = canonicalPdfUrl(key.url);
  const path = decodePdfPath(url.href);
  const blob = await response.clone().blob();
  const meta = {
    url: url.href,
    path,
    name: pdfName(path),
    size: blob.size,
    cachedAt: new Date().toISOString()
  };
  const cache = await caches.open(PDF_META_CACHE);
  await cache.put(metaKey(url.href), new Response(JSON.stringify(meta), {
    headers: { 'Content-Type': 'application/json' }
  }));
  return meta;
}

async function readPdfMeta(urlValue) {
  const cache = await caches.open(PDF_META_CACHE);
  const response = await cache.match(metaKey(urlValue));
  if (!response) return null;
  return response.json().catch(() => null);
}

async function cachePdf(urlValue, options = {}) {
  const enabled = await getOfflineMode();
  if (!enabled && !options.allowWhenDisabled) return { cached: false };

  const url = canonicalPdfUrl(urlValue);
  if (!isPdfUrl(url)) return { cached: false };

  const cache = await caches.open(PDF_CACHE);
  const key = pdfCacheKey(url);
  const cached = await cache.match(key);
  if (cached && !options.refresh) {
    const entry = await readPdfMeta(url.href) || await writePdfMeta(key, cached);
    return { cached: true, entry };
  }

  const response = await fetch(key, { cache: 'no-store' });
  if (response.ok && response.headers.get('content-type')?.includes('application/pdf')) {
    await cache.put(key, response.clone());
    const entry = await writePdfMeta(key, response);
    return { cached: true, entry };
  }
  return { cached: false };
}

async function updatePdfInBackground(key) {
  try {
    await cachePdf(key.url, { refresh: true });
  } catch {
    // Network refresh is best effort; the stored copy remains usable.
  }
}

async function updatePdfInBackgroundIfDue(key) {
  const now = Date.now();
  const lastRefresh = pdfRefreshTimes.get(key.url) || 0;
  if (now - lastRefresh < PDF_REFRESH_INTERVAL_MS) return;
  pdfRefreshTimes.set(key.url, now);
  await updatePdfInBackground(key);
}

async function pdfCacheEntry(urlValue) {
  const url = canonicalPdfUrl(urlValue);
  if (!isPdfUrl(url)) return null;

  const cache = await caches.open(PDF_CACHE);
  const key = pdfCacheKey(url);
  const response = await cache.match(key);
  if (!response) return null;
  const entry = await readPdfMeta(url.href) || await writePdfMeta(key, response.clone());
  return { key, response, entry };
}

async function servePdf(request, event) {
  const url = new URL(request.url);
  if (!isPdfUrl(url)) return fetch(request);

  const offlineMode = await getOfflineMode();
  const cacheOnly = url.searchParams.get('offline') === '1';
  const cached = await pdfCacheEntry(url.href);

  if (cached && (offlineMode || cacheOnly)) {
    if (offlineMode && !cacheOnly) event.waitUntil(updatePdfInBackgroundIfDue(cached.key));
    return responseForPdfRequest(request, cached.response);
  }

  return fetch(request);
}

async function listCachedPdfs() {
  const cache = await caches.open(PDF_CACHE);
  const keys = await cache.keys();
  const entries = await Promise.all(keys.map(async (key) => {
    const response = await cache.match(key);
    const entry = await readPdfMeta(key.url) || await writePdfMeta(key, response.clone());
    return entry;
  }));
  return entries.sort((a, b) => b.cachedAt.localeCompare(a.cachedAt));
}

async function deleteCachedPdf(urlValue) {
  const url = canonicalPdfUrl(urlValue);
  const cache = await caches.open(PDF_CACHE);
  const meta = await caches.open(PDF_META_CACHE);
  const deleted = await cache.delete(pdfCacheKey(url));
  await meta.delete(metaKey(url.href));
  return deleted;
}

async function appShellResponse(request) {
  const url = new URL(request.url);
  const key = appShellKey(url);
  const cache = await caches.open(APP_CACHE);

  if (request.mode === 'navigate') {
    try {
      const response = await fetch(request);
      if (response.ok && key) await cache.put(key, response.clone());
      return response;
    } catch {
      if (key) {
        const cached = await cache.match(key);
        if (cached) return cached;
      }
      return cache.match('/index.html');
    }
  }

  if (!key) return fetch(request);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(key, response.clone());
  return response;
}

async function runtimeAssetResponse(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

function cachedSearchResponse(query) {
  return listCachedPdfs().then((entries) => {
    const needle = query.trim().toLocaleLowerCase('ko');
    const filtered = entries
      .filter((entry) => !needle || entry.path.toLocaleLowerCase('ko').includes(needle) || entry.name.toLocaleLowerCase('ko').includes(needle))
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: 'file',
        size: entry.size,
        modifiedAt: entry.cachedAt,
        extension: 'pdf',
        viewable: true
      }));
    return new Response(JSON.stringify({ query, limit: filtered.length, entries: filtered }), {
      headers: { 'Content-Type': 'application/json' }
    });
  });
}

async function apiListResponse(request) {
  const offlineMode = await getOfflineMode();
  const key = apiCacheKey(request);

  try {
    const response = await fetch(request);
    if (response.ok && offlineMode) {
      const cache = await caches.open(API_CACHE);
      await cache.put(key, response.clone());
    }
    return response;
  } catch (error) {
    if (!offlineMode) throw error;
    const url = new URL(request.url);
    if (url.pathname === '/api/search') return cachedSearchResponse(url.searchParams.get('q') || '');

    const cache = await caches.open(API_CACHE);
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (!isSameOrigin(url)) return;

  if (isPdfUrl(url)) {
    event.respondWith(servePdf(event.request, event));
    return;
  }

  if (isApiListUrl(url)) {
    event.respondWith(apiListResponse(event.request));
    return;
  }

  if (isRuntimeAssetUrl(url)) {
    event.respondWith(runtimeAssetResponse(event.request));
    return;
  }

  if (event.request.mode === 'navigate' || appShellKey(url)) {
    event.respondWith(appShellResponse(event.request));
  }
});

function postResult(event, type, payload) {
  event.source?.postMessage({ id: event.data?.id, type: `${type}_RESULT`, ...payload });
}

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (!type) return;

  event.waitUntil((async () => {
    try {
      if (type === 'GET_OFFLINE_MODE') {
        postResult(event, type, { enabled: await getOfflineMode() });
      } else if (type === 'SET_OFFLINE_MODE') {
        postResult(event, type, { enabled: await setOfflineMode(event.data.enabled) });
      } else if (type === 'CACHE_PDF') {
        const result = await cachePdf(event.data.url);
        postResult(event, type, result);
        if (result.cached) event.source?.postMessage({ type: 'PDF_CACHED', url: result.entry.url, entry: result.entry });
      } else if (type === 'IS_PDF_CACHED') {
        const cached = await pdfCacheEntry(event.data.url);
        postResult(event, type, { cached: Boolean(cached), entry: cached?.entry || null });
      } else if (type === 'LIST_CACHED_PDFS') {
        postResult(event, type, { entries: await listCachedPdfs() });
      } else if (type === 'DELETE_CACHED_PDF') {
        postResult(event, type, { deleted: await deleteCachedPdf(event.data.url), url: event.data.url });
      }
    } catch (error) {
      postResult(event, type, { error: error.message || 'PWA 작업을 처리하지 못했습니다.' });
    }
  })());
});
