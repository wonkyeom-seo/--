#!/usr/bin/env node

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { CACHE_FORMAT_VERSION, sourceVersion } = require('../src/pdf-cache');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const dataRoot = path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'data'));
const cacheRoot = path.resolve(process.env.PDF_CACHE_DIR || path.join(projectRoot, '.cache', 'pdf-pages'));
const renderWidth = readInteger('PDF_RENDER_WIDTH', 1800, 600, 4000);
const imageQuality = readInteger('PDF_IMAGE_QUALITY', 85, 40, 100);
const pdfInfoCommand = process.env.PDFINFO_BIN || 'pdfinfo';
const pdfToPpmCommand = process.env.PDFTOPPM_BIN || 'pdftoppm';

function readInteger(name, fallback, min, max) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 값은 ${min}~${max} 사이의 정수여야 합니다.`);
  }
  return parsed;
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

async function runCommand(command, args) {
  try {
    return await execFileAsync(command, args, {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`${command} 명령을 찾을 수 없습니다. Poppler를 설치하거나 실행 파일 경로를 환경 변수로 지정해 주세요.`);
    }
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`${command} 실행 실패${detail ? `: ${detail}` : ''}`);
  }
}

async function findPdfFiles(directory, prefix = '') {
  const dirents = await fsp.readdir(directory, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }));
  const files = [];

  for (const dirent of dirents) {
    if (dirent.name === '.locker') continue;
    const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    const absolutePath = path.join(directory, dirent.name);
    if (dirent.isDirectory()) files.push(...await findPdfFiles(absolutePath, relativePath));
    else if (dirent.isFile() && path.extname(dirent.name).toLowerCase() === '.pdf') {
      files.push({ relativePath, absolutePath });
    }
  }

  return files;
}

async function readExistingIndex() {
  try {
    const index = JSON.parse(await fsp.readFile(path.join(cacheRoot, 'index.json'), 'utf8'));
    return index.formatVersion === CACHE_FORMAT_VERSION ? index : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function cachedDocumentIsComplete(document, version) {
  if (
    !document ||
    document.sourceVersion !== version ||
    document.renderWidth !== renderWidth ||
    document.imageQuality !== imageQuality ||
    !Array.isArray(document.pages) ||
    document.pages.length !== 1
  ) return false;

  try {
    await Promise.all(document.pages.map((pagePath) => fsp.access(path.resolve(cacheRoot, pagePath))));
    return true;
  } catch {
    return false;
  }
}

function parsePageCount(output) {
  const match = /^Pages:\s+(\d+)\s*$/m.exec(output);
  const pageCount = Number(match?.[1]);
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF 페이지 수를 확인하지 못했습니다.');
  return pageCount;
}

function parsePageSizes(output, pageCount) {
  const sizes = Array(pageCount);
  const rotations = new Map();
  const sizePattern = /^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/mg;
  const rotationPattern = /^Page\s+(\d+)\s+rot:\s+(-?\d+)/mg;
  let match;

  while ((match = rotationPattern.exec(output))) rotations.set(Number(match[1]), Number(match[2]));
  while ((match = sizePattern.exec(output))) {
    const pageNumber = Number(match[1]);
    let width = Number(match[2]);
    let height = Number(match[3]);
    const rotation = ((rotations.get(pageNumber) || 0) % 360 + 360) % 360;
    if (rotation === 90 || rotation === 270) [width, height] = [height, width];
    sizes[pageNumber - 1] = { width, height };
  }

  if (sizes.filter(Boolean).length !== pageCount) throw new Error('PDF 페이지 크기를 확인하지 못했습니다.');
  return sizes;
}

async function inspectPdf(filePath) {
  const details = await runCommand(pdfInfoCommand, ['-f', '1', '-l', '1', filePath]);
  const pageCount = parsePageCount(details.stdout);
  return { pageCount, pageSizes: parsePageSizes(details.stdout, 1) };
}

async function renderPdf(file, stats) {
  const version = sourceVersion(stats);
  const documentKey = crypto.createHash('sha256').update(file.relativePath).digest('hex').slice(0, 24);
  const outputRelativeDirectory = toPosixPath(path.join('documents', documentKey, `${version}-${renderWidth}-${imageQuality}`));
  const outputDirectory = path.resolve(cacheRoot, outputRelativeDirectory);
  await fsp.mkdir(outputDirectory, { recursive: true });

  const { pageCount, pageSizes } = await inspectPdf(file.absolutePath);
  const outputPrefix = path.join(outputDirectory, 'page');
  console.log(`  미리보기 생성: ${file.relativePath} (전체 ${pageCount}페이지)`);
  await runCommand(pdfToPpmCommand, [
    '-f', '1',
    '-l', '1',
    '-singlefile',
    '-jpeg',
    '-jpegopt', `quality=${imageQuality},progressive=y,optimize=y`,
    '-scale-to-x', String(renderWidth),
    '-scale-to-y', '-1',
    file.absolutePath,
    outputPrefix
  ]);

  const previewFileName = 'page.jpg';
  await fsp.access(path.join(outputDirectory, previewFileName));

  return {
    sourceVersion: version,
    sourceSize: stats.size,
    sourceModifiedAt: stats.mtime.toISOString(),
    pageCount,
    pageSizes,
    renderWidth,
    imageQuality,
    pages: [`${outputRelativeDirectory}/${previewFileName}`]
  };
}

async function writeIndex(documents) {
  await fsp.mkdir(cacheRoot, { recursive: true });
  const indexPath = path.join(cacheRoot, 'index.json');
  const temporaryPath = `${indexPath}.tmp`;
  const index = {
    formatVersion: CACHE_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    dataRoot,
    documents
  };
  await fsp.writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await fsp.rename(temporaryPath, indexPath);
}

async function main() {
  const dataStats = await fsp.stat(dataRoot).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`자료 폴더를 찾을 수 없습니다: ${dataRoot}`);
    throw error;
  });
  if (!dataStats.isDirectory()) throw new Error(`DATA_DIR이 폴더가 아닙니다: ${dataRoot}`);

  await Promise.all([
    runCommand(pdfInfoCommand, ['-v']),
    runCommand(pdfToPpmCommand, ['-v'])
  ]);

  const files = await findPdfFiles(dataRoot);
  const existingIndex = await readExistingIndex();
  const documents = {};
  let rendered = 0;
  let reused = 0;
  let failed = 0;

  console.log(`PDF ${files.length}개를 확인합니다.`);
  console.log(`출력: ${cacheRoot}`);

  for (const file of files) {
    const stats = await fsp.stat(file.absolutePath);
    const version = sourceVersion(stats);
    const existing = existingIndex?.documents?.[file.relativePath];
    if (await cachedDocumentIsComplete(existing, version)) {
      documents[file.relativePath] = existing;
      reused += 1;
      console.log(`  재사용: ${file.relativePath}`);
      continue;
    }

    try {
      documents[file.relativePath] = await renderPdf(file, stats);
      rendered += 1;
    } catch (error) {
      failed += 1;
      console.error(`  실패: ${file.relativePath}`);
      console.error(`    ${error.message}`);
    }
  }

  await writeIndex(documents);
  console.log(`완료: 새로 생성 ${rendered}개, 재사용 ${reused}개, 실패 ${failed}개`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parsePageCount,
  parsePageSizes
};
