// 批量批改：一个文件一篇作文，可多选或上传 zip。
// 上传后自动识别；点「全部开始批改」后开始批改。同时最多处理 2 个请求，避免触发接口频率限制。
import { RUBRICS, cloneItems, rubricForGrade } from './rubrics.js';
import { splitTitle, textStats, escapeHTML } from './analyze.js';
import {
  prepareImage, pdfToImages, isPDF, isImage, isZip,
  ocrPages, markEssay, buildMeta, makeLimiter, saveHistory,
} from './core.js';
import { mountResult, reportText } from './result.js';

const $ = (sel) => document.querySelector(sel);
const CONCURRENCY = 2;

let ctx; // { getSettings, toast }
const essays = [];
const limit = makeLimiter(CONCURRENCY);
let markAllRequested = false;
let nextId = 1;
let openId = null; // 当前打开详情的作文

/* ---------------- 读取文件 ---------------- */

const baseName = (n) => n.split('/').pop().replace(/\.[^.]+$/, '');
const natural = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });

// zip 里的中文文件名：没有 UTF-8 标记时 fflate 按 latin1 解码，这里还原成字节后按 UTF-8 / GBK 重新解码
function fixZipName(name) {
  if (![...name].some((c) => c.charCodeAt(0) > 0x7f) || [...name].some((c) => c.charCodeAt(0) > 0xff)) return name;
  const bytes = Uint8Array.from([...name].map((c) => c.charCodeAt(0)));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 不是 UTF-8 */ }
  try { return new TextDecoder('gbk').decode(bytes); } catch { return name; }
}

const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };

async function unzip(file) {
  const { unzipSync } = await import('./vendor/fflate/fflate.js');
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const out = [];
  for (const [rawName, data] of Object.entries(entries)) {
    const name = fixZipName(rawName);
    const base = name.split('/').pop();
    if (!base || base.startsWith('.') || name.includes('__MACOSX/') || !data.length) continue;
    const ext = (base.split('.').pop() || '').toLowerCase();
    if (!MIME[ext]) continue;
    out.push(new File([data], base, { type: MIME[ext] }));
  }
  return out;
}

async function addFiles(fileList) {
  const status = $('#b-status');
  let files = [];
  for (const f of fileList) {
    if (isZip(f)) {
      try {
        status.textContent = `正在解压 ${f.name}…`;
        files.push(...(await unzip(f)));
      } catch (e) {
        console.error(e);
        ctx.toast(`无法解压：${f.name}`, 4000);
      }
    } else if (isPDF(f) || isImage(f)) {
      files.push(f);
    }
  }
  status.textContent = '';
  if (!files.length) return ctx.toast('没有找到图片或 PDF 文件');
  files = files.sort(natural);
  for (const f of files) {
    const e = {
      id: nextId++,
      fileName: f.name,
      name: baseName(f.name),
      nameEdited: false,
      file: f,
      images: null,
      ocr: { state: 'wait', text: '', progress: 0, label: '排队中', error: '' },
      mark: { state: 'idle', progress: 0, result: null, entry: null, error: '', raw: '', truncated: false },
    };
    essays.push(e);
    appendRow(e);
    startOCR(e);
  }
  updateToolbar();
}

/* ---------------- 识别 ---------------- */

function startOCR(e) {
  e.ocr = { state: 'wait', text: '', progress: 0, label: '排队中', error: '' };
  updateRow(e);
  limit(() => runOCR(e));
}

