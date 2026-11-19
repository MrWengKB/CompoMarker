// 单篇和批量共用的核心流程：读取图片 / PDF、逐页识别、批改并整理结果。
import { chat, extractJSON } from './providers.js';
import { OCR_SYSTEM, ocrPageText, ocrGridPageText, CONTINUE_MARK, MARK_SYSTEM, markUserText } from './prompts.js';
import { detectGrid } from './grid.js';
import { layoutPage, assemble } from './layout.js';
import { PROVIDERS } from './config.js';

export const MAX_IMAGE_SIDE = 2000;
export const MAX_PDF_PAGES = 10;

/* ---------------- 图片与 PDF ---------------- */

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法读取'));
    img.src = src;
  });
}

export function canvasToImage(canvas, name) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { name, dataUrl, mediaType: 'image/jpeg', data: dataUrl.split(',')[1] };
}

// 压缩到长边不超过 MAX_IMAGE_SIDE，统一转 JPEG，减小上传体积
export async function prepareImage(file) {
  const src = await readAsDataURL(file);
  const img = await loadImage(src);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvasToImage(canvas, file.name);
}

let pdfjsLib = null;

// PDF 每一页渲染成一张图片（扫描件、手机扫描 App 导出的 PDF 都可以）
export async function pdfToImages(file, onWarn) {
  if (!pdfjsLib) {
    pdfjsLib = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const count = Math.min(doc.numPages, MAX_PDF_PAGES);
  if (doc.numPages > MAX_PDF_PAGES) onWarn?.(`${file.name} 共 ${doc.numPages} 页，只取前 ${MAX_PDF_PAGES} 页`);
  const out = [];
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: MAX_IMAGE_SIDE / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    out.push(canvasToImage(canvas, `${file.name} 第${i}页`));
  }
  task.destroy().catch(() => {});
  return out;
}

export const isPDF = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
export const isImage = (f) => (f.type || '').startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name);
export const isZip = (f) => /zip/.test(f.type || '') || /\.zip$/i.test(f.name);

/* ---------------- 识别 ---------------- */

// 把下一页的识别结果接到前面：续写的段落直接接上，新段落空一行
export function joinPage(prev, page) {
  const t = page.trim();
  if (!prev) return t;
  if (t.startsWith(CONTINUE_MARK)) return prev.replace(/\s+$/, '') + t.slice(CONTINUE_MARK.length).trimStart();
  return `${prev.replace(/\s+$/, '')}\n\n${t}`;
}

// 逐页识别（每次只上传一页，避免请求过大）。
// 方格纸的页先在本地检测格子，再让模型按方格逐行转写，以便把批改符号画回原图。
// onProgress({ text, page, pages, pageChars })：text 是目前为止的全文
// 返回 { text, layout }；layout 为 null 表示没有检测到方格
export async function ocrPages({ settings, images, onProgress }) {
  const n = images.length;
  const pages = [];
  let done = '';
  for (let i = 0; i < n; i++) {
    let grid = null;
    try {
      grid = await detectGrid(images[i].dataUrl);
      if (grid && !grid.rows.some((r) => r.filled)) grid = null;
    } catch (e) {
      console.warn('方格检测失败', e);
    }
    const pageText = await chat({
      settings,
      model: settings.visionModel,
      system: OCR_SYSTEM,
      text: grid ? ocrGridPageText(i, n, grid.rows) : ocrPageText(i, n),
      images: [images[i]],
      onDelta: (partial) => {
        const cur = !grid && (partial.startsWith(CONTINUE_MARK) || CONTINUE_MARK.startsWith(partial)) ? partial.slice(CONTINUE_MARK.length) : partial;
        onProgress?.({ text: done ? `${done}\n\n${cur}` : cur, page: i, pages: n, pageChars: cur.length });
      },
    }).catch((e) => {
      e.partialText = done;
      throw e;
    });
    pages.push(grid ? { grid, layout: layoutPage(grid, pageText), dataUrl: images[i].dataUrl } : { text: pageText, dataUrl: images[i].dataUrl });
    done = assemble(pages).text;
    onProgress?.({ text: done, page: i + 1, pages: n, pageChars: 0 });
  }
  const { text, map } = assemble(pages);
  const layout = pages.some((p) => p.grid) ? { text, map, pages } : null;
  return { text, layout };
}

