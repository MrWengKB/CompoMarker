// 把「按方格逐行识别」的文字和本地检测到的格子对应起来：
// 每个字 → （页、行、格）。再拼回正常分段的作文，并记住每个字在原图上的格子。

const PUNCT = /[，。、；：！？…—“”‘’「」『』（）《》〈〉·,.;:!?'"()\-]/;
export const isPunct = (c) => PUNCT.test(c);

// 识别结果按行拆开：去掉「学生：」行，记下「标题：」行
export function parseGridLines(text) {
  let student = '';
  const lines = [];
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const ms = t.match(/^学生[:：]\s*(.*)$/);
    if (ms && !student && !lines.length) { student = ms[1].trim(); continue; }
    const mt = t.match(/^标题[:：]\s*(.*)$/);
    if (mt) lines.push({ title: true, chars: [...mt[1].replace(/\s/g, '')] });
    else lines.push({ title: false, chars: [...t.replace(/\s/g, '')] });
  }
  return { student, lines: lines.filter((l) => l.chars.length) };
}

// 行对行：识别出的行 ↔ 写了字的格子行（允许多出或缺少行），按字数和有字格数尽量接近来配
function alignRows(lines, rows) {
  const n = lines.length, m = rows.length;
  const INF = 1e9;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  const from = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  dp[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const v = dp[i][j];
      if (v >= INF) continue;
      if (i < n && j < m) {
        const c = v + Math.abs(lines[i].chars.length - rows[j].filled) / Math.max(4, rows[j].filled);
        if (c < dp[i + 1][j + 1]) { dp[i + 1][j + 1] = c; from[i + 1][j + 1] = 1; }
      }
      if (j < m) {
        // 跳过一行格子：空行几乎不花代价，有字的行代价高
        const c = v + (rows[j].filled ? 1 + rows[j].filled * 0.2 : 0.01);
        if (c < dp[i][j + 1]) { dp[i][j + 1] = c; from[i][j + 1] = 2; }
      }
      if (i < n) {
        const c = v + 1.5 + lines[i].chars.length * 0.1;
        if (c < dp[i + 1][j]) { dp[i + 1][j] = c; from[i + 1][j] = 3; }
      }
    }
  }
  const pairs = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const f = from[i][j];
    if (f === 1) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (f === 2) j--;
    else { pairs.push([i - 1, -1]); i--; }
  }
  return pairs.reverse();
}

// 一行之内：字 ↔ 格子。通常一字一格；标点可能写在很小的格子里（检测不到墨迹），
// 也可能两个标点挤在一格（如「。”」），行末的标点可能写在格子外。
function alignCells(chars, cells) {
  const n = chars.length, m = cells.length;
  const INF = 1e9;
  const W = m + 1; // 最后一个是「格子外（行末右侧）」
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(W + 1).fill(INF));
  const from = Array.from({ length: n + 1 }, () => new Int8Array(W + 1));
  dp[0][0] = 0;
  const filled = (j) => j < m && cells[j].filled;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= W; j++) {
      const v = dp[i][j];
      if (v >= INF || j === W) continue;
      // 这一格不放字
      const skip = v + (filled(j) ? 1 : 0);
      if (skip < dp[i][j + 1]) { dp[i][j + 1] = skip; from[i][j + 1] = 1; }
      if (i < n) {
        const p = isPunct(chars[i]);
        const put = j === m ? (p ? 0.4 : 5) : filled(j) ? 0 : p ? 0.35 : 1.2;
        if (v + put < dp[i + 1][j + 1]) { dp[i + 1][j + 1] = v + put; from[i + 1][j + 1] = 2; }
        if (i + 1 < n) {
          // 只有「标点 + 后引号/括号」常挤在一格；其它情况算异常，会提示老师核对
          const two = put + (isPunct(chars[i]) && /[”’」』）》]/.test(chars[i + 1]) ? 0.2 : 1.5);
          if (v + two < dp[i + 2][j + 1]) { dp[i + 2][j + 1] = v + two; from[i + 2][j + 1] = 3; }
        }
      }
    }
  }
  let bestJ = 0;
  for (let j = 0; j <= W; j++) if (dp[n][j] + (j <= m ? remainingFilled(cells, j) : 0) < dp[n][bestJ] + (bestJ <= m ? remainingFilled(cells, bestJ) : 0)) bestJ = j;
  const cost = dp[n][bestJ] + remainingFilled(cells, bestJ);
  const at = new Array(n);
  for (let i = n, j = bestJ; i > 0; ) {
    const f = from[i][j];
    if (f === 1) j--;
    else if (f === 2) { at[i - 1] = j - 1; i--; j--; }
    else { at[i - 1] = j - 1; at[i - 2] = j - 1; i -= 2; j--; }
  }
  return { at, cost };
}

function remainingFilled(cells, j) {
  let c = 0;
  for (let k = j; k < cells.length; k++) if (cells[k].filled) c++;
  return c;
}