async function runOCR(e) {
  if (!essays.includes(e)) return;
  e.ocr.state = 'run';
  e.ocr.label = '读取文件…';
  updateRow(e);
  try {
    if (!e.images) {
      e.images = isPDF(e.file) ? await pdfToImages(e.file, (m) => ctx.toast(m, 4000)) : [await prepareImage(e.file)];
    }
    const n = e.images.length;
    const { text, layout } = await ocrPages({
      settings: ctx.getSettings(),
      images: e.images,
      onProgress: ({ text, page, pageChars }) => {
        e.ocr.text = text;
        e.ocr.progress = Math.min(0.97, (Math.min(page, n) + Math.min(0.9, pageChars / 500)) / n);
        e.ocr.label = n > 1 ? `识别中 第 ${Math.min(page + 1, n)}/${n} 页` : `识别中 ${text.replace(/\s/g, '').length} 字`;
        updateRow(e);
        if (openId === e.id) refreshDialog();
      },
    });
    e.ocr.text = text;
    e.layout = layout;
    e.ocr.state = 'done';
    e.ocr.progress = 1;
    const { student, body } = splitTitle(text);
    e.ocr.label = `已识别 ${textStats(body).hanzi} 字`;
    if (student && !e.nameEdited) e.name = student;
    updateRow(e, true);
    if (markAllRequested && e.mark.state === 'idle') startMark(e);
  } catch (err) {
    console.error(err);
    e.ocr.state = 'err';
    e.ocr.text = err.partialText || e.ocr.text;
    e.ocr.error = err.message || String(err);
    e.ocr.label = '识别失败，点击查看';
    updateRow(e);
  }
  if (openId === e.id) refreshDialog();
  updateToolbar();
}

/* ---------------- 批改 ---------------- */

function batchFields() {
  const grade = $('#b-grade').value;
  const key = rubricForGrade(grade);
  return {
    grade,
    style: $('#b-style').value,
    minWords: Number($('#b-min-words').value) || 0,
    title: $('#b-title').value.trim(),
    requirement: $('#b-requirement').value.trim(),
    rubric: cloneItems(key),
    guide: RUBRICS[key].guide,
    caps: RUBRICS[key].caps || {},
  };
}

function startMark(e) {
  if (e.ocr.state !== 'done') return;
  e.mark = { state: 'queued', progress: 0, result: null, entry: null, error: '', raw: '', truncated: false };
  updateRow(e);
  limit(() => runMark(e));
}

async function runMark(e) {
  if (!essays.includes(e)) return;
  const { student, title, body } = splitTitle(e.ocr.text);
  const stats = textStats(body);
  if (stats.hanzi < 20) {
    e.mark.state = 'err';
    e.mark.error = '原文太短，无法批改。';
    updateRow(e);
    return;
  }
  const fields = batchFields();
  const settings = ctx.getSettings();
  const meta = buildMeta(settings, { ...fields, title: fields.title || title, student: e.name || student });
  e.mark.state = 'run';
  updateRow(e);
  try {
    const { result, truncated } = await markEssay({
      settings,
      body,
      meta,
      stats,
      onProgress: ({ chars, attempt }) => {
        e.mark.progress = Math.min(0.97, chars / 1800);
        e.mark.attempt = attempt;
        updateRow(e);
      },
    });
    e.mark.state = 'done';
    e.mark.progress = 1;
    e.mark.result = result;
    e.mark.truncated = truncated;
    e.mark.entry = { body, title: meta.title, student: e.name, result, meta, stats, _layout: e.layout, _text: e.ocr.text };
    saveHistory(e.mark.entry);
  } catch (err) {
    console.error(err);
    e.mark.state = 'err';
    e.mark.error = err.message || String(err);
    e.mark.raw = err.raw || '';
  }
  updateRow(e);
  if (openId === e.id) refreshDialog();
  updateToolbar();
}

/* ---------------- 列表 ---------------- */

function appendRow(e) {
  const li = document.createElement('li');
  li.className = 'b-row';
  li.dataset.id = e.id;
  li.innerHTML = `
    <span class="b-no"></span>
    <div class="b-name">
      <input type="text" aria-label="学生姓名" value="${escapeHTML(e.name)}">
      <small class="muted" title="${escapeHTML(e.fileName)}">${escapeHTML(e.fileName)}</small>
    </div>
    <div class="b-cell b-ocr">
      <button type="button" class="pbar" data-act="view-ocr"><span class="pfill"></span><span class="plabel"></span></button>
      <button type="button" class="btn ghost small-btn" data-act="save-text">保存文字</button>
    </div>
    <div class="b-cell b-mark">
      <button type="button" class="pbar mark" data-act="view-mark"><span class="pfill"></span><span class="plabel"></span></button>
      <span class="score-box"></span>
    </div>
    <button type="button" class="link danger b-del" data-act="remove" title="移除" aria-label="移除">✕</button>`;
  li.querySelector('input').addEventListener('input', (ev) => {
    e.name = ev.target.value;
    e.nameEdited = true;
    if (e.mark.entry) e.mark.entry.student = e.name;
  });
  $('#b-list').appendChild(li);
  renumber();
  updateRow(e);
}

