import { PROVIDERS, loadSettings, saveSettings, settingsFor, clearAllKeys } from './config.js';
import { RUBRICS, DEFAULT_RUBRIC, cloneItems, rubricForGrade } from './rubrics.js';
import { splitTitle, textStats, escapeHTML } from './analyze.js';
import {
  MAX_IMAGE_SIDE, canvasToImage, prepareImage, pdfToImages, isPDF,
  ocrPages, markEssay, buildMeta, readHistory, saveHistory, clearHistory,
} from './core.js';
import { mountResult, describe, reportText } from './result.js';
import { initBatch } from './batch.js';

const $ = (sel) => document.querySelector(sel);

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

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || isPDF(f));
  if (!list.length) return toast('请选择图片或 PDF 文件');
  const status = $('#ocr-status');
  for (const f of list) {
    try {
      if (isPDF(f)) {
        setStatus(status, `正在读取 PDF：${f.name}…`, 'busy');
        state.images.push(...(await pdfToImages(f, (m) => toast(m, 4000))));
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

/* 拍照：手机/平板直接调用系统相机；电脑用摄像头 */

const isTouchDevice = () => window.matchMedia?.('(pointer: coarse)').matches;
let camStream = null;

function stopCamera() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
}

async function openCamera() {
  if (isTouchDevice() || !navigator.mediaDevices?.getUserMedia) {
    $('#camera-input').click();
    return;
  }
  const dlg = $('#dlg-camera');
  const status = $('#cam-status');
  setStatus(status, '正在打开摄像头…', 'busy');
  $('#cam-shot').disabled = true;
  dlg.showModal();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1920 } },
      audio: false,
    });
    const video = $('#cam-video');
    video.srcObject = camStream;
    await video.play();
    setStatus(status, '');
    $('#cam-shot').disabled = false;
  } catch (e) {
    console.error(e);
    setStatus(status, '无法打开摄像头：请在浏览器地址栏允许使用摄像头，或改用「选择图片」。', 'err');
  }
}

function captureFrame() {
  const video = $('#cam-video');
  if (!video.videoWidth) return;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  state.images.push(canvasToImage(canvas, `拍照 ${state.images.length + 1}`));
  renderThumbs();
  setStatus($('#cam-status'), `已拍 ${state.images.length} 页，可以继续拍下一页，或点「完成」。`, 'ok');
}

function initCamera() {
  const dlg = $('#dlg-camera');
  $('#btn-camera').addEventListener('click', openCamera);
  $('#cam-shot').addEventListener('click', captureFrame);
  $('#cam-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', stopCamera);
  const camInput = $('#camera-input');
  camInput.addEventListener('change', () => {
    addFiles(camInput.files);
    camInput.value = '';
  });
}

