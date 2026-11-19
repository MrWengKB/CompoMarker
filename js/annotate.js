// 在作文原图上画批改符号：× 错别字、~~ 病句（波浪线）、√ 佳句。
// 位置来自本地检测的方格（grid.js）和逐字对应（layout.js），不需要再把图片发给模型。
import { alignText } from './layout.js';
import { svgTransform, applyPageTransform } from './grid.js';
import { escapeHTML } from './analyze.js';

const RED = '#d0021b';

/* ---------------- 找位置 ---------------- */

function locate(body, needle, context) {
  if (!needle) return -1;
  if (context) {
    let c = body.indexOf(context);
    while (c !== -1) {
      const inner = context.indexOf(needle);
      if (inner !== -1) return c + inner;
      c = body.indexOf(context, c + 1);
    }
  }
  let i = body.indexOf(needle);
  if (i === -1) {
    // 模型摘抄时偶尔多带或少带句末标点
    const trimmed = needle.replace(/[，。！？；：、,.!?;:\s]+$/, '');
    if (trimmed.length >= 2) i = body.indexOf(trimmed);
  }
  return i;
}

// 每页的线性格子编号：第 r 行第 c 格 = 前面各行格数之和 + c
function rowStarts(grid) {
  const s = [];
  let t = 0;
  for (const r of grid.rows) { s.push(t); t += r.cells.length; }
  return s;
}

function cellOf(grid, lin) {
  const starts = rowStarts(grid);
  let r = starts.length - 1;
  while (r > 0 && starts[r] > lin) r--;
  const row = grid.rows[r];
  const c = Math.max(0, Math.min(row.cells.length - 1, lin - starts[r]));
  return { r, c, cell: row.cells[c] };
}

/**
 * 根据批改结果算出每页要画的符号。
 * 返回 null（没有方格信息或对不上）或 { pages: [{ grid, dataUrl, marks: [{ kind, index, a, b }] }], warnings, unplaced }
 */
export function computeAnnotations(entry) {
  const L = entry._layout;
  if (!L || !entry._text) return null;
  const full = entry._text;
  const body = entry.body;
  let off = full.endsWith(body) ? full.length - body.length : full.indexOf(body);
  if (off < 0) return null;
  const idx = alignText([...full].join(''), L.text);
  // body 的字符下标 → 全文字符下标（按码点）
  const offCp = [...full.slice(0, off)].length;
  const posOf = (k) => {
    const j = idx[offCp + k];
    return j >= 0 ? L.map[j] : null;
  };
  const bodyChars = [...body];
  const mapped = bodyChars.filter((_, k) => posOf(k)).length;
  if (mapped < bodyChars.length * 0.5) return null; // 原文和识别结果差太多（例如换成了粘贴的文字）

  const pages = L.pages.map((p) => ({ grid: p.grid || null, dataUrl: p.dataUrl, marks: [], layout: p.layout }));
  const starts = pages.map((p) => (p.grid ? rowStarts(p.grid) : null));
  const lin = (pos) => starts[pos.page][pos.row] + Math.min(pos.cell, pages[pos.page].grid.rows[pos.row].cells.length - 1);
  const r = entry.result;
  const unplaced = [];
  // 码点下标 ↔ UTF-16 下标（作文里基本都是 BMP 字符，这里仍按码点处理以防万一）
  const cpIndex = (s, i) => [...s.slice(0, i)].length;

  const addRange = (kind, index, start, len) => {
    const byPage = new Map();
    for (let k = start; k < start + len; k++) {
      const pos = posOf(k);
      if (!pos || !pages[pos.page].grid) continue;
      if (!byPage.has(pos.page)) byPage.set(pos.page, []);
      byPage.get(pos.page).push(lin(pos));
    }
    if (!byPage.size) return false;
    for (const [page, ls] of byPage) pages[page].marks.push({ kind, index, a: Math.min(...ls), b: Math.max(...ls) });
    return true;
  };

  (r.typos || []).forEach((t, i) => {
    const w = (t.wrong || '').trim();
    const p = locate(body, w, (t.context || '').trim());
    if (p < 0 || !addRange('typo', i, cpIndex(body, p), [...w].length)) unplaced.push(`错别字「${w}」`);
  });
  (r.sentences || []).forEach((s, i) => {
    const o = (s.original || '').trim();
    const p = locate(body, o);
    if (p < 0 || !addRange('sentence', i, cpIndex(body, p), [...o].length)) unplaced.push(`病句「${o.slice(0, 12)}…」`);
  });
  (r.highlights || []).forEach((s, i) => {
    const o = (s.original || '').trim();
    const p = locate(body, o);
    if (p < 0 || !addRange('good', i, cpIndex(body, p), [...o].length)) unplaced.push(`佳句「${o.slice(0, 12)}…」`);
  });

  const warnings = [];
  pages.forEach((p, pi) => {
    if (!p.layout) return;
    for (const row of p.layout.rows) if (row.warn && row.row >= 0) warnings.push({ page: pi, row: row.row, text: `第 ${pi + 1} 页第 ${row.row + 1} 行：${row.warn}，这一行的符号可能偏一格，请核对。` });
  });
  return { pages, warnings, unplaced };
}

