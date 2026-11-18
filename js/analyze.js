// 本地文本统计与原文标注（不依赖模型）。

const HANZI = /[㐀-䶿一-鿿豈-﫿]/g;

export function splitTitle(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const idx = lines.findIndex((l) => l.trim());
  if (idx !== -1) {
    const m = lines[idx].trim().match(/^标题[:：]\s*(.*)$/);
    if (m) {
      lines.splice(idx, 1);
      return { title: m[1].trim(), body: lines.join('\n').replace(/^\n+/, '') };
    }
  }
  return { title: '', body: lines.join('\n') };
}

export function textStats(body) {
  const text = String(body || '');
  const hanzi = (text.match(HANZI) || []).length;
  const chars = text.replace(/\s/g, '').length;
  const paragraphs = text.split(/\n/).filter((p) => p.trim()).length;
  const sentences = text.split(/[。！？!?…]+/).filter((s) => s.replace(/[\s”"’']/g, '').length > 1).length;
  return {
    hanzi,
    chars,
    paragraphs,
    sentences,
    avgSentence: sentences ? Math.round(chars / sentences) : 0,
  };
}

// 根据批改结果在原文中定位，返回不重叠的区间列表
export function findMarks(body, result) {
  const marks = [];
  const used = [];
  const overlaps = (s, e) => used.some(([a, b]) => s < b && e > a);
  const add = (s, e, kind, index) => {
    if (s < 0 || e <= s || overlaps(s, e) || body.slice(s, e).includes('\n')) return false;
    used.push([s, e]);
    marks.push({ start: s, end: e, kind, index });
    return true;
  };
  const findFree = (needle, from = 0) => {
    if (!needle) return -1;
    let i = body.indexOf(needle, from);
    while (i !== -1) {
      if (!overlaps(i, i + needle.length)) return i;
      i = body.indexOf(needle, i + 1);
    }
    return -1;
  };

  // 错别字：先找上下文，再在上下文里找错字，范围最小、优先级最高
  (result.typos || []).forEach((t, index) => {
    const wrong = (t.wrong || '').trim();
    if (!wrong) return;
    const ctx = (t.context || '').trim();
    let pos = -1;
    if (ctx) {
      let c = body.indexOf(ctx);
      while (c !== -1 && pos === -1) {
        const inner = ctx.indexOf(wrong);
        if (inner !== -1 && !overlaps(c + inner, c + inner + wrong.length)) pos = c + inner;
        c = body.indexOf(ctx, c + 1);
      }
    }
    if (pos === -1) pos = findFree(wrong);
    t._found = pos !== -1 && add(pos, pos + wrong.length, 'typo', index);
  });

  // 病句与好句：整句标注，避开已标注的错别字所在位置时退而求其次
  const addSentence = (item, kind, index) => {
    const s = (item.original || '').trim();
    if (!s) return;
    const pos = findFree(s);
    item._found = pos !== -1 && add(pos, pos + s.length, kind, index);
  };
  (result.sentences || []).forEach((s, i) => addSentence(s, 'sentence', i));
  (result.highlights || []).forEach((s, i) => addSentence(s, 'good', i));

  return marks.sort((a, b) => a.start - b.start);
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 把原文渲染成带 <mark> 的 HTML，按段落分 <p>
export function renderMarked(body, marks) {
  let html = '';
  let cur = 0;
  for (const m of marks) {
    html += escapeHTML(body.slice(cur, m.start));
    html += `<mark class="m-${m.kind}" data-kind="${m.kind}" data-index="${m.index}" tabindex="0">${escapeHTML(body.slice(m.start, m.end))}</mark>`;
    cur = m.end;
  }
  html += escapeHTML(body.slice(cur));
  return html
    .split('\n')
    .filter((p) => p.trim())
    .map((p) => `<p>${p}</p>`)
    .join('');
}
