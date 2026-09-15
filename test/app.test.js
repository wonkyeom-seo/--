const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { after, before, test } = require('node:test');
const { createApp } = require('../src/app');
const { sourceVersion } = require('../src/pdf-cache');
const { parsePageCount, parsePageSizes } = require('../scripts/precache-pdfs');

let tempRoot;
let tempCacheRoot;
let baseUrl;
let server;

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'exam-library-'));
  await fs.mkdir(path.join(tempRoot, '가 폴더', '빈 폴더'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, '나 폴더'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, '[시험] 학습자료.pdf'), Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));
  await fs.writeFile(path.join(tempRoot, '가 폴더', '문제.txt'), 'study');
  await fs.writeFile(path.join(tempRoot, '나 폴더', '.locker'), 'secret');
  await fs.writeFile(path.join(tempRoot, '나 폴더', '비밀.pdf'), 'locked');

  tempCacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'exam-library-cache-'));
  const pdfStats = await fs.stat(path.join(tempRoot, '[시험] 학습자료.pdf'));
  const pageRelativePath = 'documents/test/page-1.jpg';
  await fs.mkdir(path.join(tempCacheRoot, 'documents', 'test'), { recursive: true });
  await fs.writeFile(path.join(tempCacheRoot, pageRelativePath), Buffer.from('cached-page'));
  await fs.writeFile(path.join(tempCacheRoot, 'index.json'), JSON.stringify({
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    documents: {
      '[시험] 학습자료.pdf': {
        sourceVersion: sourceVersion(pdfStats),
        pageCount: 12,
        pageSizes: [{ width: 595, height: 842 }],
        renderWidth: 1800,
        imageQuality: 85,
        pages: [pageRelativePath]
      }
    }
  }));

  const app = createApp({ dataRoot: tempRoot, cacheRoot: tempCacheRoot });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.rm(tempCacheRoot, { recursive: true, force: true });
});

test('browse returns directories first and supports empty folders', async () => {
  const rootResponse = await fetch(`${baseUrl}/api/browse`);
  assert.equal(rootResponse.status, 200);
  const root = await rootResponse.json();
  assert.deepEqual(root.entries.map((entry) => entry.type), ['directory', 'directory', 'file']);
  assert.equal(root.entries[0].name, '가 폴더');
  assert.equal(root.entries[1].name, '나 폴더');
  assert.equal(root.entries[1].locked, true);
  assert.deepEqual(root.lockers, []);

  const emptyResponse = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent('가 폴더/빈 폴더')}`);
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual((await emptyResponse.json()).entries, []);
});

test('pdfinfo output is parsed including rotated page dimensions', () => {
  const output = [
    'Pages:           2',
    'Page    1 size:  595.276 x 841.89 pts (A4)',
    'Page    1 rot:   0',
    'Page    2 size:  612 x 792 pts (letter)',
    'Page    2 rot:   90'
  ].join('\n');

  assert.equal(parsePageCount(output), 2);
  assert.deepEqual(parsePageSizes(output, 2), [
    { width: 595.276, height: 841.89 },
    { width: 792, height: 612 }
  ]);
});

test('locker files are hidden from listings without blocking direct file serving', async () => {
  const browseResponse = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent('나 폴더')}`);
  assert.equal(browseResponse.status, 200);
  const browseBody = await browseResponse.json();
  assert.equal(browseBody.locked, true);
  assert.deepEqual(browseBody.lockers, ['나 폴더']);
  assert.deepEqual(browseBody.entries.map((entry) => entry.name), ['비밀.pdf']);

  const searchResponse = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('비밀')}`);
  assert.equal(searchResponse.status, 200);
  const searchBody = await searchResponse.json();
  assert.equal(searchBody.entries.length, 1);
  assert.equal(searchBody.entries[0].path, '나 폴더/비밀.pdf');
  assert.equal(searchBody.entries[0].lockedBy, '나 폴더');

  const lockerSearchResponse = await fetch(`${baseUrl}/api/search?q=locker`);
  assert.equal(lockerSearchResponse.status, 200);
  assert.equal((await lockerSearchResponse.json()).entries.length, 0);

  const lockerPath = ['나 폴더', '.locker'].map(encodeURIComponent).join('/');
  const lockerResponse = await fetch(`${baseUrl}/content/${lockerPath}`);
  assert.equal(lockerResponse.status, 200);
  assert.equal(await lockerResponse.text(), 'secret');

});

test('search finds nested files and Korean names', async () => {
  const response = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('문제')}`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].path, '가 폴더/문제.txt');
});