/* ---------------- 画符号（SVG 路径，网页和导出图片共用） ---------------- */

function rowGap(grid, r) {
  const row = grid.rows[r], next = grid.rows[r + 1];
  const c = row.cells[0];
  if (!next) return (c.yb - c.yt) * 0.25;
  return Math.max(0, next.cells[0].yt - c.yb);
}

// 返回 [{ d, width, fill? }]，坐标在检测用的工作图里
export function markPaths(grid, m) {
  const out = [];
  const pitch = grid.pitch;
  const lw = Math.max(1.5, pitch * 0.07);
  const A = cellOf(grid, m.a), B = cellOf(grid, m.b);
  if (m.kind === 'typo') {
    let d = '';
    for (let l = m.a; l <= m.b; l++) {
      const { cell: c } = cellOf(grid, l);
      const w = c.x1 - c.x0, h = c.yb - c.yt;
      const ix = w * 0.16, iy = h * 0.16;
      d += `M${c.x0 + ix} ${c.yt + iy}L${c.x1 - ix} ${c.yb - iy}M${c.x1 - ix} ${c.yt + iy}L${c.x0 + ix} ${c.yb - iy}`;
    }
    out.push({ d, width: lw * 1.1 });
    return out;
  }
  // 按行分段画线
  for (let r = A.r; r <= B.r; r++) {
    const row = grid.rows[r];
    const c0 = r === A.r ? A.c : 0;
    const c1 = r === B.r ? B.c : row.cells.length - 1;
    const first = row.cells[c0], last = row.cells[c1];
    const h = first.yb - first.yt;
    const gap = rowGap(grid, r);
    const y = gap >= h * 0.12 ? first.yb + Math.min(gap * 0.5, h * 0.14) : first.yb - h * 0.08;
    const yEnd = last.yb + (y - first.yb);
    const x0 = first.x0 + (first.x1 - first.x0) * 0.08, x1 = last.x1 - (last.x1 - last.x0) * 0.08;
    if (m.kind === 'sentence') {
      const amp = Math.min(h * 0.07, Math.max(gap * 0.3, h * 0.05));
      const wl = pitch * 0.32;
      const steps = Math.max(1, Math.round((x1 - x0) / (wl / 2)));
      let d = `M${x0} ${y}`;
      for (let k = 1; k <= steps; k++) {
        const xa = x0 + ((x1 - x0) * (k - 0.5)) / steps, xb = x0 + ((x1 - x0) * k) / steps;
        const yy = y + ((yEnd - y) * k) / steps;
        d += `Q${xa} ${yy + (k % 2 ? -amp : amp) * 2} ${xb} ${yy}`;
      }
      out.push({ d, width: lw });
    } else {
      out.push({ d: `M${x0} ${y}L${x1} ${yEnd}`, width: lw * 0.7 });
    }
  }
  if (m.kind === 'good') {
    // √ 画在句末那一格的右上方
    const c = B.cell;
    const w = c.x1 - c.x0, h = c.yb - c.yt;
    const bx = c.x1 - w * 0.05, by = c.yt + h * 0.05;
    out.push({ d: `M${bx - w * 0.38} ${by + h * 0.12}L${bx - w * 0.22} ${by + h * 0.3}L${bx + w * 0.08} ${by - h * 0.18}`, width: lw * 1.1 });
  }
  return out;
}

/* ---------------- 网页里显示（可拖动调整） ---------------- */

