/* HSI 多维度K线原型 v0.2 —— 渲染与交互引擎
   D1 量比宽度 / D2 收盘强度 / D3 ATR光晕 / D4 缠论结构 / D5 Fib时间窗
   D6 成份股广度 / D7 等成交额轴 / D8 周线级别嵌套 */
'use strict';

/* ---------- 数据 ---------- */
const N = RAW.length;
const D = i => RAW[i][0];
const O = i => RAW[i][1];
const H = i => RAW[i][2];
const L = i => RAW[i][3];
const C = i => RAW[i][4];
const V = i => RAW[i][5];
// BREADTH[i] = [广度%, 上涨家数, 总数, 最大贡献股名, 贡献bp]

/* ---------- 基础指标 ---------- */
const volMA = new Array(N).fill(0);
for (let i = 0; i < N; i++) {
  let s = 0, c = 0;
  for (let j = Math.max(0, i - 19); j <= i; j++) { if (V(j) > 0) { s += V(j); c++; } }
  volMA[i] = c ? s / c : 1;
}
const volRatio = new Array(N).fill(1);
for (let i = 0; i < N; i++) volRatio[i] = V(i) > 0 ? V(i) / volMA[i] : 1;

const strength = new Array(N).fill(.5);
for (let i = 0; i < N; i++) {
  const r = H(i) - L(i);
  strength[i] = r > 0 ? (C(i) - L(i)) / r : .5;
}

const TR = new Array(N).fill(0);
for (let i = 1; i < N; i++)
  TR[i] = Math.max(H(i) - L(i), Math.abs(H(i) - C(i - 1)), Math.abs(L(i) - C(i - 1)));
TR[0] = H(0) - L(0);
const ATR = new Array(N).fill(0);
{
  let s = 0;
  for (let i = 0; i < N; i++) {
    s += TR[i];
    if (i >= 14) s -= TR[i - 14];
    ATR[i] = i >= 13 ? s / 14 : s / (i + 1);
  }
}
const atrPct = new Array(N).fill(0);
for (let i = 0; i < N; i++) {
  const lo = Math.max(0, i - 119);
  let below = 0, tot = 0;
  for (let j = lo; j <= i; j++) { tot++; if (ATR[j] <= ATR[i]) below++; }
  atrPct[i] = tot > 1 ? below / tot : .5;
}

/* ---------- 通用缠论构件（简化：不处理包含关系） ---------- */
function buildPivots(n, Hf, Lf) {
  const fr = new Array(n).fill(0);
  for (let i = 2; i < n - 2; i++) {
    if (Hf(i) > Hf(i-1) && Hf(i) > Hf(i-2) && Hf(i) >= Hf(i+1) && Hf(i) >= Hf(i+2)) fr[i] = 1;
    if (Lf(i) < Lf(i-1) && Lf(i) < Lf(i-2) && Lf(i) <= Lf(i+1) && Lf(i) <= Lf(i+2)) fr[i] = -1;
  }
  const pv = [];
  for (let i = 0; i < n; i++) {
    if (!fr[i]) continue;
    const t = fr[i], p = t === 1 ? Hf(i) : Lf(i), last = pv[pv.length - 1];
    if (last && last.t === t) {
      if ((t === 1 && p > last.p) || (t === -1 && p < last.p)) { last.i = i; last.p = p; }
    } else if (last && i - last.i < 2) { /* 距离过近忽略 */ }
    else pv.push({ i, t, p });
  }
  return { fr, pv };
}
function buildPensZones(pv) {
  const pens = [];
  for (let k = 1; k < pv.length; k++)
    pens.push({ a: pv[k-1], b: pv[k],
      hi: Math.max(pv[k-1].p, pv[k].p), lo: Math.min(pv[k-1].p, pv[k].p) });
  const zones = [];
  for (let k = 2; k < pens.length; k++) {
    const zg = Math.min(pens[k-2].hi, pens[k-1].hi, pens[k].hi);
    const zd = Math.max(pens[k-2].lo, pens[k-1].lo, pens[k].lo);
    if (zg > zd) {
      if (zones.length && zones[zones.length-1].end === Infinity)
        zones[zones.length-1].end = pens[k-2].a.i;
      zones.push({ start: pens[k-2].a.i, end: Infinity, zg, zd });
    }
  }
  return { pens, zones };
}