function renumber() {
  [...$('#b-list').children].forEach((li, i) => (li.querySelector('.b-no').textContent = i + 1));
  $('#b-count').textContent = essays.length ? `共 ${essays.length} 篇` : '';
  $('#b-list-card').hidden = essays.length === 0;
}

function markLabel(m) {
  switch (m.state) {
    case 'idle': return '未开始';
    case 'queued': return '排队中';
    case 'run': return m.attempt > 1 ? '批改中（自动重试）' : '批改中';
    case 'done': return m.truncated ? '已完成（结果不完整）' : '已完成';
    case 'err': return '批改失败，点击查看';
    default: return '';
  }
}

function updateRow(e, nameChanged = false) {
  const li = document.querySelector(`.b-row[data-id="${e.id}"]`);
  if (!li) return;
  if (nameChanged) li.querySelector('input').value = e.name;
  const [ocrBar, markBar] = li.querySelectorAll('.pbar');
  ocrBar.className = `pbar ocr ${e.ocr.state}`;
  ocrBar.querySelector('.pfill').style.width = `${Math.round(e.ocr.progress * 100)}%`;
  ocrBar.querySelector('.plabel').textContent = e.ocr.label;
  li.querySelector('[data-act="save-text"]').disabled = e.ocr.state !== 'done';
  markBar.className = `pbar mark ${e.mark.state}`;
  markBar.querySelector('.pfill').style.width = `${Math.round(e.mark.progress * 100)}%`;
  markBar.querySelector('.plabel').textContent = markLabel(e.mark);
  const box = li.querySelector('.score-box');
  const r = e.mark.result;
  box.className = `score-box${r ? ' done' : ''}`;
  box.textContent = r ? `${r.total}/${r.max}` : '';
  box.title = r ? `${r.level ? `等级：${r.level}` : ''}` : '批改完成后显示分数';
}

function updateToolbar() {
  const pending = essays.filter((e) => e.mark.state === 'idle' || e.mark.state === 'err').length;
  const btn = $('#b-mark-all');
  btn.textContent = pending && markAllRequested ? `开始批改（${pending} 篇未完成）` : '全部开始批改';
  const anyDone = essays.some((e) => e.mark.result);
  $('#b-export').disabled = !anyDone;
  $('#b-export-reports').disabled = !anyDone;
}

function removeEssay(e) {
  const i = essays.indexOf(e);
  if (i !== -1) essays.splice(i, 1);
  document.querySelector(`.b-row[data-id="${e.id}"]`)?.remove();
  renumber();
  updateToolbar();
}

/* ---------------- 详情弹窗 ---------------- */

function openDialog(e) {
  openId = e.id;
  refreshDialog(true);
  const dlg = $('#dlg-essay');
  if (!dlg.open) dlg.showModal();
}

