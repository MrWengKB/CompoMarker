// 在作文纸照片上检测方格（全部在浏览器本地计算，不调用模型）。
// 结果坐标在「摆正后的工作图」里；画图时用 pageTransform 换回原图坐标。

const WORK_SIDE = 1600; // 检测时把图缩到长边 1600，速度和精度的折中

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法读取'));
    img.src = src;
  });
}

// 取 RGB 最小值作灰度：浅绿、浅红的格子线也能和白纸区分开
function grayOf(ctx, W, H) {
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = Math.min(d[j], d[j + 1], d[j + 2]);
  return g;
}

// 自适应二值化：比周围平均亮度暗一定比例就算墨迹（适应光照不均的手机照片）
function inkMask(g, W, H, ratio = 0.86) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += g[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  const r = Math.max(8, Math.round(Math.max(W, H) / 50));
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      const mean = sum / ((y1 - y0) * (x1 - x0));
      const v = g[y * W + x];
      m[y * W + x] = v < mean * ratio && v < 235 ? 1 : 0;
    }
  }
  return m;
}

// 只保留长度不小于 len 的水平连续墨迹（格子线），手写笔画大多达不到
function hRuns(m, W, H, len) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && m[y * W + x];
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        if (x - start >= len) out.fill(1, y * W + start, y * W + x);
        start = -1;
      }
    }
  }
  return out;
}

function vRuns(m, W, H, len) {
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let start = -1;
    for (let y = 0; y <= H; y++) {
      const on = y < H && m[y * W + x];
      if (on && start < 0) start = y;
      else if (!on && start >= 0) {
        if (y - start >= len) for (let k = start; k < y; k++) out[k * W + x] = 1;
        start = -1;
      }
    }
  }
  return out;
}

// 一维信号找峰：先平滑，再取局部最大且超过阈值的位置
function peaks(arr, threshold, minGap) {
  const n = arr.length;
  const s = new Float64Array(n);
  // 先做一次最大值膨胀，细线（1 像素、抗锯齿后分在两列）的峰值不会因平滑而减半
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.max(arr[i - 1] || 0, arr[i], arr[i + 1] || 0);
  for (let i = 0; i < n; i++) s[i] = (d[i - 1] || 0) * 0.25 + d[i] * 0.5 + (d[i + 1] || 0) * 0.25;
  const cand = [];
  for (let i = 1; i < n - 1; i++) if (s[i] >= threshold && s[i] >= s[i - 1] && s[i] >= s[i + 1]) cand.push(i);
  cand.sort((a, b) => s[b] - s[a]);
  const taken = [];
  for (const i of cand) if (taken.every((j) => Math.abs(j - i) >= minGap)) taken.push(i);
  // 用峰附近的加权平均得到亚像素位置
  return taken
    .sort((a, b) => a - b)
    .map((i) => {
      let w = 0, sx = 0;
      for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n) { w += s[k]; sx += s[k] * k; }
      return w ? sx / w : i;
    });
}

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// 估计倾斜角：把长水平线上的点按不同角度投影，投影最集中的角度就是倾斜角
function estimateSkew(hr, W, H) {
  const pts = [];
  const step = Math.max(1, Math.round(Math.sqrt((W * H) / 400000)));
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) if (hr[y * W + x]) pts.push(x, y);
  if (pts.length < 200) return 0;
  const score = (deg) => {
    const a = (deg * Math.PI) / 180, s = Math.sin(a), c = Math.cos(a);
    const hist = new Float64Array(H * 2 + 2);
    for (let i = 0; i < pts.length; i += 2) {
      const y = Math.round(-pts[i] * s + pts[i + 1] * c + H / 2);
      if (y >= 0 && y < hist.length) hist[y]++;
    }
    let t = 0;
    for (const v of hist) t += v * v;
    return t;
  };
  let best = 0, bestS = -1;
  for (let d = -6; d <= 6; d += 0.25) { const v = score(d); if (v > bestS) { bestS = v; best = d; } }
  const c0 = best;
  for (let d = c0 - 0.25; d <= c0 + 0.25; d += 0.05) { const v = score(d); if (v > bestS) { bestS = v; best = d; } }
  return best;
}

/**
 * 检测一页作文纸上的方格。
 * 返回 null（不是方格纸 / 检测不到），或：
 * { W, H, f, theta, pitch, rows: [{ cells: [{ x0, x1, yt, yb, ink }] }] }
 * 坐标在工作图里：原图先缩放 f 倍，再绕中心旋转 -theta 度摆正。
 */