test('content endpoint serves byte ranges', async () => {
  const response = await fetch(`${baseUrl}/content/${encodeURIComponent('[시험] 학습자료.pdf')}`, {
    headers: { Range: 'bytes=5-9' }
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 5-9/36');
  assert.equal(await response.text(), '56789');
});

test('pre-rendered PDF manifest and page image are served from cache', async () => {
  const pdfPath = encodeURIComponent('[시험] 학습자료.pdf');
  const manifestResponse = await fetch(`${baseUrl}/api/pdf/manifest?path=${pdfPath}`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.pageCount, 12);
  assert.deepEqual(manifest.previewSize, { width: 595, height: 842 });
  assert.match(manifest.sourceVersion, /^36-/);

  const pageResponse = await fetch(`${baseUrl}/api/pdf/page?path=${pdfPath}&page=1`);
  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.headers.get('content-type'), 'image/jpeg');
  assert.match(pageResponse.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.from(await pageResponse.arrayBuffer()).toString(), 'cached-page');

  const invalidPageResponse = await fetch(`${baseUrl}/api/pdf/page?path=${pdfPath}&page=2`);
  assert.equal(invalidPageResponse.status, 404);

  const missingResponse = await fetch(`${baseUrl}/api/pdf/manifest?path=${encodeURIComponent('나 폴더/비밀.pdf')}`);
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).code, 'PDF_CACHE_MISS');
});

test('download endpoint preserves UTF-8 file names', async () => {
  const response = await fetch(`${baseUrl}/download/${encodeURIComponent('[시험] 학습자료.pdf')}`);
  assert.equal(response.status, 200);
  const disposition = response.headers.get('content-disposition');
  assert.match(disposition, /^attachment;/);
  assert.match(disposition, /filename\*=UTF-8''%5B%EC%8B%9C%ED%97%98%5D%20%ED%95%99%EC%8A%B5%EC%9E%90%EB%A3%8C\.pdf/);
});

test('invalid ranges and traversal attempts are rejected', async () => {
  const rangeResponse = await fetch(`${baseUrl}/content/${encodeURIComponent('[시험] 학습자료.pdf')}`, {
    headers: { Range: 'bytes=999-1000' }
  });
  assert.equal(rangeResponse.status, 416);

  const browseResponse = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent('../outside')}`);
  assert.equal(browseResponse.status, 400);

  const contentResponse = await fetch(`${baseUrl}/content/%2E%2E/outside.txt`);
  assert.ok([400, 404].includes(contentResponse.status));
});

test('PWA metadata is served without offline infrastructure', async () => {
  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));

  const workerResponse = await fetch(`${baseUrl}/service-worker.js`);
  assert.equal(workerResponse.status, 404);

  const indexResponse = await fetch(`${baseUrl}/`);
  assert.equal(indexResponse.status, 200);
  assert.doesNotMatch(await indexResponse.text(), /offlineToggle|오프라인/);

  const viewerResponse = await fetch(`${baseUrl}/viewer.html`);
  assert.equal(viewerResponse.status, 200);
  assert.doesNotMatch(await viewerResponse.text(), /offlineSaveButton|오프라인/);

  const pwaResponse = await fetch(`${baseUrl}/js/pwa.js`);
  assert.equal(pwaResponse.status, 200);
  const pwaScript = await pwaResponse.text();
  assert.doesNotMatch(pwaScript, /GET_OFFLINE_MODE|SET_OFFLINE_MODE|CACHE_PDF|offlineToggle|pwaControls/);
});