/* ---------- D4 日线缠论 ---------- */
const daily = buildPivots(N, H, L);
const frac = daily.fr, pivots = daily.pv;
const { pens, zones } = buildPensZones(pivots);

/* ---------- D8 周线级别嵌套 ---------- */
const weeks = [];               // {s,e,o,h,l,c}
const dayWeek = new Array(N).fill(0);
{
  let lastKey = '';
  for (let i = 0; i < N; i++) {
    const d = new Date(D(i) + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow);
    const key = mon.toISOString().slice(0, 10);
    if (key !== lastKey) { weeks.push({ s: i, e: i, o: O(i), h: H(i), l: L(i), c: C(i) }); lastKey = key; }
    const wk = weeks[weeks.length - 1];
    wk.e = i; wk.h = Math.max(wk.h, H(i)); wk.l = Math.min(wk.l, L(i)); wk.c = C(i);
    dayWeek[i] = weeks.length - 1;
  }
}
const NW = weeks.length;
const WH = i => weeks[i].h, WL = i => weeks[i].l;
const weekly = buildPivots(NW, WH, WL);
const wz = buildPensZones(weekly.pv);
// 每个交易日的周线状态：1=上升笔 -1=下降笔 2=周线中枢内
const wState = new Array(N).fill(0);
for (const p of wz.pens) {
  const dir = p.b.p > p.a.p ? 1 : -1;
  for (let w = p.a.i; w <= p.b.i; w++)
    for (let i = weeks[w].s; i <= weeks[w].e; i++) wState[i] = dir;
}
for (const z of wz.zones) {
  const we = z.end === Infinity ? NW - 1 : z.end;
  for (let w = z.start; w <= we; w++)
    for (let i = weeks[w].s; i <= weeks[w].e; i++) wState[i] = 2;
}

/* ---------- D5 Fib 时间窗 ---------- */
const FIBS = [8, 13, 21, 34, 55, 89, 144];
let anchorIdx = 0;
function setAnchor(type) {
  let bi = 0;
  for (let i = 1; i < N; i++) {
    if (type === 'low' && L(i) < L(bi)) bi = i;
    if (type === 'high' && H(i) > H(bi)) bi = i;
  }
  anchorIdx = bi;
  document.getElementById('anchorInfo').innerHTML = '锚点：<b>' + D(bi) + '</b> ' +
    (type === 'low' ? '最低 <b class="dn">' + L(bi).toFixed(0) : '最高 <b class="up">' + H(bi).toFixed(0)) + '</b>';
}
setAnchor('low');

