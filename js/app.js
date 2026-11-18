import { PROVIDERS, loadSettings, saveSettings, settingsFor, clearAllKeys } from './config.js';
import { chat, extractJSON } from './providers.js';
import { RUBRICS, DEFAULT_RUBRIC, cloneItems, rubricForGrade } from './rubrics.js';
import { OCR_SYSTEM, ocrUserText, MARK_SYSTEM, markUserText } from './prompts.js';
import { splitTitle, textStats, findMarks, renderMarked, escapeHTML } from './analyze.js';

const $ = (sel) => document.querySelector(sel);
const HISTORY_KEY = 'compomarker.history.v1';
const MAX_IMAGE_SIDE = 2000;

const state = {
  settings: loadSettings(),
  images: [],
  rubricKey: DEFAULT_RUBRIC,
  rubric: cloneItems(DEFAULT_RUBRIC),
  last: null, // { body, title, result, meta }
};

/* ---------------- 通用 ---------------- */

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function setStatus(el, msg, kind = '') {
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function show(id) {
  const el = $(id);
  el.hidden = false;
  return el;
}

function updateBanner() {
  $('#key-banner').hidden = !!state.settings.apiKey;
}

/* ---------------- 设置 ---------------- */

function fillSettingsForm(provider) {
  const s = provider === state.settings.provider ? state.settings : { ...settingsFor(provider, state.settings) };
  $('#s-provider').value = provider;
  $('#s-key').value = s.apiKey || '';
  $('#s-base').value = s.baseURL || '';
  $('#s-vision').value = s.visionModel || '';
  $('#s-text').value = s.textModel || '';
  $('#s-key-hint').textContent = PROVIDERS[provider].keyHint;
  const p = PROVIDERS[provider];
  const isWorker = provider === 'worker';
  $('#s-cf-wrap').hidden = !isWorker;
  $('#s-base-wrap').hidden = isWorker;
  $('#s-key-label').textContent = isWorker ? '访问口令' : 'API Key';
  $('#s-key').placeholder = isWorker ? 'Worker 里设置的 ACCESS_CODE' : '';
  $('#s-cf-user').value = isWorker ? cfUserFromURL(s.baseURL) : '';
  $('#s-base').placeholder = p.baseURL || (p.kind === 'anthropic' ? '使用官方地址' : '必填');
  // 自定义接口需要手填地址时自动展开高级设置
  if (!isWorker && !s.baseURL && p.kind === 'openai') document.querySelector('#dlg-settings details').open = true;
}

const CF_PREFIX = 'https://compomarker.';
const CF_SUFFIX = '.workers.dev/qwen-intl';

function cfUserFromURL(url) {
  const m = String(url || '').match(/^https:\/\/compomarker\.([^/]+?)\.workers\.dev/i);
  return m ? m[1] : '';
}

function cfURL(user) {
  const u = user.trim().replace(/^https?:\/\//, '').replace(/^compomarker\./, '').replace(/\.workers\.dev.*$/, '');
  return u ? `${CF_PREFIX}${u}${CF_SUFFIX}` : '';
}

function initSettings() {
  const sel = $('#s-provider');
  sel.innerHTML = Object.entries(PROVIDERS)
    .map(([k, p]) => `<option value="${k}">${escapeHTML(p.name)}</option>`)
    .join('');
  sel.addEventListener('change', () => fillSettingsForm(sel.value));
  $('#s-reset').addEventListener('click', () => {
    const p = PROVIDERS[sel.value];
    $('#s-base').value = p.baseURL;
    $('#s-vision').value = p.visionModel;
    $('#s-text').value = p.textModel;
  });
  $('#s-clear').addEventListener('click', () => {
    clearAllKeys();
    state.settings = loadSettings();
    fillSettingsForm(sel.value);
    updateBanner();
    toast('已清除本机保存的所有 Key');
  });
  const dlg = $('#dlg-settings');
  const open = () => {
    fillSettingsForm(state.settings.provider);
    $('#s-remember').checked = state.settings.rememberKey;
    dlg.showModal();
  };
  $('#btn-settings').addEventListener('click', open);
  $('#banner-settings').addEventListener('click', open);

  const guide = $('#dlg-guide');
  const openGuide = () => guide.showModal();
  $('#btn-guide').addEventListener('click', openGuide);
  $('#banner-guide').addEventListener('click', openGuide);
  $('#g-close').addEventListener('click', () => guide.close());
  $('#g-settings').addEventListener('click', () => {
    guide.close();
    if (!dlg.open) open();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    state.settings = saveSettings({
      provider: sel.value,
      rememberKey: $('#s-remember').checked,
      baseURL: sel.value === 'worker' ? cfURL($('#s-cf-user').value) : $('#s-base').value.trim(),
      visionModel: $('#s-vision').value.trim(),
      textModel: $('#s-text').value.trim(),
      apiKey: $('#s-key').value.trim(),
      overrides: state.settings.overrides,
    });
    updateBanner();
    toast(`已保存：${PROVIDERS[state.settings.provider].name}`);
  });
}

/* ---------------- 第一步：图片 ---------------- */

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

function canvasToImage(canvas, name) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { name, dataUrl, mediaType: 'image/jpeg', data: dataUrl.split(',')[1] };
}

// 压缩到长边不超过 MAX_IMAGE_SIDE，统一转 JPEG，减小上传体积
async function prepareImage(file) {
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

const MAX_PDF_PAGES = 10;
let pdfjsLib = null;

// PDF 每一页渲染成一张图片（扫描件、手机扫描 App 导出的 PDF 都可以）
async function pdfToImages(file) {
  if (!pdfjsLib) {
    pdfjsLib = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const count = Math.min(doc.numPages, MAX_PDF_PAGES);
  if (doc.numPages > MAX_PDF_PAGES) toast(`PDF 共 ${doc.numPages} 页，只取前 ${MAX_PDF_PAGES} 页`, 4000);
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

const isPDF = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || isPDF(f));
  if (!list.length) return toast('请选择图片或 PDF 文件');
  const status = $('#ocr-status');
  for (const f of list) {
    try {
      if (isPDF(f)) {
        setStatus(status, `正在读取 PDF：${f.name}…`, 'busy');
        state.images.push(...(await pdfToImages(f)));
        setStatus(status, '');
      } else {
        state.images.push(await prepareImage(f));
      }
    } catch (e) {
      setStatus(status, '');
      toast(isPDF(f) ? `无法读取 PDF：${f.name}（文件可能已加密或损坏）` : `无法读取图片：${f.name}（HEIC 格式请先转成 JPG）`, 4000);
      console.error(e);
    }
    renderThumbs();
  }
}

function renderThumbs() {
  const ul = $('#thumbs');
  ul.innerHTML = state.images
    .map(
      (img, i) => `<li>
        <img src="${img.dataUrl}" alt="第 ${i + 1} 页">
        <span class="page">第 ${i + 1} 页</span>
        <div class="thumb-actions">
          ${i > 0 ? `<button type="button" data-act="left" data-i="${i}" title="前移">←</button>` : ''}
          <button type="button" data-act="del" data-i="${i}" title="删除">✕</button>
        </div>
      </li>`
    )
    .join('');
  $('#btn-ocr').disabled = state.images.length === 0;
}

function initUpload() {
  const input = $('#file-input');
  const dz = $('#dropzone');
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((e) =>
    dz.addEventListener(e, (ev) => {
      ev.preventDefault();
      dz.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((e) => dz.addEventListener(e, () => dz.classList.remove('over')));
  dz.addEventListener('drop', (ev) => {
    ev.preventDefault();
    addFiles(ev.dataTransfer.files);
  });
  $('#thumbs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const i = Number(b.dataset.i);
    if (b.dataset.act === 'del') state.images.splice(i, 1);
    if (b.dataset.act === 'left') [state.images[i - 1], state.images[i]] = [state.images[i], state.images[i - 1]];
    renderThumbs();
  });
  $('#btn-ocr').addEventListener('click', runOCR);
  $('#btn-skip-ocr').addEventListener('click', () => {
    showTextSteps();
    $('#essay-text').focus();
  });
}

function showTextSteps() {
  show('#step-text');
  show('#step-config');
  updateStats();
}

async function runOCR() {
  const btn = $('#btn-ocr');
  const status = $('#ocr-status');
  btn.disabled = true;
  setStatus(status, `正在识别 ${state.images.length} 张图片，通常需要 10～40 秒…`, 'busy');
  try {
    const text = await chat({
      settings: state.settings,
      model: state.settings.visionModel,
      system: OCR_SYSTEM,
      text: ocrUserText(state.images.length),
      images: state.images,
    });
    $('#essay-text').value = text.trim();
    showTextSteps();
    setStatus(status, '识别完成，请在下方核对原文。', 'ok');
    $('#step-text').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setStatus(status, e.message || String(e), 'err');
  } finally {
    btn.disabled = state.images.length === 0;
  }
}

/* ---------------- 第二步：原文统计 ---------------- */

function updateStats() {
  const { title, body } = splitTitle($('#essay-text').value);
  const s = textStats(body);
  const min = Number($('#min-words').value) || 0;
  const short = min && s.hanzi < min;
  $('#stats').innerHTML = `
    ${title ? `<span>标题：<b>${escapeHTML(title)}</b></span>` : ''}
    <span class="${short ? 'warn' : ''}">汉字 <b>${s.hanzi}</b>${short ? `（少于要求的 ${min} 字）` : ''}</span>
    <span>总字符 <b>${s.chars}</b></span>
    <span>段落 <b>${s.paragraphs}</b></span>
    <span>句子 <b>${s.sentences}</b></span>
    <span>平均句长 <b>${s.avgSentence}</b> 字</span>`;
}

/* ---------------- 第三步：评分标准 ---------------- */

function renderRubric() {
  const tbody = $('#rubric-table tbody');
  tbody.innerHTML = state.rubric
    .map(
      (r, i) => `<tr data-i="${i}">
        <td><input data-f="name" value="${escapeHTML(r.name)}" aria-label="维度"></td>
        <td class="num"><input data-f="max" type="number" min="0" value="${r.max}" aria-label="满分"></td>
        <td><input data-f="desc" value="${escapeHTML(r.desc)}" aria-label="评分要点"></td>
        <td><button type="button" class="link danger" data-del="${i}" title="删除" aria-label="删除">✕</button></td>
      </tr>`
    )
    .join('');
  updateRubricTotal();
}

function updateRubricTotal() {
  const total = state.rubric.reduce((s, r) => s + (Number(r.max) || 0), 0);
  $('#rubric-total').textContent = `共 ${total} 分`;
}

function applyPreset(key) {
  state.rubricKey = key;
  state.rubric = cloneItems(key);
  $('#rubric-preset').value = key;
  $('#rubric-guide').value = RUBRICS[key].guide;
  renderRubric();
}

function initRubric() {
  const sel = $('#rubric-preset');
  sel.innerHTML = Object.entries(RUBRICS)
    .map(([k, r]) => `<option value="${k}">${escapeHTML(r.label)}</option>`)
    .join('');
  sel.addEventListener('change', () => applyPreset(sel.value));
  $('#grade').addEventListener('change', () => applyPreset(rubricForGrade($('#grade').value)));
  const table = $('#rubric-table');
  table.addEventListener('input', (ev) => {
    const tr = ev.target.closest('tr[data-i]');
    if (!tr) return;
    const f = ev.target.dataset.f;
    state.rubric[Number(tr.dataset.i)][f] = f === 'max' ? Number(ev.target.value) || 0 : ev.target.value;
    updateRubricTotal();
  });
  table.addEventListener('click', (ev) => {
    const del = ev.target.closest('[data-del]');
    if (!del) return;
    state.rubric.splice(Number(del.dataset.del), 1);
    renderRubric();
  });
  $('#rubric-add').addEventListener('click', () => {
    state.rubric.push({ name: '', max: 5, desc: '' });
    renderRubric();
  });
  applyPreset(rubricForGrade($('#grade').value));
}

/* ---------------- 批改 ---------------- */

async function runMark() {
  const raw = $('#essay-text').value.trim();
  const status = $('#mark-status');
  const { title: parsedTitle, body } = splitTitle(raw);
  if (textStats(body).hanzi < 20) return setStatus(status, '原文太短了，请先识别或粘贴作文。', 'err');
  const rubric = state.rubric.filter((r) => r.name.trim() && Number(r.max) > 0);
  if (!rubric.length) return setStatus(status, '请至少保留一个评分维度。', 'err');

  const meta = {
    title: $('#title').value.trim() || parsedTitle,
    requirement: $('#requirement').value.trim(),
    grade: $('#grade').value,
    minWords: Number($('#min-words').value) || 0,
    style: $('#style').value,
    rubric,
    guide: $('#rubric-guide').value.trim(),
    caps: RUBRICS[state.rubricKey]?.caps || {},
    provider: PROVIDERS[state.settings.provider].name,
    model: state.settings.textModel,
    time: Date.now(),
  };
  const stats = textStats(body);
  const btn = $('#btn-mark');
  btn.disabled = true;
  setStatus(status, '正在批改，通常需要 20～60 秒…', 'busy');
  try {
    const out = await chat({
      settings: state.settings,
      model: state.settings.textModel,
      system: MARK_SYSTEM,
      text: markUserText({ essay: body, stats, ...meta }),
    });
    const result = normalizeResult(extractJSON(out), rubric, meta.caps);
    state.last = { body, title: meta.title, result, meta, stats };
    renderResult();
    saveHistory(state.last);
    setStatus(status, '批改完成。', 'ok');
    $('#step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setStatus(status, e.message || String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

function normalizeResult(r, rubric, caps = {}) {
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

/* ---------------- 结果展示 ---------------- */

function renderResult() {
  const { body, title, result: r, meta, stats } = state.last;
  const marks = findMarks(body, r);
  const pct = r.max ? r.total / r.max : 0;
  const tone = pct >= 0.85 ? 'high' : pct >= 0.7 ? 'mid' : pct >= 0.6 ? 'low' : 'bad';
  const list = (items) => (items.length ? `<ul>${items.map((x) => `<li>${escapeHTML(x)}</li>`).join('')}</ul>` : '<p class="muted">无</p>');
  const notFound = (x) => (x._found ? '' : '<span class="nf" title="未能在原文中定位">未定位</span>');

  $('#result').innerHTML = `
    <div class="score-summary">
      <div class="score-ring ${tone}" style="--p:${Math.round(pct * 100)}">
        <span class="score-num">${r.total}</span><span class="score-max">/ ${r.max}</span>
      </div>
      <div class="score-side">
        ${title ? `<h3 class="essay-title">《${escapeHTML(title)}》</h3>` : ''}
        ${r.level ? `<span class="level ${tone}">等级：${escapeHTML(r.level)}</span>` : ''}
        ${r.topic && r.topic !== '切题' ? `<span class="level bad">${r.topic === '离题' ? '#' : 'Δ'} ${escapeHTML(r.topic)}</span>` : ''}
        <p class="muted small">${escapeHTML(meta.grade)} · 汉字 ${stats.hanzi}${meta.minWords && stats.hanzi < meta.minWords ? `（<span class="warn">不足 ${meta.minWords}</span>）` : ''} · ${stats.paragraphs} 段 · 错别字 ${r.typos.length} · 文句问题 ${r.sentences.length}</p>
        <div class="bars">
          ${r.scores
            .map(
              (s) => `<div class="bar">
                <div class="bar-label"><span>${escapeHTML(s.name)}</span><b>${s.score} / ${s.max}</b></div>
                <div class="bar-track"><div class="bar-fill" style="width:${s.max ? (s.score / s.max) * 100 : 0}%"></div></div>
                ${s.comment ? `<p class="bar-comment">${escapeHTML(s.comment)}</p>` : ''}
              </div>`
            )
            .join('')}
        </div>
      </div>
    </div>

    <div class="comment-box">
      <h3>总评</h3>
      <p>${escapeHTML(r.comment)}</p>
    </div>

    <div class="result-grid">
      <div>
        <div class="legend">
          <span><mark class="m-typo">× 错别字</mark></span>
          <span><mark class="m-sentence">~~ 文句/标点问题</mark></span>
          <span><mark class="m-good">√ 佳句</mark></span>
          <span class="muted small">点击标注查看说明</span>
        </div>
        <article class="essay" id="essay-view">${renderMarked(body, marks)}</article>
      </div>
      <aside class="issues">
        <h3>× 错别字 <small>${r.typos.length}</small></h3>
        ${
          r.typos.length
            ? `<ul class="issue-list">${r.typos
                .map(
                  (t, i) => `<li data-kind="typo" data-index="${i}">
                    <span class="wrong">${escapeHTML(t.wrong)}</span> → <span class="right">${escapeHTML(t.correct)}</span> ${notFound(t)}
                  </li>`
                )
                .join('')}</ul>`
            : '<p class="muted">没有发现错别字</p>'
        }
        <h3>~~ 文句与标点 <small>${r.sentences.length}</small></h3>
        ${
          r.sentences.length
            ? `<ul class="issue-list">${r.sentences
                .map(
                  (s, i) => `<li data-kind="sentence" data-index="${i}">
                    ${s.type ? `<span class="tag">${escapeHTML(s.type)}</span>` : ''} ${notFound(s)}
                    <p class="orig">${escapeHTML(s.original)}</p>
                    ${s.problem ? `<p class="muted small">${escapeHTML(s.problem)}</p>` : ''}
                    ${s.suggestion ? `<p class="fix">改：${escapeHTML(s.suggestion)}</p>` : ''}
                  </li>`
                )
                .join('')}</ul>`
            : '<p class="muted">没有发现明显问题</p>'
        }
        <h3>√ 佳句 <small>${r.highlights.length}</small></h3>
        ${
          r.highlights.length
            ? `<ul class="issue-list">${r.highlights
                .map(
                  (s, i) => `<li data-kind="good" data-index="${i}">
                    <p class="orig">${escapeHTML(s.original)}</p>
                    <p class="muted small">${escapeHTML(s.reason)}</p>
                  </li>`
                )
                .join('')}</ul>`
            : '<p class="muted">无</p>'
        }
      </aside>
    </div>

    <div class="three-col">
      <div><h3>优点</h3>${list(r.strengths)}</div>
      <div><h3>不足</h3>${list(r.weaknesses)}</div>
      <div><h3>修改建议</h3>${list(r.suggestions)}</div>
    </div>
    <p class="muted small">由 ${escapeHTML(meta.provider)}（${escapeHTML(meta.model)}）批改于 ${new Date(meta.time).toLocaleString('zh-CN')}。AI 评分仅供参考。</p>
  `;
  show('#step-result');
}

function describe(kind, index) {
  const r = state.last.result;
  if (kind === 'typo') {
    const t = r.typos[index];
    return `<b>错别字</b>「${escapeHTML(t.wrong)}」应为「${escapeHTML(t.correct)}」`;
  }
  if (kind === 'sentence') {
    const s = r.sentences[index];
    return `<b>${escapeHTML(s.type || '病句')}</b>${s.problem ? `<p>${escapeHTML(s.problem)}</p>` : ''}${s.suggestion ? `<p class="fix">改：${escapeHTML(s.suggestion)}</p>` : ''}`;
  }
  const g = r.highlights[index];
  return `<b>好句</b><p>${escapeHTML(g.reason)}</p>`;
}

function initResultInteractions() {
  const pop = $('#popover');
  const hide = () => (pop.hidden = true);
  const openFor = (mark) => {
    pop.innerHTML = describe(mark.dataset.kind, Number(mark.dataset.index));
    pop.hidden = false;
    const rect = mark.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 32);
    pop.style.width = `${w}px`;
    const left = Math.max(16, Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - w - 16));
    pop.style.left = `${left}px`;
    pop.style.top = `${rect.bottom + window.scrollY + 8}px`;
  };
  document.addEventListener('click', (ev) => {
    const mark = ev.target.closest('#essay-view mark');
    if (mark) return openFor(mark);
    const li = ev.target.closest('.issue-list li');
    if (li) {
      const m = document.querySelector(`#essay-view mark[data-kind="${li.dataset.kind}"][data-index="${li.dataset.index}"]`);
      if (m) {
        m.scrollIntoView({ behavior: 'smooth', block: 'center' });
        m.classList.add('flash');
        setTimeout(() => m.classList.remove('flash'), 1200);
      }
      return;
    }
    if (!ev.target.closest('#popover')) hide();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hide();
    if (ev.key === 'Enter' && ev.target.matches?.('#essay-view mark')) openFor(ev.target);
  });
  window.addEventListener('resize', hide);

  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-remark').addEventListener('click', runMark);
  $('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(reportText(state.last));
      toast('报告已复制，可以粘贴到微信或文档里');
    } catch {
      toast('复制失败，请手动选择文字复制');
    }
  });
}

function reportText({ title, result: r, meta, stats }) {
  const lines = [];
  lines.push(`【作文批改】${title ? `《${title}》` : ''}`);
  lines.push(`总分：${r.total} / ${r.max}${r.level ? `（等级：${r.level}）` : ''}${r.topic && r.topic !== '切题' ? `【${r.topic}】` : ''}　汉字 ${stats.hanzi}　${meta.grade}`);
  r.scores.forEach((s) => lines.push(`· ${s.name}：${s.score}/${s.max}　${s.comment}`));
  lines.push('', `总评：${r.comment}`);
  if (r.typos.length) lines.push('', '错别字：' + r.typos.map((t) => `${t.wrong}→${t.correct}`).join('，'));
  if (r.sentences.length) {
    lines.push('', '文句与标点：');
    r.sentences.forEach((s, i) => lines.push(`${i + 1}. ${s.original}\n   问题：${s.type || ''} ${s.problem || ''}\n   修改：${s.suggestion || ''}`));
  }
  if (r.strengths.length) lines.push('', '优点：', ...r.strengths.map((x) => `· ${x}`));
  if (r.weaknesses.length) lines.push('', '不足：', ...r.weaknesses.map((x) => `· ${x}`));
  if (r.suggestions.length) lines.push('', '修改建议：', ...r.suggestions.map((x, i) => `${i + 1}. ${x}`));
  return lines.join('\n');
}

/* ---------------- 历史记录 ---------------- */

function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function saveHistory(entry) {
  const list = readHistory();
  list.unshift(entry);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30))); } catch { /* 存储满或不可用 */ }
}

