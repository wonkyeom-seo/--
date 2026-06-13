const PDF_CACHE = 'pdf-files-v1';
const PDF_PATH_PREFIX = '/content/';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('pdf-files-') && name !== PDF_CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

function isPdfUrl(url) {
  return url.origin === self.location.origin && url.pathname.startsWith(PDF_PATH_PREFIX);
}

function cacheKey(url) {
  return new Request(url.href, { method: 'GET', credentials: 'same-origin' });
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

async function servePdf(request) {
  const url = new URL(request.url);
  const cache = await caches.open(PDF_CACHE);
  const cached = await cache.match(cacheKey(url));
  if (!cached) return fetch(request);

  const rangeHeader = request.headers.get('range');
  return rangeHeader ? rangeResponse(cached, rangeHeader) : cached;
}

async function cachePdf(urlValue) {
  const url = new URL(urlValue, self.location.origin);
  if (!isPdfUrl(url)) return false;

  const cache = await caches.open(PDF_CACHE);
  const key = cacheKey(url);
  if (await cache.match(key)) return true;

  const response = await fetch(key);
  if (response.ok && response.headers.get('content-type')?.includes('application/pdf')) {
    await cache.put(key, response);
    return true;
  }
  return false;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && isPdfUrl(url)) {
    event.respondWith(servePdf(event.request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CACHE_PDF' && event.data.url) {
    event.waitUntil(
      cachePdf(event.data.url).then((cached) => {
        if (cached) event.source?.postMessage({ type: 'PDF_CACHED', url: event.data.url });
      })
    );
  }
});