/* ---------- D9 转折点预警（合成指标） ---------- */
// 南向资金对齐 & 分位
const sbVal = new Array(N).fill(null);
{
  const m = {};
  for (const r of SB) m[r[0]] = r[1];
  for (let i = 0; i < N; i++) if (m[D(i)] !== undefined) sbVal[i] = m[D(i)];
}
const sbSorted = sbVal.filter(v => v !== null).slice().sort((a, b) => a - b);
const sbPct = sbVal.map(v => {
  if (v === null || !sbSorted.length) return .5;
  let lo = 0, hi2 = sbSorted.length;
  while (lo < hi2) { const mid = (lo + hi2) >> 1; if (sbSorted[mid] <= v) lo = mid + 1; else hi2 = mid; }
  return lo / sbSorted.length;
});
// 量能滚动分位（60日）
const volPct = new Array(N).fill(.5);
for (let i = 0; i < N; i++) {
  if (V(i) <= 0) continue;
  const lo = Math.max(0, i - 59); let tot = 0, below = 0;
  for (let j = lo; j <= i; j++) { if (V(j) <= 0) continue; tot++; if (V(j) <= V(i)) below++; }
  volPct[i] = tot ? below / tot : .5;
}
// 广度5日均值 & 多日背离 & 涨跌幅
const bp5 = new Array(N).fill(50);
for (let i = 0; i < N; i++) {
  let s = 0, c = 0;
  for (let j = Math.max(0, i - 4); j <= i; j++) { s += BREADTH[j][0]; c++; }
  bp5[i] = s / c;
}
const chgPct = new Array(N).fill(0);
for (let i = 1; i < N; i++) chgPct[i] = (C(i) - C(i - 1)) / C(i - 1) * 100;
const divSlow = new Array(N).fill(false);
for (let i = 5; i < N; i++) {
  let hi5 = true;
  for (let j = i - 5; j < i; j++) if (C(j) > C(i)) { hi5 = false; break; }
  divSlow[i] = hi5 && bp5[i] < bp5[i - 3];
}
// 计分：底警 = 放量恐慌 + 收最低 + 高波环境 + 南向抄底（4选3）
//      顶警 = 广度背离 + 赶顶阳线 + 南向流出/放量（3选2）
const botScore = new Array(N).fill(0), topScore = new Array(N).fill(0);
for (let i = 0; i < N; i++) {
  botScore[i] = (volPct[i] >= .85 ? 1 : 0) + (strength[i] <= .20 ? 1 : 0)
    + (atrPct[i] >= .60 ? 1 : 0) + (sbPct[i] >= .60 ? 1 : 0);
  topScore[i] = (divSlow[i] ? 1 : 0) + (strength[i] >= .85 && chgPct[i] >= 1 ? 1 : 0)
    + ((sbPct[i] <= .15 || volPct[i] >= .85) ? 1 : 0);
}
// 聚类：5根K线内只标第一个
function clusterAlerts(score, th) {
  const out = []; let last = -99;
  for (let i = 0; i < N; i++)
    if (score[i] >= th && i - last > 5) { out.push(i); last = i; }
  return out;
}
const botAlerts = clusterAlerts(botScore, 3);
const topAlerts = clusterAlerts(topScore, 2);

/* ---------- 视图状态 ---------- */
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const stage = document.getElementById('stage');
const tip = document.getElementById('tip');
let W = 0, Hh = 0;
const PAD_R = 64, PAD_B = 26, PAD_T = 14, PAD_L = 8, STRIP_H = 14, SB_H = 12;

const view = { end: N - 1, span: 90 };
const dim = { width: true, sat: true, atr: true, chan: true, fib: true,
              breadth: true, eqvol: false, weekly: true, alert: true, classic: false };

// 当前布局缓存（供 hover 反查）
let lay = { xs: [], ws: [], s: 0, e: 0 };

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = stage.clientWidth; Hh = stage.clientHeight;
  cv.width = W * dpr; cv.height = Hh * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
window.addEventListener('resize', resize);

function visibleRange() {
  const e = Math.min(N - 1, Math.round(view.end));
  const s = Math.max(0, Math.round(view.end - view.span + 1));
  return [s, e];
}

/* ---------- D7 轴布局：时间轴 / 等成交额轴 ---------- */
function layoutAxis(s, e) {
  const plotW = W - PAD_L - PAD_R;
  const m = e - s + 1;
  const xs = new Array(m), ws = new Array(m);
  if (!dim.eqvol || dim.classic) {
    const slot = plotW / m;
    for (let k = 0; k < m; k++) { xs[k] = PAD_L + (k + .5) * slot; ws[k] = slot; }
  } else {
    let tot = 0;
    const vw = new Array(m);
    for (let k = 0; k < m; k++) {
      vw[k] = Math.max(V(s + k), volMA[s + k] * .05);
      tot += vw[k];
    }
    let acc = PAD_L;
    for (let k = 0; k < m; k++) {
      const w = vw[k] / tot * plotW;
      xs[k] = acc + w / 2; ws[k] = w; acc += w;
    }
  }
  lay = { xs, ws, s, e };
}
const LX = i => lay.xs[i - lay.s];
const LW = i => lay.ws[i - lay.s];

