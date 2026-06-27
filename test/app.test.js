const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { after, before, test } = require('node:test');
const { createApp } = require('../src/app');

let tempRoot;
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

  const app = createApp({ dataRoot: tempRoot });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempRoot, { recursive: true, force: true });
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

  const offlineSaveLockerResponse = await fetch(`${baseUrl}/content/${lockerPath}?offlineSave=1`);
  assert.equal(offlineSaveLockerResponse.status, 200);
  assert.equal(await offlineSaveLockerResponse.text(), 'secret');
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

test('PWA manifest and service worker are served', async () => {
  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));

  const workerResponse = await fetch(`${baseUrl}/service-worker.js`);
  assert.equal(workerResponse.status, 200);
  const worker = await workerResponse.text();
  assert.match(worker, /const PDF_PATH_PREFIX = '\/content\/';/);
  assert.match(worker, /GET_OFFLINE_MODE/);
  assert.match(worker, /isExplicitLockerCheck/);
  assert.match(worker, /url\.searchParams\.get\('offlineSave'\) === '1'/);
  assert.match(worker, /allowWhenDisabled: event\.data\.allowWhenDisabled === true/);

  const appResponse = await fetch(`${baseUrl}/js/app.js`);
  const appScript = await appResponse.text();
  assert.match(appScript, /allowWhenDisabled: true/);
  assert.match(appScript, /!entry\.locked \|\| await ensureLockedFolders\(\[entry\.path\], true\)/);
  assert.doesNotMatch(appScript, /오프라인 모드를 켠 뒤 저장할 수 있습니다/);
});

test('service worker uses cached folder lists when the server is unavailable', async () => {
  const listeners = {};
  const cachedList = { path: '', lockers: [], entries: [{ name: '저장됨', type: 'directory' }] };
  let networkMode = 'throw';

  const settingsCache = {
    match: async () => undefined,
    put: async () => undefined
  };
  const apiCache = {
    match: async () => new Response(JSON.stringify(cachedList), {
      headers: { 'Content-Type': 'application/json' }
    }),
    put: async () => undefined
  };
  const cacheStorage = {
    open: async (name) => name === 'pwa-settings-v1' ? settingsCache : apiCache
  };
  const workerSource = await fs.readFile(path.join(__dirname, '..', 'public', 'service-worker.js'), 'utf8');
  const context = vm.createContext({
    self: {
      location: { origin: 'https://library.test' },
      addEventListener: (type, listener) => {
        listeners[type] = listener;
      }
    },
    caches: cacheStorage,
    fetch: async () => {
      if (networkMode === 'throw') throw new Error('server stopped');
      return new Response('Bad Gateway', { status: 502 });
    },
    Request,
    Response,
    Headers,
    URL,
    console
  });
  vm.runInContext(workerSource, context);

  async function requestBrowse() {
    let responsePromise;
    listeners.fetch({
      request: new Request('https://library.test/api/browse'),
      respondWith: (value) => {
        responsePromise = Promise.resolve(value);
      }
    });
    return responsePromise;
  }

  const stoppedResponse = await requestBrowse();
  assert.equal(stoppedResponse.status, 200);
  assert.equal(stoppedResponse.headers.get('X-PWA-Source'), 'cache');
  assert.deepEqual(await stoppedResponse.json(), cachedList);

  networkMode = '502';
  const gatewayResponse = await requestBrowse();
  assert.equal(gatewayResponse.status, 200);
  assert.equal(gatewayResponse.headers.get('X-PWA-Source'), 'cache');
  assert.deepEqual(await gatewayResponse.json(), cachedList);
});