function refreshDialog(first = false) {
  const e = essays.find((x) => x.id === openId);
  if (!e) return;
  $('#e-title').textContent = e.name || e.fileName;
  const ta = $('#e-text');
  const ocrRunning = e.ocr.state === 'wait' || e.ocr.state === 'run';
  // 用户正在编辑时不要覆盖
  if (first || ocrRunning || document.activeElement !== ta) ta.value = e.ocr.text;
  ta.readOnly = ocrRunning;
  const { body } = splitTitle(ta.value);
  const s = textStats(body);
  $('#e-stats').innerHTML = `<span>汉字 <b>${s.hanzi}</b></span><span>段落 <b>${s.paragraphs}</b></span><span>${escapeHTML(e.fileName)}</span>`;

  const status = $('#e-status');
  let msg = '';
  let kind = '';
  if (e.ocr.state === 'err') [msg, kind] = [`识别失败：${e.ocr.error}`, 'err'];
  else if (ocrRunning) [msg, kind] = [e.ocr.state === 'wait' ? '排队等待识别…' : e.ocr.label.replace(/…$/, "") + "…", 'busy'];
  else if (e.mark.state === 'err') [msg, kind] = [`批改失败：${e.mark.error}`, 'err'];
  else if (e.mark.state === 'queued') [msg, kind] = ['排队等待批改…', 'busy'];
  else if (e.mark.state === 'run') [msg, kind] = ['正在批改…', 'busy'];
  else if (e.mark.state === 'done' && e.mark.truncated) [msg, kind] = ['结果被截断，部分内容可能缺失，可以重新批改。', 'err'];
  status.textContent = msg;
  status.className = `status ${kind}`;

  const resEl = $('#e-result');
  if (e.mark.entry && (first || resEl._entry !== e.mark.entry)) mountResult(resEl, e.mark.entry);
  if (!e.mark.entry) {
    resEl.innerHTML = '';
    resEl._entry = null;
  }
  $('#e-text-wrap').open = !e.mark.entry || first === 'text';
  const raw = $('#e-raw');
  raw.hidden = !e.mark.raw;
  raw.querySelector('pre').textContent = e.mark.raw || '';

  $('#e-reocr').disabled = ocrRunning;
  $('#e-save').disabled = ocrRunning;
  $('#e-copy').hidden = !e.mark.entry;
  $('#e-mark').disabled = e.ocr.state !== 'done' || e.mark.state === 'queued' || e.mark.state === 'run';
  $('#e-mark').textContent = e.mark.result ? '重新批改' : '批改这一篇';
}

function saveDialogText() {
  const e = essays.find((x) => x.id === openId);
  if (!e || e.ocr.state === 'wait' || e.ocr.state === 'run') return false;
  const v = $('#e-text').value;
  if (v === e.ocr.text) return false;
  e.ocr.text = v;
  if (e.ocr.state === 'err' && v.trim()) e.ocr.state = 'done';
  e.ocr.progress = e.ocr.state === 'done' ? 1 : e.ocr.progress;
  const { student, body } = splitTitle(v);
  if (e.ocr.state === 'done') e.ocr.label = `已识别 ${textStats(body).hanzi} 字`;
  if (student && !e.nameEdited) e.name = student;
  updateRow(e, true);
  return true;
}

/* ---------------- 导出 ---------------- */

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