/* ---------- 颜色 ---------- */
function candleColor(i) {
  const up = C(i) >= O(i);
  if (dim.classic || !dim.sat) return up ? '#f87171' : '#34d399';
  const s = up ? strength[i] : 1 - strength[i];
  const sat = 28 + 62 * s, lit = 46 + 16 * s;
  return up ? `hsl(4 ${sat}% ${lit}%)` : `hsl(160 ${sat * .9}% ${lit * .8}%)`;
}
function candleWidth(i) {
  const slot = LW(i);
  if (dim.eqvol && !dim.classic) return slot * .9;         // 等成交额轴下宽度已被占用
  if (dim.classic || !dim.width) return slot * .62;
  const r = Math.max(.25, Math.min(2.2, volRatio[i]));
  return slot * (.30 + .70 * (r - .25) / (2.2 - .25));
}
function breadthColor(b) {
  if (b >= 50) { const t = (b - 50) / 50; return `hsl(4 ${30 + 60 * t}% ${30 + 22 * t}%)`; }
  const t = (50 - b) / 50; return `hsl(160 ${30 + 55 * t}% ${28 + 20 * t}%)`;
}

/* ---------- 绘制 ---------- */
function draw() {
  ctx.clearRect(0, 0, W, Hh);
  const [s, e] = visibleRange();
  if (e <= s) return;
  layoutAxis(s, e);
  const plotW = W - PAD_L - PAD_R, plotH = Hh - PAD_T - PAD_B - STRIP_H - SB_H;

  let hi = -Infinity, lo = Infinity;
  for (let i = s; i <= e; i++) { hi = Math.max(hi, H(i)); lo = Math.min(lo, L(i)); }
  const pad = (hi - lo) * .07 || 1; hi += pad; lo -= pad;
  const Y = p => PAD_T + (hi - p) / (hi - lo) * plotH;

  // --- D8 周线状态背景 ---
  if (dim.weekly && !dim.classic) {
    let i = s;
    while (i <= e) {
      const st = wState[i];
      let j = i;
      while (j + 1 <= e && wState[j + 1] === st) j++;
      if (st !== 0) {
        const x1 = LX(i) - LW(i) / 2, x2 = LX(j) + LW(j) / 2;
        ctx.fillStyle = st === 2 ? 'rgba(139,92,246,.07)'
          : st === 1 ? 'rgba(248,113,113,.045)' : 'rgba(52,211,153,.045)';
        ctx.fillRect(x1, PAD_T, x2 - x1, plotH);
      }
      i = j + 1;
    }
  }

  // --- 网格 & 价格轴 ---
  ctx.font = '10px "JetBrains Mono",monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / 5)));
  const gStep = (hi - lo) / 5 / step > 2 ? step * 2 : step;
  for (let p = Math.ceil(lo / gStep) * gStep; p <= hi; p += gStep) {
    const y = Y(p);
    ctx.strokeStyle = 'rgba(26,37,64,.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.48)';
    ctx.fillText(p.toFixed(0), W - PAD_R + 8, y);
  }

  // --- D6 广度热力条 + 南向资金热力条 ---
  const stripY = Hh - PAD_B - SB_H - STRIP_H;   // 广度条
  const sbY = Hh - PAD_B - SB_H;                // 南向条
  if (dim.breadth && !dim.classic) {
    for (let i = s; i <= e; i++) {
      ctx.fillStyle = breadthColor(BREADTH[i][0]);
      ctx.globalAlpha = .75;
      ctx.fillRect(LX(i) - LW(i) / 2 + .5, stripY + 2, Math.max(1, LW(i) - 1), STRIP_H - 4);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.textAlign = 'left';
    ctx.fillText('广度', PAD_L, stripY - 6);
  }
  if (dim.alert && !dim.classic) {
    for (let i = s; i <= e; i++) {
      const v = sbVal[i];
      if (v === null) { ctx.fillStyle = 'rgba(255,255,255,.06)'; }
      else {
        const t = Math.min(1, Math.abs(v) / 15000);   // 150亿为满刻度
        ctx.fillStyle = v >= 0 ? `rgba(34,211,238,${.15 + .75 * t})` : `rgba(251,146,60,${.15 + .75 * t})`;
      }
      ctx.fillRect(LX(i) - LW(i) / 2 + .5, sbY + 1, Math.max(1, LW(i) - 1), SB_H - 2);
    }
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.textAlign = 'left';
    ctx.fillText('南向', PAD_L, sbY + SB_H - 2);
  }

  // --- 日期轴 ---
  ctx.textAlign = 'center';
  const lblEvery = Math.max(1, Math.round((e - s) / 8));
  for (let i = s; i <= e; i++) {
    if ((i - s) % lblEvery) continue;
    ctx.fillStyle = 'rgba(255,255,255,.38)';
    ctx.fillText(D(i).slice(5), LX(i), Hh - PAD_B / 2);
  }

  // --- D5 Fib 时间线 ---
  if (dim.fib && !dim.classic) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const f of FIBS) {
      const i = anchorIdx + f;
      if (i < s || i > Math.min(e, N - 1)) continue;
      ctx.strokeStyle = 'rgba(251,191,36,.35)'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(LX(i), PAD_T); ctx.lineTo(LX(i), stripY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fbbf24';
      ctx.fillText('F' + f, LX(i), PAD_T + 3);
    }
    if (anchorIdx >= s && anchorIdx <= e) {
      ctx.strokeStyle = 'rgba(251,191,36,.8)';
      ctx.beginPath(); ctx.moveTo(LX(anchorIdx), PAD_T); ctx.lineTo(LX(anchorIdx), stripY); ctx.stroke();
      ctx.fillStyle = '#fbbf24';
      ctx.fillText('锚 ' + D(anchorIdx).slice(5), LX(anchorIdx), stripY - 14);
    }
  }

  // --- D4 日线中枢色带 ---
  if (dim.chan && !dim.classic) {
    const visZones = zones.filter(z => Math.min(z.end === Infinity ? N - 1 : z.end, e) > Math.max(z.start, s));
    visZones.forEach((z, k) => {
      const zs = Math.max(z.start, s), ze = Math.min(z.end === Infinity ? N - 1 : z.end, e);
      const x1 = LX(zs) - LW(zs) / 2, x2 = LX(ze) + LW(ze) / 2;
      const recent = k >= visZones.length - 3;
      ctx.fillStyle = 'rgba(129,140,248,' + (recent ? '.07' : '.04') + ')';
      ctx.fillRect(x1, Y(z.zg), x2 - x1, Y(z.zd) - Y(z.zg));
      if (!recent) return;
      ctx.strokeStyle = 'rgba(129,140,248,.38)'; ctx.lineWidth = 1;
      ctx.strokeRect(x1, Y(z.zg), x2 - x1, Y(z.zd) - Y(z.zg));
      ctx.fillStyle = 'rgba(165,180,252,.9)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('中枢 ' + z.zd.toFixed(0) + '–' + z.zg.toFixed(0),
        x1 + 4, Y(z.zg) + 8 + (visZones.length - 1 - k) * 11);
    });
  }

  // --- K线 ---
  for (let i = s; i <= e; i++) {
    const x = LX(i), up = C(i) >= O(i), col = candleColor(i);
    const bw = Math.min(candleWidth(i), LW(i) * .98);
    const yO = Y(O(i)), yC = Y(C(i)), yH = Y(H(i)), yL = Y(L(i));
    const bodyT = Math.min(yO, yC), bodyH = Math.max(1.2, Math.abs(yC - yO));

    // D3 波动率光晕
    if (dim.atr && !dim.classic && atrPct[i] >= .8) {
      ctx.save();
      ctx.shadowColor = atrPct[i] >= .92 ? 'rgba(251,191,36,.9)' : 'rgba(34,211,238,.7)';
      ctx.shadowBlur = 14;
      ctx.strokeStyle = atrPct[i] >= .92 ? 'rgba(251,191,36,.85)' : 'rgba(34,211,238,.6)';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(x - bw / 2 - 2, yH - 2, bw + 4, yL - yH + 4);
      ctx.restore();
    }

    // 影线
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, bw * .12);
    ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
    // 实体
    let fill = col;
    if (!dim.classic && dim.sat) {
      const g = ctx.createLinearGradient(0, bodyT, 0, bodyT + bodyH);
      const strong = `hsl(${up ? 4 : 160} 95% ${up ? 66 : 56}%)`;
      g.addColorStop(up ? 1 : 0, strong);
      g.addColorStop(up ? 0 : 1, col);
      fill = g;
    }
    ctx.fillStyle = fill;
    ctx.fillRect(x - bw / 2, bodyT, bw, bodyH);

    // D6 假阳/假阴警示点
    if (dim.breadth && !dim.classic) {
      const b = BREADTH[i][0];
      if (up && b <= 35) {
        ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, yH - 10, 3, 0, Math.PI * 2); ctx.stroke();
      } else if (!up && b >= 65) {
        ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, yL + 10, 3, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // D4 分型标记
    if (dim.chan && !dim.classic && frac[i]) {
      ctx.fillStyle = frac[i] === 1 ? '#818cf8' : '#a5b4fc';
      ctx.beginPath();
      if (frac[i] === 1) { ctx.moveTo(x, yH - 8); ctx.lineTo(x - 4, yH - 2); ctx.lineTo(x + 4, yH - 2); }
      else { ctx.moveTo(x, yL + 8); ctx.lineTo(x - 4, yL + 2); ctx.lineTo(x + 4, yL + 2); }
      ctx.closePath(); ctx.fill();
    }
  }

  // --- D4 日线笔 ---
  if (dim.chan && !dim.classic) {
    ctx.strokeStyle = 'rgba(129,140,248,.55)'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (const p of pivots) {
      if (p.i < s || p.i > e) { started = false; continue; }
      if (!started) { ctx.moveTo(LX(p.i), Y(p.p)); started = true; }
      else ctx.lineTo(LX(p.i), Y(p.p));
    }
    ctx.stroke();
  }

  // --- D8 周线笔（粗线叠加） ---
  if (dim.weekly && !dim.classic) {
    ctx.strokeStyle = 'rgba(167,139,250,.5)'; ctx.lineWidth = 2.5;
    ctx.setLineDash([1, 0]);
    ctx.beginPath();
    let started = false;
    for (const p of weekly.pv) {
      const di = Math.min(weeks[p.i].e, N - 1);
      if (di < s || di > e) { started = false; continue; }
      if (!started) { ctx.moveTo(LX(di), Y(p.p)); started = true; }
      else ctx.lineTo(LX(di), Y(p.p));
    }
    ctx.stroke();
  }

  // --- D9 转折点预警标记 ---
  if (dim.alert && !dim.classic) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const i of botAlerts) {
      if (i < s || i > e) continue;
      const x = LX(i), y = Y(L(i)) + 20;
      ctx.fillStyle = 'rgba(52,211,153,.18)';
      ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#34d399';
      ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x - 6, y + 5); ctx.lineTo(x + 6, y + 5); ctx.closePath(); ctx.fill();
      ctx.font = 'bold 9px "JetBrains Mono",monospace';
      ctx.fillText('底警' + botScore[i], x, y + 16);
    }
    for (const i of topAlerts) {
      if (i < s || i > e) continue;
      const x = LX(i), y = Y(H(i)) - 20;
      ctx.fillStyle = 'rgba(251,191,36,.16)';
      ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath(); ctx.moveTo(x, y + 3); ctx.lineTo(x - 6, y - 5); ctx.lineTo(x + 6, y - 5); ctx.closePath(); ctx.fill();
      ctx.font = 'bold 9px "JetBrains Mono",monospace';
      ctx.fillText('顶警' + topScore[i], x, y - 15);
    }
  }

  // --- 最新价标签 ---
  const lastC = C(N - 1);
  if (lastC > lo && lastC < hi) {
    const y = Y(lastC);
    ctx.fillStyle = C(N - 1) >= O(N - 1) ? '#f87171' : '#34d399';
    ctx.fillRect(W - PAD_R + 2, y - 8, PAD_R - 6, 16);
    ctx.fillStyle = '#050810'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(lastC.toFixed(0), W - PAD_R + 7, y);
  }
  // 边框
  ctx.strokeStyle = '#1a2540';
  ctx.strokeRect(PAD_L, PAD_T, plotW, plotH);
}

