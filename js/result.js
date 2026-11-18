// 批改结果的展示（单篇和批量共用）
import { findMarks, renderMarked, escapeHTML } from './analyze.js';

// 把结果渲染进容器，并记住对应的数据，供点击标注时查找
export function mountResult(el, entry) {
  el.innerHTML = resultHTML(entry);
  el.dataset.resultRoot = '1';
  el._entry = entry;
}

export function resultHTML(entry) {
  const { body, title, result: r, meta, stats } = entry;
  const marks = findMarks(body, r);
  const pct = r.max ? r.total / r.max : 0;
  const tone = pct >= 0.85 ? 'high' : pct >= 0.7 ? 'mid' : pct >= 0.6 ? 'low' : 'bad';
  const list = (items) => (items.length ? `<ul>${items.map((x) => `<li>${escapeHTML(x)}</li>`).join('')}</ul>` : '<p class="muted">无</p>');
  const notFound = (x) => (x._found ? '' : '<span class="nf" title="未能在原文中定位">未定位</span>');

  return `
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
        <article class="essay essay-view">${renderMarked(body, marks)}</article>
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
}

export function describe(entry, kind, index) {
  const r = entry.result;
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

export function reportText({ title, result: r, meta, stats }) {
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