export function annotationsHTML(ann) {
  const pages = ann.pages.filter((p) => p.grid);
  const warn = ann.warnings.length
    ? `<div class="annot-warn"><b>请核对：</b><ul>${ann.warnings.map((w) => `<li>${escapeHTML(w.text)}</li>`).join('')}</ul></div>`
    : '';
  const miss = ann.unplaced.length ? `<p class="muted small">没能在原图上标出：${ann.unplaced.map(escapeHTML).join('、')}（可在下方原文里查看）。</p>` : '';
  return `
    <div class="annot-head">
      <h3>原图批注</h3>
      <div class="row">
        <button type="button" class="btn ghost small-btn" data-annot="grid">显示格子</button>
        <button type="button" class="btn ghost small-btn" data-annot="download">下载批注图</button>
      </div>
    </div>
    <p class="muted small">符号画在检测到的格子上。如果某个符号偏了，可以直接拖到正确的格子；病句、佳句的两端圆点可以拖动调整范围。</p>
    ${warn}${miss}
    <div class="annot-pages">${pages.map((p) => `<figure class="annot-page" data-page="${ann.pages.indexOf(p)}"></figure>`).join('')}</div>`;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function drawPageSVG(fig, page, ann, opts) {
  const { grid } = page;
  const W = grid.W / grid.f, H = grid.H / grid.f;
  fig.innerHTML = '';
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'annot-svg' });
  svg.appendChild(svgEl('image', { href: page.dataUrl, x: 0, y: 0, width: W, height: H }));
  const g = svgEl('g', { transform: svgTransform(grid) });
  svg.appendChild(g);
  if (opts.showGrid) {
    const gg = svgEl('g', { class: 'annot-grid' });
    for (const row of grid.rows) for (const c of row.cells) gg.appendChild(svgEl('rect', { x: c.x0, y: c.yt, width: c.x1 - c.x0, height: c.yb - c.yt }));
    g.appendChild(gg);
  }
  const pi = ann.pages.indexOf(page);
  for (const w of ann.warnings.filter((w) => w.page === pi)) {
    const c = grid.rows[w.row].cells[0];
    g.appendChild(svgEl('rect', { class: 'annot-rowwarn', x: c.x0 - grid.pitch * 0.35, y: c.yt, width: grid.pitch * 0.22, height: c.yb - c.yt }));
  }
  page.marks.forEach((m, mi) => {
    const mg = svgEl('g', { class: `annot-mark k-${m.kind}`, 'data-mi': mi });
    for (const p of markPaths(grid, m)) mg.appendChild(svgEl('path', { d: p.d, 'stroke-width': p.width, stroke: RED, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    // 透明的大块区域，方便手指按住拖动
    for (let l = m.a; l <= m.b; l++) {
      const { cell: c } = cellOf(grid, l);
      mg.appendChild(svgEl('rect', { class: 'hit', x: c.x0, y: c.yt, width: c.x1 - c.x0, height: c.yb - c.yt + grid.pitch * 0.2 }));
    }
    if (m.kind !== 'typo') {
      for (const [end, l] of [['a', m.a], ['b', m.b]]) {
        const { cell: c } = cellOf(grid, l);
        mg.appendChild(svgEl('circle', { class: 'handle', 'data-end': end, cx: end === 'a' ? c.x0 : c.x1, cy: c.yb, r: grid.pitch * 0.13 }));
      }
    }
    g.appendChild(mg);
  });
  fig.appendChild(svg);
  return { svg, g };
}

// 把指针位置换算成格子编号
function linAt(grid, g, ev) {
  const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(g.getScreenCTM().inverse());
  let best = 0, bd = Infinity, l = 0;
  for (const row of grid.rows) {
    for (const c of row.cells) {
      const d = Math.hypot((c.x0 + c.x1) / 2 - pt.x, (c.yt + c.yb) / 2 - pt.y);
      if (d < bd) { bd = d; best = l; }
      l++;
    }
  }
  return best;
}

export function mountAnnotations(el, entry) {
  let ann = entry._annot;
  if (!ann) {
    ann = computeAnnotations(entry);
    if (!ann || !ann.pages.some((p) => p.grid)) {
      el.hidden = true;
      return;
    }
    entry._annot = ann;
  }
  el.hidden = false;
  el.innerHTML = annotationsHTML(ann);
  const opts = { showGrid: false };
  const total = (grid) => grid.rows.reduce((t, r) => t + r.cells.length, 0);
  const render = () =>
    el.querySelectorAll('.annot-page').forEach((fig) => {
      const page = ann.pages[Number(fig.dataset.page)];
      const { g } = drawPageSVG(fig, page, ann, opts);
      fig._g = g;
    });
  render();

  let drag = null;
  el.addEventListener('pointerdown', (ev) => {
    const mg = ev.target.closest('.annot-mark');
    const fig = ev.target.closest('.annot-page');
    if (!mg || !fig) return;
    const page = ann.pages[Number(fig.dataset.page)];
    const m = page.marks[Number(mg.dataset.mi)];
    ev.preventDefault();
    const start = linAt(page.grid, fig._g, ev);
    drag = { page, m, fig, mg, start, end: ev.target.dataset.end || null, orig: { a: m.a, b: m.b }, x: ev.clientX, y: ev.clientY };
    mg.classList.add('dragging');
    el.setPointerCapture?.(ev.pointerId);
  });
  el.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const { page, m, fig, start, orig, end } = drag;
    const now = linAt(page.grid, fig._g, ev);
    const max = total(page.grid) - 1;
    if (end === 'a') m.a = Math.max(0, Math.min(orig.b, orig.a + now - start));
    else if (end === 'b') m.b = Math.min(max, Math.max(orig.a, orig.b + now - start));
    else {
      const d = Math.max(-orig.a, Math.min(max - orig.b, now - start));
      m.a = orig.a + d;
      m.b = orig.b + d;
    }
    if (m.a !== drag.la || m.b !== drag.lb) {
      drag.la = m.a;
      drag.lb = m.b;
      const { g } = drawPageSVG(fig, page, ann, opts);
      fig._g = g;
    }
  });
  const stop = () => { drag = null; };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);

  el.querySelector('[data-annot="grid"]').addEventListener('click', (ev) => {
    opts.showGrid = !opts.showGrid;
    ev.target.textContent = opts.showGrid ? '隐藏格子' : '显示格子';
    render();
  });
  el.querySelector('[data-annot="download"]').addEventListener('click', () => downloadAnnotated(entry, ann));
}