function initUpload() {
  initCamera();
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
  const ta = $('#essay-text');
  const before = ta.value;
  const pages = [...state.images];
  const n = pages.length;
  state.layout = null;
  btn.disabled = true;
  setStatus(status, n > 1 ? `正在识别第 1 / ${n} 页…` : '正在识别…', 'busy');
  const t0 = Date.now();
  let shown = false;
  let done = '';
  const reveal = () => {
    if (shown) return;
    shown = true;
    showTextSteps();
    ta.readOnly = true;
    $('#step-text').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  try {
    // 逐页识别：每次只上传一页，避免多页一起上传时请求过大被中断
    const out = await ocrPages({
      settings: state.settings,
      images: pages,
      onProgress: ({ text, page }) => {
        reveal();
        ta.value = text;
        ta.scrollTop = ta.scrollHeight;
        updateStats();
        const pageLabel = n > 1 ? `第 ${Math.min(page + 1, n)} / ${n} 页` : '';
        setStatus(status, `正在识别${pageLabel}…已出 ${text.replace(/\s/g, '').length} 字`, 'busy');
      },
    });
    done = out.text;
    state.layout = out.layout;
    ta.value = done;
    showTextSteps();
    setStatus(status, `识别完成（${n > 1 ? `${n} 页，` : ''}用时 ${Math.round((Date.now() - t0) / 1000)} 秒），请在下方核对原文${n > 1 ? '，特别留意换页处的分段' : ''}。`, 'ok');
    if (!shown) $('#step-text').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    done = e.partialText || '';
    if (done) ta.value = done;
    else if (shown) ta.value = before;
    const where = n > 1 && done ? `（前面的页已识别好并保留在下方）` : '';
    setStatus(status, (e.message || String(e)) + where, 'err');
  } finally {
    ta.readOnly = false;
    updateStats();
    btn.disabled = state.images.length === 0;
  }
}

/* ---------------- 第二步：原文统计 ---------------- */

function updateStats() {
  const { student, title, body } = splitTitle($('#essay-text').value);
  const s = textStats(body);
  const min = Number($('#min-words').value) || 0;
  const short = min && s.hanzi < min;
  $('#stats').innerHTML = `
    ${student ? `<span>学生：<b>${escapeHTML(student)}</b></span>` : ''}
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
  const { student, title: parsedTitle, body } = splitTitle(raw);
  if (textStats(body).hanzi < 20) return setStatus(status, '原文太短了，请先识别或粘贴作文。', 'err');
  const rubric = state.rubric.filter((r) => r.name.trim() && Number(r.max) > 0);
  if (!rubric.length) return setStatus(status, '请至少保留一个评分维度。', 'err');

  const meta = buildMeta(state.settings, {
    title: $('#title').value.trim() || parsedTitle,
    student,
    requirement: $('#requirement').value.trim(),
    grade: $('#grade').value,
    minWords: Number($('#min-words').value) || 0,
    style: $('#style').value,
    rubric,
    guide: $('#rubric-guide').value.trim(),
    caps: RUBRICS[state.rubricKey]?.caps || {},
  });
  const stats = textStats(body);
  const btn = $('#btn-mark');
  btn.disabled = true;
  setStatus(status, '正在批改，通常需要 20～60 秒…', 'busy');
  const rawBox = $('#mark-raw');
  rawBox.hidden = true;
  try {
    const { result, truncated } = await markEssay({
      settings: state.settings,
      body,
      meta,
      stats,
      onProgress: ({ chars, attempt }) =>
        setStatus(status, `正在批改${attempt > 1 ? '（上次格式有问题，自动重试中）' : ''}…已生成 ${chars} 字`, 'busy'),
    });
    state.last = { body, title: meta.title, student, result, meta, stats, _layout: state.layout, _text: raw };
    renderResult();
    saveHistory(state.last);
    setStatus(status, truncated ? '批改完成，但结果被截断，部分内容可能缺失，可以点「重新批改」。' : '批改完成。', truncated ? 'err' : 'ok');
    $('#step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setStatus(status, `${e.message || String(e)}已自动重试过一次，可以再点「开始批改」试试。`, 'err');
    if (e.raw) {
      rawBox.querySelector('pre').textContent = e.raw;
      rawBox.hidden = false;
    }
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 结果展示 ---------------- */

function renderResult() {
  mountResult($('#result'), state.last);
  show('#step-result');
}

function initResultInteractions() {
  const pop = $('#popover');
  const hide = () => (pop.hidden = true);
  const openFor = (mark) => {
    const root = mark.closest('[data-result-root]');
    if (!root?._entry) return;
    pop.innerHTML = describe(root._entry, mark.dataset.kind, Number(mark.dataset.index));
    pop.hidden = false;
    const rect = mark.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 32);
    pop.style.width = `${w}px`;
    const left = Math.max(16, Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - w - 16));
    pop.style.left = `${left}px`;
    pop.style.top = `${rect.bottom + window.scrollY + 8}px`;
  };
  document.addEventListener('click', (ev) => {
    const mark = ev.target.closest('.essay-view mark');
    if (mark) return openFor(mark);
    const li = ev.target.closest('.issue-list li');
    if (li) {
      const root = li.closest('[data-result-root]');
      const m = root?.querySelector(`.essay-view mark[data-kind="${li.dataset.kind}"][data-index="${li.dataset.index}"]`);
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
    if (ev.key === 'Enter' && ev.target.matches?.('.essay-view mark')) openFor(ev.target);
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

/* ---------------- 历史记录 ---------------- */

function initHistory() {
  const dlg = $('#dlg-history');
  const ul = $('#history-list');
  const render = () => {
    const list = readHistory();
    ul.innerHTML = list.length
      ? list
          .map(
            (h, i) => `<li><button type="button" class="history-item" data-i="${i}">
              <b>${escapeHTML([h.student, h.title].filter(Boolean).join(' · ') || h.body.slice(0, 12) + '…')}</b>
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
    clearHistory();
    render();
  });
  ul.addEventListener('click', (ev) => {
    const b = ev.target.closest('.history-item');
    if (!b) return;
    const h = readHistory()[Number(b.dataset.i)];
    state.last = h;
    showView('single');
    $('#essay-text').value = (h.student ? `学生：${h.student}\n` : '') + (h.title ? `标题：${h.title}\n\n` : '') + h.body;
    showTextSteps();
    renderResult();
    dlg.close();
    $('#step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* ---------------- 单篇 / 批量切换 ---------------- */

function showView(name) {
  $('#view-single').hidden = name !== 'single';
  $('#view-batch').hidden = name !== 'batch';
  document.querySelectorAll('.tabs [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  const hash = name === 'batch' ? '#batch' : '';
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname + location.search);
}

function initTabs() {
  document.querySelectorAll('.tabs [data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  showView(location.hash === '#batch' ? 'batch' : 'single');
}

/* ---------------- 启动 ---------------- */

initSettings();
initUpload();
initRubric();
initResultInteractions();
initHistory();
initTabs();
initBatch({ getSettings: () => state.settings, toast });
updateBanner();
$('#essay-text').addEventListener('input', updateStats);
$('#min-words').addEventListener('input', updateStats);
$('#btn-mark').addEventListener('click', runMark);
