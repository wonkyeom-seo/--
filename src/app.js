const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PDFJS_DIR = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
const SEARCH_LIMIT = 100;
const LOCKER_FILE = '.locker';

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeRelativePath(input = '') {
  if (typeof input !== 'string' || input.includes('\0')) {
    throw Object.assign(new Error('올바르지 않은 경로입니다.'), { status: 400 });
  }

  const normalized = input.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return '';

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw Object.assign(new Error('data 폴더 외부에는 접근할 수 없습니다.'), { status: 400 });
  }

  return segments.join('/');
}

function encodePath(relativePath) {
  return relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function formatEntry(dirent, stats, relativePath, metadata = {}) {
  const entry = {
    name: dirent.name,
    path: relativePath,
    type: dirent.isDirectory() ? 'directory' : 'file',
    size: dirent.isFile() ? stats.size : null,
    modifiedAt: stats.mtime.toISOString(),
    extension: dirent.isFile() ? path.extname(dirent.name).slice(1).toLowerCase() : null,
    viewable: dirent.isFile() && path.extname(dirent.name).toLowerCase() === '.pdf'
  };
  if (metadata.locked) entry.locked = true;
  if (metadata.lockedBy !== undefined) entry.lockedBy = metadata.lockedBy;
  return entry;
}

function sortEntries(a, b) {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
}

function contentDisposition(disposition, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '\\"');
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return false;
  }

  return { start, end: Math.min(end, size - 1) };
}

