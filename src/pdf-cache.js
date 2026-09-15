const fsp = require('node:fs/promises');
const path = require('node:path');

const CACHE_FORMAT_VERSION = 1;

function sourceVersion(stats) {
  return `${stats.size}-${Math.trunc(stats.mtimeMs)}`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

class PdfCache {
  constructor(cacheRoot) {
    this.cacheRoot = path.resolve(cacheRoot);
    this.indexPath = path.join(this.cacheRoot, 'index.json');
    this.index = null;
    this.indexMtimeMs = -1;
  }

  async loadIndex() {
    let stats;
    try {
      stats = await fsp.stat(this.indexPath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    if (this.index && this.indexMtimeMs === stats.mtimeMs) return this.index;

    try {
      const index = JSON.parse(await fsp.readFile(this.indexPath, 'utf8'));
      if (index.formatVersion !== CACHE_FORMAT_VERSION || typeof index.documents !== 'object') return null;
      this.index = index;
      this.indexMtimeMs = stats.mtimeMs;
      return index;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async getManifest(relativePath, stats) {
    const index = await this.loadIndex();
    const document = index?.documents?.[relativePath];
    if (!document || document.sourceVersion !== sourceVersion(stats)) return null;
    if (!Number.isInteger(document.pageCount) || document.pageCount < 1) return null;
    if (!Array.isArray(document.pages) || document.pages.length < 1) return null;

    return {
      pageCount: document.pageCount,
      previewSize: document.pageSizes?.[0],
      renderWidth: document.renderWidth,
      sourceVersion: document.sourceVersion
    };
  }

  async getPagePath(relativePath, stats, pageNumber) {
    const index = await this.loadIndex();
    const document = index?.documents?.[relativePath];
    if (!document || document.sourceVersion !== sourceVersion(stats)) return null;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.pages?.length) return null;

    const cachedRelativePath = document.pages?.[pageNumber - 1];
    if (typeof cachedRelativePath !== 'string') return null;
    const absolutePath = path.resolve(this.cacheRoot, cachedRelativePath);
    if (!isInside(this.cacheRoot, absolutePath)) return null;

    try {
      const cachedStats = await fsp.stat(absolutePath);
      return cachedStats.isFile() ? absolutePath : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
}

module.exports = {
  CACHE_FORMAT_VERSION,
  PdfCache,
  sourceVersion
};