const safeFile = (s) => String(s || '作文').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportScores() {
  const done = essays.filter((e) => e.mark.result);
  if (!done.length) return;
  const dims = [];
  done.forEach((e) => e.mark.result.scores.forEach((s) => dims.includes(s.name) || dims.push(s.name)));
  const header = ['序号', '学生', '文件', ...dims, '总分', '满分', '等级', '切题情况', '汉字数', '错别字', '文句问题', '总评'];
  const rows = essays.map((e, i) => {
    const r = e.mark.result;
    if (!r) return [i + 1, e.name, e.fileName, ...dims.map(() => ''), '', '', '', '', '', '', '', e.mark.state === 'err' ? '批改失败' : '未批改'];
    const st = e.mark.entry.stats;
    return [
      i + 1, e.name, e.fileName,
      ...dims.map((d) => r.scores.find((s) => s.name === d)?.score ?? ''),
      r.total, r.max, r.level, r.topic, st.hanzi, r.typos.length, r.sentences.length, r.comment,
    ];
  });
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  // 加 BOM，Excel 打开中文不乱码
  download(`成绩表-${stamp()}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

function exportReports() {
  const parts = essays
    .filter((e) => e.mark.entry)
    .map((e) => `========== ${e.name || e.fileName} ==========\n${reportText({ ...e.mark.entry, title: e.mark.entry.title })}\n`);
  if (!parts.length) return;
  download(`批改报告-${stamp()}.txt`, '﻿' + parts.join('\n'), 'text/plain;charset=utf-8');
}

/* ---------------- 初始化 ---------------- */

function showRubric() {
  const key = rubricForGrade($('#b-grade').value);
  $('#b-rubric-label').textContent = RUBRICS[key].label;
  $('#b-rubric-guide').textContent = RUBRICS[key].guide;
}

export function initBatch(context) {
  ctx = context;
  showRubric();
  $('#b-grade').addEventListener('change', showRubric);

  const input = $('#b-file-input');
  const dz = $('#b-dropzone');
  input.addEventListener('change', () => {
    addFiles([...input.files]);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) =>
    dz.addEventListener(t, (ev) => {
      ev.preventDefault();
      dz.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));
  dz.addEventListener('drop', (ev) => {
    ev.preventDefault();
    addFiles([...ev.dataTransfer.files]);
  });

  $('#b-list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const e = essays.find((x) => String(x.id) === btn.closest('.b-row').dataset.id);
    if (!e) return;
    const act = btn.dataset.act;
    if (act === 'view-ocr') {
      openDialog(e);
      $('#e-text-wrap').open = true;
      $('#e-text-wrap').scrollIntoView({ block: 'nearest' });
    } else if (act === 'view-mark') {
      openDialog(e);
    } else if (act === 'save-text') {
      download(`${safeFile(e.name || baseName(e.fileName))}.txt`, '﻿' + e.ocr.text, 'text/plain;charset=utf-8');
    } else if (act === 'remove') {
      const busy = e.ocr.state === 'run' || e.mark.state === 'run';
      if (busy) return ctx.toast('这篇正在处理中，完成后再移除');
      removeEssay(e);
    }
  });

  $('#b-mark-all').addEventListener('click', () => {
    if (!ctx.getSettings().apiKey) return ctx.toast('请先在「设置」里填写 Key 或访问口令');
    markAllRequested = true;
    let n = 0;
    essays.forEach((e) => {
      if (e.ocr.state === 'done' && (e.mark.state === 'idle' || e.mark.state === 'err')) {
        startMark(e);
        n++;
      }
    });
    const waiting = essays.filter((e) => e.ocr.state === 'wait' || e.ocr.state === 'run').length;
    ctx.toast(`已开始批改 ${n} 篇${waiting ? `，另有 ${waiting} 篇识别完后自动批改` : ''}（同时处理 ${CONCURRENCY} 个）`, 3500);
    updateToolbar();
  });
  $('#b-export').addEventListener('click', exportScores);
  $('#b-export-reports').addEventListener('click', exportReports);
  $('#b-clear').addEventListener('click', () => {
    if (essays.some((e) => e.ocr.state === 'run' || e.mark.state === 'run')) return ctx.toast('还有作文在处理中，请稍后再清空');
    if (essays.some((e) => e.mark.result) && !window.confirm('确定清空列表吗？已批改的结果在「历史记录」里还能找到。')) return;
    essays.splice(0).forEach((e) => document.querySelector(`.b-row[data-id="${e.id}"]`)?.remove());
    markAllRequested = false;
    renumber();
    updateToolbar();
  });

  // 详情弹窗
  const dlg = $('#dlg-essay');
  $('#e-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => {
    saveDialogText();
    openId = null;
  });
  $('#e-text').addEventListener('input', () => {
    const { body } = splitTitle($('#e-text').value);
    const s = textStats(body);
    $('#e-stats').querySelector('b').textContent = s.hanzi;
  });
  $('#e-save').addEventListener('click', () => {
    if (saveDialogText()) ctx.toast('已保存修改');
    refreshDialog();
  });
  $('#e-reocr').addEventListener('click', () => {
    const e = essays.find((x) => x.id === openId);
    if (!e) return;
    startOCR(e);
    refreshDialog(true);
  });
  $('#e-mark').addEventListener('click', () => {
    const e = essays.find((x) => x.id === openId);
    if (!e) return;
    saveDialogText();
    startMark(e);
    refreshDialog();
  });
  $('#e-copy').addEventListener('click', async () => {
    const e = essays.find((x) => x.id === openId);
    if (!e?.mark.entry) return;
    try {
      await navigator.clipboard.writeText(reportText(e.mark.entry));
      ctx.toast('报告已复制');
    } catch {
      ctx.toast('复制失败，请手动选择文字复制');
    }
  });

  window.addEventListener('beforeunload', (ev) => {
    if (essays.some((e) => ['wait', 'run'].includes(e.ocr.state) || ['queued', 'run'].includes(e.mark.state))) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
  updateToolbar();
}