/* ---------- 交互：悬停 ---------- */
cv.addEventListener('mousemove', ev => {
  const r = cv.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  const [s, e] = visibleRange();
  let i = -1;
  for (let k = s; k <= e; k++) {
    if (mx >= LX(k) - LW(k) / 2 && mx < LX(k) + LW(k) / 2) { i = k; break; }
  }
  const plotH = Hh - PAD_T - PAD_B - STRIP_H - SB_H;
  if (i < 0 || my < PAD_T || my > Hh - PAD_B) { tip.style.display = 'none'; draw(); return; }
  draw();
  // 十字线
  const x = LX(i);
  let hi2 = -Infinity, lo2 = Infinity;
  for (let k = s; k <= e; k++) { hi2 = Math.max(hi2, H(k)); lo2 = Math.min(lo2, L(k)); }
  const pad = (hi2 - lo2) * .07 || 1; hi2 += pad; lo2 -= pad;
  const price = hi2 - (my - PAD_T) / plotH * (hi2 - lo2);
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, Hh - PAD_B - STRIP_H - SB_H);
  ctx.moveTo(PAD_L, my); ctx.lineTo(W - PAD_R, my); ctx.stroke();
  ctx.setLineDash([]);
  if (my < Hh - PAD_B - STRIP_H - SB_H) {
    ctx.fillStyle = '#0c1220'; ctx.fillRect(W - PAD_R + 2, my - 8, PAD_R - 6, 16);
    ctx.strokeStyle = '#1a2540'; ctx.strokeRect(W - PAD_R + 2, my - 8, PAD_R - 6, 16);
    ctx.fillStyle = '#22d3ee'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '10px "JetBrains Mono",monospace';
    ctx.fillText(price.toFixed(0), W - PAD_R + 7, my);
  }

  // 悬浮读数
  const chg = (C(i) - O(i)) / O(i) * 100;
  const upCls = C(i) >= O(i) ? 'up' : 'dn';
  const fibHit = FIBS.includes(i - anchorIdx)
    ? `<div class="row"><span class="k">Fib时间窗</span><span class="v am">F${i - anchorIdx}</span></div>` : '';
  const fracTxt = frac[i] === 1 ? '<span class="v" style="color:#818cf8">顶分型 ▲</span>'
    : frac[i] === -1 ? '<span class="v" style="color:#a5b4fc">底分型 ▼</span>' : '<span class="v">—</span>';
  const B = BREADTH[i];
  const bCls = B[0] >= 60 ? 'up' : B[0] <= 40 ? 'dn' : '';
  const wkTxt = wState[i] === 2 ? '<span class="v" style="color:#a78bfa">周线中枢内</span>'
    : wState[i] === 1 ? '<span class="v up">周线上升笔 ↑</span>'
    : wState[i] === -1 ? '<span class="v dn">周线下降笔 ↓</span>' : '<span class="v">—</span>';
  const div = (C(i) >= O(i) && B[0] <= 35) ? '<div class="row"><span class="k">警示</span><span class="v am">假阳线（广度背离）</span></div>'
    : (C(i) < O(i) && B[0] >= 65) ? '<div class="row"><span class="k">警示</span><span class="v am">假阴线（广度背离）</span></div>' : '';
  const sbTxt = sbVal[i] === null ? '<span class="v">—</span>'
    : `<span class="v" style="color:${sbVal[i] >= 0 ? '#22d3ee' : '#fb923c'}">${sbVal[i] >= 0 ? '+' : ''}${(sbVal[i] / 100).toFixed(1)}亿 (${(sbPct[i] * 100).toFixed(0)}%分位)</span>`;
  const alertTxt = botScore[i] >= 3 ? `<span class="v" style="color:#34d399">底警 ${botScore[i]}/4</span>`
    : topScore[i] >= 2 ? `<span class="v am">顶警 ${topScore[i]}/3</span>` : '<span class="v">—</span>';
  tip.innerHTML =
    `<div class="d">${D(i)}</div>` +
    `<div class="row"><span class="k">开 / 高</span><span class="v">${O(i).toFixed(0)} / ${H(i).toFixed(0)}</span></div>` +
    `<div class="row"><span class="k">低 / 收</span><span class="v">${L(i).toFixed(0)} / <span class="${upCls}">${C(i).toFixed(0)}</span></span></div>` +
    `<div class="row"><span class="k">涨跌幅</span><span class="v ${chg >= 0 ? 'up' : 'dn'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span></div>` +
    `<div class="sep"></div>` +
    `<div class="row"><span class="k">D1 量比</span><span class="v cy">${volRatio[i].toFixed(2)}×</span></div>` +
    `<div class="row"><span class="k">D2 收盘强度</span><span class="v">${(strength[i] * 100).toFixed(0)}%</span></div>` +
    `<div class="row"><span class="k">D3 ATR分位</span><span class="v ${atrPct[i] >= .8 ? 'am' : ''}">${(atrPct[i] * 100).toFixed(0)}%</span></div>` +
    `<div class="row"><span class="k">D4 分型</span>${fracTxt}</div>` +
    `<div class="row"><span class="k">D6 广度</span><span class="v ${bCls}">${B[1]}/${B[2]} 涨 (${B[0]}%)</span></div>` +
    `<div class="row"><span class="k">最大贡献</span><span class="v">${B[3]} ${B[4] >= 0 ? '+' : ''}${B[4]}bp</span></div>` + div +
    `<div class="row"><span class="k">D8 级别</span>${wkTxt}</div>` +
    `<div class="row"><span class="k">D9 南向净买</span>${sbTxt}</div>` +
    `<div class="row"><span class="k">D9 预警</span>${alertTxt}</div>` + fibHit;
  tip.style.display = 'block';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = (mx + 18 + tw > W ? mx - tw - 14 : mx + 18) + 'px';
  tip.style.top = Math.min(Math.max(8, my - th / 2), Hh - th - 8) + 'px';
});
cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; draw(); });