function createApp(options = {}) {
  const app = express();
  const dataRoot = path.resolve(options.dataRoot || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  let realDataRootPromise;

  async function getRealDataRoot() {
    if (!realDataRootPromise) realDataRootPromise = fsp.realpath(dataRoot);
    return realDataRootPromise;
  }

  async function resolveExistingPath(input, expectedType) {
    const relativePath = normalizeRelativePath(input);
    const candidate = path.resolve(dataRoot, ...relativePath.split('/').filter(Boolean));

    if (!isInside(dataRoot, candidate)) {
      throw Object.assign(new Error('data 폴더 외부에는 접근할 수 없습니다.'), { status: 400 });
    }

    let realRoot;
    let realCandidate;
    try {
      [realRoot, realCandidate] = await Promise.all([getRealDataRoot(), fsp.realpath(candidate)]);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw Object.assign(new Error('요청한 자료를 찾을 수 없습니다.'), { status: 404 });
      }
      throw error;
    }

    if (!isInside(realRoot, realCandidate)) {
      throw Object.assign(new Error('data 폴더 외부에는 접근할 수 없습니다.'), { status: 400 });
    }

    const stats = await fsp.stat(realCandidate);
    if (expectedType === 'directory' && !stats.isDirectory()) {
      throw Object.assign(new Error('요청한 폴더를 찾을 수 없습니다.'), { status: 404 });
    }
    if (expectedType === 'file' && !stats.isFile()) {
      throw Object.assign(new Error('요청한 파일을 찾을 수 없습니다.'), { status: 404 });
    }

    return { relativePath, realPath: realCandidate, stats };
  }

  async function hasLocker(absoluteDirectory) {
    try {
      const stats = await fsp.stat(path.join(absoluteDirectory, LOCKER_FILE));
      return stats.isFile();
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function listDirectory(relativePath) {
    const directory = await resolveExistingPath(relativePath, 'directory');
    const dirents = await fsp.readdir(directory.realPath, { withFileTypes: true });
    const entries = await Promise.all(
      dirents
        .filter((dirent) => dirent.name !== LOCKER_FILE && (dirent.isDirectory() || dirent.isFile()))
        .map(async (dirent) => {
          const entryPath = directory.relativePath ? `${directory.relativePath}/${dirent.name}` : dirent.name;
          const stats = await fsp.stat(path.join(directory.realPath, dirent.name));
          const locked = dirent.isDirectory() && await hasLocker(path.join(directory.realPath, dirent.name));
          return formatEntry(dirent, stats, entryPath, { locked });
        })
    );
    return {
      path: directory.relativePath,
      locked: await hasLocker(directory.realPath),
      entries: entries.sort(sortEntries)
    };
  }

  async function searchFiles(query) {
    const needle = query.trim().toLocaleLowerCase('ko');
    if (!needle) return [];

    const results = [];
    const root = await resolveExistingPath('', 'directory');

    async function walk(absoluteDirectory, relativeDirectory, lockedBy) {
      if (results.length >= SEARCH_LIMIT) return;
      const dirents = await fsp.readdir(absoluteDirectory, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }));

      for (const dirent of dirents) {
        if (results.length >= SEARCH_LIMIT) break;
        if (!dirent.isDirectory() && !dirent.isFile()) continue;
        if (dirent.name === LOCKER_FILE) continue;

        const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
        const absolutePath = path.join(absoluteDirectory, dirent.name);
        const locked = dirent.isDirectory() && await hasLocker(absolutePath);
        const metadata = {
          locked,
          lockedBy
        };

        if (dirent.name.toLocaleLowerCase('ko').includes(needle)) {
          const stats = await fsp.stat(absolutePath);
          results.push(formatEntry(dirent, stats, relativePath, metadata));
        }
        if (dirent.isDirectory()) {
          await walk(absolutePath, relativePath, lockedBy ?? (locked ? relativePath : undefined));
        }
      }
    }

    await walk(root.realPath, '', await hasLocker(root.realPath) ? '' : undefined);
    return results.sort(sortEntries);
  }

  async function sendFile(req, res, disposition) {
    const file = await resolveExistingPath(req.params[0], 'file');
    const filename = path.basename(file.realPath);
    const isPdf = path.extname(filename).toLowerCase() === '.pdf';
    const range = parseRange(req.headers.range, file.stats.size);

    res.set({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-cache',
      'Content-Disposition': contentDisposition(disposition, filename),
      'Content-Type': isPdf ? 'application/pdf' : 'application/octet-stream',
      'Last-Modified': file.stats.mtime.toUTCString()
    });

    if (range === false) {
      res.status(416).set('Content-Range', `bytes */${file.stats.size}`).end();
      return;
    }

    if (range) {
      res.status(206).set({
        'Content-Length': range.end - range.start + 1,
        'Content-Range': `bytes ${range.start}-${range.end}/${file.stats.size}`
      });
      fs.createReadStream(file.realPath, range).pipe(res);
      return;
    }

    res.set('Content-Length', file.stats.size);
    fs.createReadStream(file.realPath).pipe(res);
  }

  app.disable('x-powered-by');
  app.use('/vendor/pdfjs', express.static(PDFJS_DIR, { fallthrough: false, maxAge: '1d' }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.get('/api/browse', async (req, res, next) => {
    try {
      const relativePath = normalizeRelativePath(req.query.path || '');
      const directory = await listDirectory(relativePath);
      res.json(directory);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/search', async (req, res, next) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const entries = await searchFiles(query);
      res.json({ query, limit: SEARCH_LIMIT, entries });
    } catch (error) {
      next(error);
    }
  });

  app.get('/content/*', async (req, res, next) => {
    try {
      await sendFile(req, res, 'inline');
    } catch (error) {
      next(error);
    }
  });

  app.get('/download/*', async (req, res, next) => {
    try {
      await sendFile(req, res, 'attachment');
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API 경로를 찾을 수 없습니다.' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
    if (status >= 500) console.error(error);

    if (req.path.startsWith('/api/')) {
      res.status(status).json({ error: status >= 500 ? '서버 오류가 발생했습니다.' : error.message });
      return;
    }
    res.status(status).type('text/plain').send(status >= 500 ? '서버 오류가 발생했습니다.' : error.message);
  });

  return app;
}

module.exports = {
  createApp,
  encodePath,
  normalizeRelativePath,
  parseRange,
  sortEntries
};