/* ---------------- 导出图片 ---------------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}

// 每页一张图；最后一页下面附上各项得分和总评
export async function renderAnnotatedPages(entry, ann) {
  const pages = ann.pages.filter((p) => p.grid);
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const img = await loadImage(page.dataUrl);
    const W = img.naturalWidth, H = img.naturalHeight;
    const isLast = i === pages.length - 1;
    const font = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif';
    const fs = Math.round(W / 42);
    let summary = [];
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = `${fs}px ${font}`;
    if (isLast) {
      const r = entry.result;
      const pad = fs * 1.5;
      summary.push({ t: `总分：${r.total} / ${r.max}${r.level ? `　等级：${r.level}` : ''}${r.topic && r.topic !== '切题' ? `　（${r.topic}）` : ''}`, bold: true, size: 1.25 });
      for (const s of r.scores) summary.push(...wrapLines(meas, `${s.name}：${s.score} / ${s.max}　${s.comment || ''}`, W - pad * 2).map((t) => ({ t })));
      summary.push({ t: '' });
      summary.push({ t: '总评：', bold: true });
      summary.push(...wrapLines(meas, r.comment || '', W - pad * 2).map((t) => ({ t })));
      if (r.typos?.length) {
        summary.push({ t: '' });
        summary.push(...wrapLines(meas, `错别字：${r.typos.map((t) => `${t.wrong}→${t.correct}`).join('　')}`, W - pad * 2).map((t) => ({ t })));
      }
    }
    const lineH = fs * 1.6;
    const extra = isLast ? Math.ceil(summary.reduce((t, l) => t + lineH * (l.size || 1), 0) + fs * 3) : 0;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H + extra;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, W, H);
    ctx.save();
    applyPageTransform(ctx, page.grid);
    ctx.strokeStyle = RED;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const m of page.marks) {
      for (const p of markPaths(page.grid, m)) {
        ctx.lineWidth = p.width;
        ctx.stroke(new Path2D(p.d));
      }
    }
    ctx.restore();
    if (isLast) {
      const pad = fs * 1.5;
      ctx.strokeStyle = '#ccc';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad, H + fs * 0.8);
      ctx.lineTo(W - pad, H + fs * 0.8);
      ctx.stroke();
      let y = H + fs * 1.5;
      ctx.textBaseline = 'top';
      for (const l of summary) {
        const size = Math.round(fs * (l.size || 1));
        ctx.font = `${l.bold ? 'bold ' : ''}${size}px ${font}`;
        ctx.fillStyle = l.bold ? RED : '#222';
        ctx.fillText(l.t, pad, y);
        y += lineH * (l.size || 1);
      }
    }
    out.push(c);
  }
  return out;
}

async function downloadAnnotated(entry, ann) {
  const canvases = await renderAnnotatedPages(entry, ann);
  const base = (entry.student || entry.title || '作文').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  canvases.forEach((c, i) => {
    const a = document.createElement('a');
    a.href = c.toDataURL('image/jpeg', 0.9);
    a.download = `${base}-批注${canvases.length > 1 ? `-第${i + 1}页` : ''}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}