/* ---------- 交互：平移 / 缩放 / 复位 ---------- */
let dragX = null;
cv.addEventListener('mousedown', ev => { dragX = ev.clientX; cv.style.cursor = 'grabbing'; });
window.addEventListener('mouseup', () => { dragX = null; cv.style.cursor = 'crosshair'; });
window.addEventListener('mousemove', ev => {
  if (dragX === null) return;
  const plotW = W - PAD_L - PAD_R, slot = plotW / view.span;
  view.end -= (ev.clientX - dragX) / slot;
  view.end = Math.max(view.span * .5, Math.min(N - 1 + view.span * .3, view.end));
  dragX = ev.clientX;
  tip.style.display = 'none';
  draw();
});
cv.addEventListener('wheel', ev => {
  ev.preventDefault();
  const f = ev.deltaY > 0 ? 1.12 : 1 / 1.12;
  view.span = Math.max(20, Math.min(N, view.span * f));
  view.end = Math.max(view.span * .5, Math.min(N - 1 + view.span * .3, view.end));
  draw();
}, { passive: false });
cv.addEventListener('dblclick', () => { view.end = N - 1; view.span = 90; draw(); });

/* ---------- 控件 ---------- */
document.querySelectorAll('.dim').forEach(el => {
  el.addEventListener('click', ev => {
    ev.preventDefault();
    const d = el.dataset.dim;
    dim[d] = !dim[d];
    el.classList.toggle('on', dim[d]);
    el.classList.toggle('off', !dim[d]);
    draw();
  });
});
document.querySelectorAll('#anchorChips .chip').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('#anchorChips .chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    setAnchor(el.dataset.a);
    draw();
  });
});

document.getElementById('hdrRange').textContent = D(0) + ' → ' + D(N - 1);
document.getElementById('hdrN').textContent = N;
resize();