/**
 * 一页的识别结果对到格子上。
 * 返回 { student, rows: [{ row, title, chars, at, indent, warn }] }
 * at[k] 是第 k 个字所在的格子序号（等于格数时表示写在行末格子外）
 */
export function layoutPage(grid, text) {
  const { student, lines } = parseGridLines(text);
  const pairs = alignRows(lines, grid.rows);
  const rows = [];
  for (const [li, ri] of pairs) {
    const line = lines[li];
    if (ri < 0) {
      rows.push({ row: -1, title: line.title, chars: line.chars, at: line.chars.map(() => -1), indent: false, warn: '这一行没能对上格子' });
      continue;
    }
    const cells = grid.rows[ri].cells;
    const { at, cost } = alignCells(line.chars, cells);
    const firstCell = Math.min(...at.filter((x) => x >= 0));
    const filledN = cells.filter((c) => c.filled).length;
    let warn = '';
    if (cost >= 1) warn = `识别出 ${line.chars.length} 个字，格子里约有 ${filledN} 格写了字`;
    rows.push({ row: ri, title: line.title, chars: line.chars, at, indent: firstCell >= 2, warn });
  }
  return { student, rows };
}

/**
 * 把各页拼成完整的作文文字，同时得到每个字对应的格子。
 * pages: [{ layout, text }]——有方格的页给 layout，没有的给普通识别文字 text
 * 返回 { text, map }：map[i] 是 text 第 i 个字的位置 { page, row, cell } 或 null
 */
export function assemble(pages) {
  let student = '';
  let title = '';
  const paras = []; // 每段是 [{ ch, pos }]
  let cur = null;
  const newPara = () => { cur = []; paras.push(cur); };
  pages.forEach((p, page) => {
    if (!p.layout) {
      // 普通识别：按原有分段规则接上
      const t = String(p.text || '').trim();
      const lines = t.split(/\n/);
      lines.forEach((ln, i) => {
        let s = ln.trim();
        if (!s) return;
        const ms = s.match(/^学生[:：]\s*(.*)$/);
        const mt = s.match(/^标题[:：]\s*(.*)$/);
        if (ms) { student ||= ms[1].trim(); return; }
        if (mt) { title ||= mt[1].trim(); return; }
        const cont = i === 0 && s.startsWith('〔续〕') && cur;
        if (cont) s = s.slice(3);
        if (!cont) newPara();
        for (const ch of s) cur.push({ ch, pos: null });
      });
      return;
    }
    student ||= p.layout.student;
    for (const r of p.layout.rows) {
      if (r.title) {
        title ||= r.chars.join('');
        continue;
      }
      if (!cur || r.indent || r.row < 0) newPara();
      r.chars.forEach((ch, k) => cur.push({ ch, pos: r.row >= 0 && r.at[k] >= 0 ? { page, row: r.row, cell: r.at[k] } : null }));
    }
  });
  let text = '';
  const map = [];
  const push = (s, pos = null) => { for (const ch of s) { text += ch; map.push(pos); } };
  if (student) push(`学生：${student}\n`);
  if (title) push(`标题：${title}\n`);
  if (student || title) push('\n');
  paras.filter((p) => p.length).forEach((p, i) => {
    if (i) push('\n\n');
    for (const { ch, pos } of p) push(ch, pos);
  });
  return { text, map };
}

/**
 * 编辑后的文字 → 原识别文字的逐字对应（老师改过识别错误时仍能找到格子）。
 * 返回数组 idx：edited 第 i 个字对应 orig 的第 idx[i] 个字，没有对应时为 -1。
 */
export function alignText(edited, orig) {
  const a = [...edited], b = [...orig];
  if (a.join('') === b.join('')) return a.map((_, i) => i);
  const n = a.length, m = b.length;
  if (n * m > 6e6) return a.map((_, i) => (i < m ? i : -1));
  // 编辑距离 DP（只存方向）
  const W = m + 1;
  const dir = new Uint8Array((n + 1) * W);
  let prev = new Int32Array(W), curr = new Int32Array(W);
  for (let j = 0; j <= m; j++) { prev[j] = j; dir[j] = 2; }
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    dir[i * W] = 1;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const del = prev[j] + 1; // edited 多出的字
      const ins = curr[j - 1] + 1; // orig 被删掉的字
      let v = sub, d = 0;
      if (del < v) { v = del; d = 1; }
      if (ins < v) { v = ins; d = 2; }
      curr[j] = v;
      dir[i * W + j] = d;
    }
    [prev, curr] = [curr, prev];
  }
  const idx = new Array(n).fill(-1);
  for (let i = n, j = m; i > 0 && j >= 0; ) {
    const d = dir[i * W + j];
    if (d === 0 && j > 0) { idx[i - 1] = j - 1; i--; j--; }
    else if (d === 1 || j === 0) i--;
    else j--;
  }
  return idx;
}