export async function detectGrid(src) {
  const img = await loadImage(src);
  const f = Math.min(1, WORK_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * f);
  const H = Math.round(img.naturalHeight * f);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);

  let g = grayOf(ctx, W, H);
  let m = inkMask(g, W, H);
  const theta = estimateSkew(hRuns(m, W, H, Math.round(W / 40)), W, H);
  if (Math.abs(theta) >= 0.05) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((-theta * Math.PI) / 180);
    ctx.translate(-W / 2, -H / 2);
    ctx.drawImage(img, 0, 0, W, H);
    ctx.restore();
    g = grayOf(ctx, W, H);
    m = inkMask(g, W, H);
  }

  // 1. 横线：分成多条竖带分别找，再连成折线，适应透视变形和纸张弯曲
  const hr = hRuns(m, W, H, Math.max(10, Math.round(W / 50)));
  const K = 8;
  const strips = [];
  for (let k = 0; k < K; k++) {
    const sx0 = Math.round((W * k) / K), sx1 = Math.round((W * (k + 1)) / K);
    const hist = new Float64Array(H);
    for (let y = 0; y < H; y++) { let c = 0; for (let x = sx0; x < sx1; x++) c += hr[y * W + x]; hist[y] = c; }
    strips.push({ xc: (sx0 + sx1) / 2, ys: peaks(hist, (sx1 - sx0) * 0.3, 5) });
  }
  // 从中间几条竖带的每个峰出发，向两边逐带追踪同一条线；只保留贯穿大部分竖带的线（排除字的横笔画）
  const allYs = strips.flatMap((st) => st.ys);
  if (allYs.length < 8) return null;
  const tol = 6;
  const track = (k0, y0) => {
    const pts = new Map([[k0, y0]]);
    for (const dir of [-1, 1]) {
      let prev = y0, prev2 = null;
      for (let k = k0 + dir; k >= 0 && k < K; k += dir) {
        const guess = prev2 == null ? prev : prev + (prev - prev2) * 0.5;
        const near = strips[k].ys.reduce((b, y) => (Math.abs(y - guess) < Math.abs(b - guess) ? y : b), Infinity);
        if (Math.abs(near - guess) > tol) continue;
        pts.set(k, near);
        prev2 = prev;
        prev = near;
      }
    }
    return pts;
  };
  const lines = [];
  const used = strips.map(() => new Set());
  for (const k0 of [3, 4, 2, 5]) {
    for (const y0 of strips[k0].ys) {
      if (used[k0].has(y0)) continue;
      const pts = track(k0, y0);
      if (pts.size < K * 0.5) continue;
      for (const [k, y] of pts) used[k].add(y);
      lines.push([...pts].sort((p, q) => p[0] - q[0]).map(([k, y]) => [strips[k].xc, y]));
    }
  }
  if (lines.length < 4) return null;
  // 折线插值，两端按最近两点外推
  const yAt = (pts, x) => {
    if (pts.length === 1) return pts[0][1];
    let i = 0;
    while (i < pts.length - 2 && x > pts[i + 1][0]) i++;
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  };
  const xm = W / 2;
  lines.sort((p, q) => yAt(p, xm) - yAt(q, xm));

  // 2. 行高：相邻横线间距里，数量够多的最大一组就是格子高度（另一组是行间空隙）
  const diffs = lines.slice(1).map((l, i) => yAt(l, xm) - yAt(lines[i], xm)).filter((d) => d > 8).sort((x, y) => x - y);
  const clusters = [];
  for (const d of diffs) {
    const c = clusters.find((c) => Math.abs(d - median(c)) < median(c) * 0.15);
    if (c) c.push(d); else clusters.push([d]);
  }
  const big = clusters.filter((c) => c.length >= Math.max(2, diffs.length * 0.25));
  if (!big.length) return null;
  const rowH = Math.max(...big.map(median));

  // 3. 横线两两配对成一行格子（行与行之间可能有空隙，也可能共用一条线）
  const bands = [];
  for (let i = 0; i < lines.length - 1; ) {
    const yi = yAt(lines[i], xm);
    let j = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const d = yAt(lines[k], xm) - yi;
      if (Math.abs(d - rowH) < rowH * 0.2) { j = k; break; }
      if (d > rowH * 1.3) break;
    }
    if (j === -1) { i++; continue; }
    bands.push([lines[i], lines[j]]);
    i = j;
  }
  if (bands.length < 2) return null;

  // 4. 每行单独找竖线；左右边界取各行的中位数，再按等距补齐漏检的线
  const vr = vRuns(m, W, H, Math.max(8, Math.round(rowH * 0.45)));
  const bandPeaks = bands.map(([lt, lb]) => {
    const prof = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      const y0 = Math.round(yAt(lt, x) + rowH * 0.15), y1 = Math.round(yAt(lb, x) - rowH * 0.15);
      let c = 0;
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) c += vr[y * W + x];
      prof[x] = c;
    }
    return peaks(prof, rowH * 0.7 * 0.8, rowH * 0.25);
  });
  // 格宽：任意两条竖线的间距里，出现次数最多的那个（格子线是等距的，字的笔画不是）
  const votes = new Float64Array(Math.ceil(rowH * 2) + 2);
  for (const xs of bandPeaks) {
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        const d = xs[j] - xs[i];
        if (d > rowH * 1.8) break;
        if (d < rowH * 0.45) continue;
        const k = Math.floor(d);
        votes[k] += 1 - (d - k);
        votes[k + 1] += d - k;
      }
    }
  }
  const sm = votes.map((v, i) => (votes[i - 1] || 0) + v + (votes[i + 1] || 0));
  let pk = 0;
  for (let i = 1; i < sm.length; i++) if (sm[i] > sm[pk]) pk = i;
  let pitch = pk;
  const near = bandPeaks.flatMap((xs) => xs.flatMap((x, i) => xs.slice(i + 1).map((y) => y - x))).filter((d) => Math.abs(d - pk) < 2.5);
  if (near.length) pitch = near.reduce((a, b) => a + b, 0) / near.length;
  if (!(pitch > 8)) return null;
  // 每行找「间距约等于格宽」的最长一串竖线（允许漏掉一条），排除照片边缘、桌子边等干扰
  const chain = (xs) => {
    const best = xs.map(() => ({ span: 0, start: 0 }));
    let top = null;
    xs.forEach((x, i) => {
      best[i] = { span: 0, start: i };
      for (let j = 0; j < i; j++) {
        const steps = Math.round((x - xs[j]) / pitch);
        if (steps < 1 || steps > 2 || Math.abs(x - xs[j] - steps * pitch) > pitch * (steps === 1 ? 0.15 : 0.12)) continue;
        if (best[j].span + steps > best[i].span) best[i] = { span: best[j].span + steps, start: best[j].start };
      }
      if (!top || best[i].span > top.span) top = { span: best[i].span, l: xs[best[i].start], r: x };
    });
    return top;
  };
  const inside = (xs) => xs.filter((x) => x > W * 0.012 && x < W * 0.988); // 去掉照片边缘
  const chains = bandPeaks.map(inside).map((xs) => (xs.length >= 3 ? chain(xs) : null)).filter((c) => c && c.span >= 3);
  if (chains.length < 2) return null;
  const L = median(chains.map((c) => c.l));
  const R = median(chains.map((c) => c.r));
  const n = Math.round((R - L) / pitch);
  if (n < 3) return null;
  const snap = (xs, x, t) => {
    const near = xs.reduce((b, v) => (Math.abs(v - x) < Math.abs(b - x) ? v : b), Infinity);
    return Math.abs(near - x) < t ? near : null;
  };
  const rows = [];
  bands.forEach(([lt, lb], bi) => {
    const xs = bandPeaks[bi];
    const hits = xs.filter((x) => x > L - pitch * 0.3 && x < R + pitch * 0.3).length;
    if (hits < Math.min(4, n * 0.3)) return; // 不像方格行（例如页眉的下划线）
    const l = snap(xs, L, pitch * 0.5) ?? L;
    const r = snap(xs, R, pitch * 0.5) ?? R;
    const edges = [];
    for (let k = 0; k <= n; k++) {
      const pred = l + ((r - l) * k) / n;
      edges.push(snap(xs, pred, pitch * 0.12) ?? pred);
    }
    const cells = [];
    for (let k = 0; k < n; k++) {
      const x0 = edges[k], x1 = edges[k + 1], xc = (x0 + x1) / 2;
      cells.push({ x0, x1, yt: yAt(lt, xc), yb: yAt(lb, xc), ink: 0 });
    }
    rows.push({ cells });
  });
  if (rows.length < 2) return null;

  // 5. 每个格子里有没有字：只看格子中间部分；用更严格的阈值，忽略纸背透过来的淡影
  const dark = inkMask(g, W, H, 0.72);
  for (const row of rows) {
    for (const c of row.cells) {
      const w = c.x1 - c.x0, h = c.yb - c.yt;
      const x0 = Math.round(c.x0 + w * 0.1), x1 = Math.round(c.x1 - w * 0.1);
      const y0 = Math.round(c.yt + h * 0.1), y1 = Math.round(c.yb - h * 0.1);
      let n = 0, area = 0;
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          area++;
          const i = y * W + x;
          if (dark[i]) n++;
        }
      }
      c.ink = area ? n / area : 0;
    }
  }
  const fills = rows.flatMap((r) => r.cells.map((c) => c.ink)).sort((a, b) => a - b);
  // 空格子的噪声水平：取较低的分位数，阈值至少 0.4%
  const noise = fills[Math.floor(fills.length * 0.2)] || 0;
  const thr = Math.max(0.004, noise * 3 + 0.002);
  for (const row of rows) for (const c of row.cells) c.filled = c.ink > thr;
  for (const row of rows) row.filled = row.cells.filter((c) => c.filled).length;

  return { W, H, f, theta, pitch, rowH, rows };
}

// 工作图坐标 → 原图坐标的变换（canvas 用）
export function applyPageTransform(ctx, grid) {
  ctx.scale(1 / grid.f, 1 / grid.f);
  ctx.translate(grid.W / 2, grid.H / 2);
  ctx.rotate((grid.theta * Math.PI) / 180);
  ctx.translate(-grid.W / 2, -grid.H / 2);
}

// 同样的变换，写成 SVG transform 属性
export function svgTransform(grid) {
  return `scale(${1 / grid.f}) rotate(${grid.theta} ${grid.W / 2} ${grid.H / 2})`;
}