/* ---------------- 批改 ---------------- */

export function normalizeResult(r, rubric, caps = {}) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const topic = ['切题', '不切合题意', '离题'].includes(r.topic) ? r.topic : '切题';
  const cap = caps[topic] || {};
  const scores = arr(r.scores).map((s, i) => {
    const name = s.name || rubric[i]?.name || `维度${i + 1}`;
    const max = Number(rubric.find((x) => x.name === name)?.max) || Number(s.max) || Number(rubric[i]?.max) || 0;
    let score = Math.max(0, Math.min(max || Infinity, Number(s.score) || 0));
    let comment = s.comment || '';
    // 切题规定：不切合题意 / 离题时按评分准则封顶
    if (name in cap && score > cap[name]) {
      score = cap[name];
      comment = `${comment}（${topic}，本项以 ${cap[name]} 分为上限）`;
    }
    return { name, score, max, comment };
  });
  const total = scores.reduce((a, s) => a + s.score, 0);
  const max = scores.reduce((a, s) => a + s.max, 0) || rubric.reduce((a, s) => a + Number(s.max), 0);
  return {
    scores,
    total: Math.round(total * 10) / 10,
    max,
    level: r.level || '',
    topic,
    typos: arr(r.typos).filter((t) => t && t.wrong),
    sentences: arr(r.sentences).filter((s) => s && s.original),
    highlights: arr(r.highlights).filter((s) => s && s.original),
    strengths: arr(r.strengths),
    weaknesses: arr(r.weaknesses),
    suggestions: arr(r.suggestions),
    comment: r.comment || '',
  };
}

export function buildMeta(settings, fields) {
  return {
    ...fields,
    provider: PROVIDERS[settings.provider].name,
    model: settings.textModel,
    time: Date.now(),
  };
}

// 批改一篇。最多请求两次：第一次解析失败或截断严重时自动重试。
// 返回 { result, truncated }；失败时抛出的错误带 raw（模型原始输出）。
export async function markEssay({ settings, body, meta, stats, onProgress }) {
  let lastOut = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    lastOut = await chat({
      settings,
      model: settings.textModel,
      system: MARK_SYSTEM,
      text: markUserText({ essay: body, stats, ...meta }),
      json: true,
      onDelta: (partial) => onProgress?.({ chars: partial.length, attempt }),
    });
    try {
      const p = extractJSON(lastOut);
      const usable = Array.isArray(p.value?.scores) && p.value.scores.length > 0;
      if (usable && (!p.truncated || attempt === 2)) {
        return { result: normalizeResult(p.value, meta.rubric, meta.caps), truncated: p.truncated };
      }
      if (attempt === 2) throw new Error('批改结果不完整。');
    } catch (err) {
      if (attempt === 2) {
        err.raw = lastOut;
        throw err;
      }
    }
  }
  throw new Error('批改失败。');
}

/* ---------------- 并发控制 ---------------- */

// 同时最多运行 limit 个任务，其余排队
export function makeLimiter(limit) {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= limit || !queue.length) return;
    const { fn, resolve, reject } = queue.shift();
    running++;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        running--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/* ---------------- 历史记录 ---------------- */

const HISTORY_KEY = 'compomarker.history.v1';
const HISTORY_MAX = 100;

export function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

export function saveHistory(entry) {
  const list = readHistory();
  list.unshift(entry);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX), (k, v) => (k.startsWith('_') ? undefined : v))); } catch { /* 存储满或不可用 */ }
}

export function clearHistory() {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}