function initHistory() {
  const dlg = $('#dlg-history');
  const ul = $('#history-list');
  const render = () => {
    const list = readHistory();
    ul.innerHTML = list.length
      ? list
          .map(
            (h, i) => `<li><button type="button" class="history-item" data-i="${i}">
              <b>${escapeHTML(h.title || h.body.slice(0, 12) + '…')}</b>
              <span>${h.result.total} / ${h.result.max}</span>
              <small class="muted">${new Date(h.meta.time).toLocaleString('zh-CN')}</small>
            </button></li>`
          )
          .join('')
      : '<li class="muted">还没有记录</li>';
  };
  $('#btn-history').addEventListener('click', () => {
    render();
    dlg.showModal();
  });
  $('#h-close').addEventListener('click', () => dlg.close());
  $('#h-clear').addEventListener('click', () => {
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
    render();
  });
  ul.addEventListener('click', (ev) => {
    const b = ev.target.closest('.history-item');
    if (!b) return;
    const h = readHistory()[Number(b.dataset.i)];
    state.last = h;
    $('#essay-text').value = (h.title ? `标题：${h.title}\n\n` : '') + h.body;
    showTextSteps();
    renderResult();
    dlg.close();
    $('#step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* ---------------- 启动 ---------------- */

initSettings();
initUpload();
initRubric();
initResultInteractions();
initHistory();
updateBanner();
$('#essay-text').addEventListener('input', updateStats);
$('#min-words').addEventListener('input', updateStats);
$('#btn-mark').addEventListener('click', runMark);
