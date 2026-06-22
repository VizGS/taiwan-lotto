'use strict';

/*
 * 台灣彩券開獎查詢純靜態版核心邏輯
 * 取代原 CodeIgniter 後端：瀏覽器直接 fetch 台灣彩券官方 API，
 * 前端統計號碼出現次數並渲染表格，直方圖以 CSS <div> 取代原 GD PNG。
 *
 * 注意：api.taiwanlottery.com/TLCAPIWeB/* 為台彩官網「非公開」內部 API，
 * 無公開文件與版本承諾；若官方收緊 CORS 或改格式，靜態版無後端 proxy 可緩衝。
 */

const API_BASE = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery';

// 直方圖高度分母：忠實重現原碼行為。
// 原 Chart->index($count, $corder, $max_results='20') 因 controller 簽章只收 $count，
// max_results 被吃掉，bar 高度一律以 20 為分母（round(count / 20 * 100) * 2）。
const BAR_DIVISOR = 20;
const BAR_COLOR_MAIN = '800080';   // 第一區（紫）
const BAR_COLOR_SECOND = '000080'; // 威力彩第二區（深藍）

const MAX_RESULTS_CAP = 500;       // 單次查詢筆數上限
const MONTHS_BACK_CAP = 60;        // 逐月往前翻最大深度（防無限迴圈的硬上限）
const FETCH_TIMEOUT_MS = 15000;    // 單次 fetch 逾時（慢網路不卡死）

const NAV = [
  { id: 'lotto539', label: '今彩539' },
  { id: 'lottobig', label: '大樂透' },
  { id: 'lottosuper', label: '威力彩' },
  { id: 'lotto4', label: '四星彩' },
];

const DEFAULT_STANDARD = {
  mobile: { size: 16, width: 150, height: 80 },
  desktop: { size: 20, width: 100, height: 100 },
};
const DEFAULT_LOTTO4 = {
  mobile: { size: 30, width: 30, height: 100 },
  desktop: { size: 30, width: 30, height: 100 },
};

const GAMES = {
  lotto539: {
    title: '今彩539',
    endpoint: 'Daily539Result',
    contentKey: 'daily539Res',
    mainMax: 39,        // 號碼 1..39
    special: false,
    secondMax: 0,
    hasCount: true,
    categoryFontSize: 30,
    defaults: DEFAULT_STANDARD,
  },
  lottobig: {
    title: '大樂透',
    endpoint: 'Lotto649Result',
    contentKey: 'lotto649Res',
    mainMax: 49,        // 號碼 1..49
    special: true,      // drawNumberAppear 最後一碼為特別號（藍底），出現次數仍含特別號
    secondMax: 0,
    hasCount: true,
    categoryFontSize: 30,
    defaults: DEFAULT_STANDARD,
  },
  lottosuper: {
    title: '威力彩',
    endpoint: 'SuperLotto638Result',
    contentKey: 'superLotto638Res',
    mainMax: 38,        // 第一區 1..38
    special: false,
    secondMax: 8,       // 第二區 1..8（drawNumberAppear 最後一碼 pop 出）
    hasCount: true,
    categoryFontSize: 25,
    defaults: DEFAULT_STANDARD,
  },
  lotto4: {
    title: '四星彩',
    endpoint: '4DResult',
    contentKey: 'lotto4DRes',
    digits: true,       // 4 碼大字顯示，無統計、無直方圖
    hasCount: false,
    categoryFontSize: 20,
    defaults: DEFAULT_LOTTO4,
  },
};

// ===== 工具 =====
function pad2(n) {
  return String(n).padStart(2, '0'); // 取代 sprintf('%02d')
}

function range1(max) {
  // 產生 [1, 2, ..., max]
  return Array.from({ length: max }, (_, i) => i + 1);
}

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches; // 取代 is_mobile()
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 等價 PHP array_count_values
function countValues(numbers) {
  const counts = {};
  for (const n of numbers) {
    counts[n] = (counts[n] || 0) + 1;
  }
  return counts;
}

// 忠實重現 Chart.php：round(count / 20 * 100) * 2
function barHeightPx(count) {
  return Math.round((count / BAR_DIVISOR) * 100) * 2;
}

function readParams(game) {
  const sp = new URLSearchParams(window.location.search);
  const d = isMobile() ? game.defaults.mobile : game.defaults.desktop;
  const num = (key, def) => {
    const v = parseInt(sp.get(key), 10);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    maxResults: Math.min(num('max_results', 20), MAX_RESULTS_CAP),
    size: num('size', d.size),
    width: num('width', d.width),
    height: num('height', d.height),
  };
}

// ===== 抓資料（逐月往前翻，含終止守衛）=====
async function fetchMonth(game, month, pageSize) {
  const url = `${API_BASE}/${game.endpoint}?month=${month}&pageSize=${pageSize}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const json = await resp.json();
    return (json && json.content && json.content[game.contentKey]) || [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPeriods(game, maxResults) {
  const cap = Math.min(maxResults, MAX_RESULTS_CAP);
  const raw = [];
  const cursor = new Date();
  cursor.setDate(1); // 固定每月 1 號，避免月底日期溢位導致跳月
  let monthsWalked = 0;

  while (raw.length < cap && monthsWalked < MONTHS_BACK_CAP) {
    const month = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}`;
    const remaining = cap - raw.length;
    const monthData = await fetchMonth(game, month, remaining);

    if (monthData.length === 0) {
      break; // 空月份 → 已到歷史起點，停止（終止守衛，取代原本只靠 PHP timeout）
    }

    raw.push(...monthData);
    cursor.setMonth(cursor.getMonth() - 1);
    monthsWalked += 1;
  }

  return raw.slice(0, cap);
}

// raw 為 newest→oldest（API 當月最新在前 + 逐月往前）
function mapPeriods(game, raw) {
  return raw.map((item) => {
    const code = item.drawNumberAppear.slice();
    const date = String(item.lotteryDate).slice(0, 10); // 取 ISO 的 Y-m-d，不受時區影響
    if (game.secondMax > 0) {
      const second = code.pop(); // 等價 array_pop：最後一碼為第二區號
      return { period: item.period, code, second, date };
    }
    return { period: item.period, code, date };
  });
}

function buildCounts(game, periods) {
  if (!game.hasCount) {
    return null;
  }
  const mainNums = [];
  const secondNums = [];
  for (const p of periods) {
    // 539/大樂透：code 為全部開出號（大樂透含特別號）；威力彩：code 已去掉第二區
    for (const n of p.code) {
      mainNums.push(n);
    }
    if (game.secondMax > 0) {
      secondNums.push(p.second);
    }
  }
  return {
    main: countValues(mainNums),
    second: game.secondMax > 0 ? countValues(secondNums) : null,
  };
}

// ===== HTML 片段 =====
function navColspans(totalCols) {
  const base = Math.floor(totalCols / 4);
  const remainder = totalCols % 4; // 餘數分配給前幾個（比照原 view 的 colspan 分布）
  return NAV.map((_, idx) => base + (idx < remainder ? 1 : 0));
}

function navRowHtml(game, totalCols) {
  const spans = navColspans(totalCols);
  const cells = NAV.map((n, idx) => (
    `<td colspan="${spans[idx]}">`
    + `<button type="button" class="category" style="font-size:${game.categoryFontSize}px" `
    + `data-href="${n.id}.html">${n.label}</button></td>`
  )).join('');
  return `<tr>${cells}</tr>`;
}

function formRowHtml(params, totalCols) {
  return `<tr><td colspan="${totalCols}" class="form-cell">
    <form id="queryForm">
      筆數：<input type="number" name="max_results" min="1" value="${params.maxResults}">
      字體大小：<input type="number" name="size" min="1" value="${params.size}">
      高：<input type="number" name="height" min="1" value="${params.height}">
      寬：<input type="number" name="width" min="1" value="${params.width}">
      <input type="submit" value="查詢">
      <button type="button" id="resetBtn">顯示最近20筆</button>
    </form>
  </td></tr>`;
}

function summaryRowHtml(game, viewPeriod, totalCols) {
  const n = viewPeriod.length;
  // 比對原 view：從 (period[count-1].date) 期 ～ (period[0].date) 期
  const from = n ? viewPeriod[n - 1].date : '';
  const to = n ? viewPeriod[0].date : '';
  return `<tr><td colspan="${totalCols}">
    <div class="summary">${game.title}開獎獎號總共查詢 <b>${n}</b> 期，從 (${from}) 期～ (${to}) 期</div>
  </td></tr>`;
}

// ===== 標準彩種（539 / 大樂透 / 威力彩）=====
function renderStandard(game, viewPeriod, counts, params) {
  const main = range1(game.mainMax);
  const second = range1(game.secondMax);
  const totalCols = 1 + game.mainMax + game.secondMax;
  const displayRows = viewPeriod.slice().reverse(); // 比對原 view 的 foreach(array_reverse($period))

  const rows = [];
  rows.push(navRowHtml(game, totalCols));
  rows.push(formRowHtml(params, totalCols));
  rows.push(summaryRowHtml(game, viewPeriod, totalCols));

  // 號碼表頭
  const mainHeader = main.map((i) => `<td class="num-header">${pad2(i)}</td>`).join('');
  const secondHeader = second.map((i) => `<td class="num-header num-header--second">${pad2(i)}</td>`).join('');
  rows.push(`<tr><td class="cell">期號</td>${mainHeader}${secondHeader}</tr>`);

  // 期別列
  for (const p of displayRows) {
    const specialVal = game.special ? p.code[p.code.length - 1] : null; // 大樂透特別號 = 最後一碼
    const mainCells = main.map((i) => {
      if (!p.code.includes(i)) {
        return '<td class="cell"></td>';
      }
      const cls = game.special && i === specialVal ? 'cell cell--special' : 'cell cell--hit';
      return `<td class="${cls}">${i}</td>`;
    }).join('');
    const secondCells = second.map((i) => (
      i === p.second ? `<td class="cell cell--second">${i}</td>` : '<td class="cell"></td>'
    )).join('');
    rows.push(`<tr class="period-row"><td class="cell">${escapeHtml(p.period)}</td>${mainCells}${secondCells}</tr>`);
  }

  // 標注號碼列
  const mainChk = main.map((i) => `<td class="chk"><p>${pad2(i)}</p></td>`).join('');
  const secondChk = second.map((i) => `<td class="chk chk--second"><p>${pad2(i)}</p></td>`).join('');
  rows.push(`<tr><td class="chk-label">標注號碼</td>${mainChk}${secondChk}</tr>`);

  // 出現次數列
  const countCell = (c, color) => (c
    ? `<td class="count-cell">${c}<br><div class="bar" style="height:${barHeightPx(c)}px;background:#${color}"></div></td>`
    : '<td class="count-cell">0</td>');
  const mainCount = main.map((i) => countCell(counts.main[i], BAR_COLOR_MAIN)).join('');
  const secondCount = second.map((i) => countCell(counts.second[i], BAR_COLOR_SECOND)).join('');
  rows.push(`<tr><td class="count-label"><b>出現次數</b></td>${mainCount}${secondCount}</tr>`);

  return `<table style="width:${params.width}%;height:${params.height}%">${rows.join('')}</table>`;
}

// ===== 四星彩 =====
function renderLotto4(game, viewPeriod, params) {
  const displayRows = viewPeriod.slice().reverse(); // 比對原 view 的 foreach(array_reverse($period))
  const totalCols = 5;

  const navCells = NAV.map((n) => (
    `<th><button type="button" class="category" style="font-size:${game.categoryFontSize}px" `
    + `data-href="${n.id}.html">${n.label}</button></th>`
  )).join('');

  const inputCells = [0, 1, 2, 3].map(() => (
    '<td class="input-cell"><input type="text" class="inputNumber" maxlength="1" inputmode="numeric"></td>'
  )).join('');

  const periodRows = displayRows.map((p) => {
    const digits = [0, 1, 2, 3].map((i) => `<td class="digit-cell"><strong>${escapeHtml(p.code[i] ?? '')}</strong></td>`).join('');
    return `<tr class="period-row"><td class="period-cell">${escapeHtml(p.period)}</td>${digits}</tr>`;
  }).join('');

  return `<table class="lotto4" style="width:${params.width}%;height:${params.height}%">
    <thead>
      <tr><th></th>${navCells}</tr>
      ${formRowHtml(params, totalCols)}
      ${summaryRowHtml(game, viewPeriod, totalCols)}
      <tr><td class="cell">期號</td><td class="cell" colspan="4">開獎號碼</td></tr>
    </thead>
    <tbody>
      <tr><td class="chk-label" style="font-size:23px">標注號碼</td>${inputCells}</tr>
      ${periodRows}
    </tbody>
  </table>`;
}

// ===== 顯示參數即時套用（size/width/height 不需重抓）=====
function applyDisplayParams(size, width, height) {
  document.body.style.fontSize = `${size}px`;
  const table = document.querySelector('#app table');
  if (table) {
    table.style.width = `${width}%`;
    table.style.height = `${height}%`;
  }
}

// ===== 主流程 =====
async function loadAndRender(game) {
  const app = document.getElementById('app');
  const status = document.getElementById('status');
  const params = readParams(game);

  applyDisplayParams(params.size, params.width, params.height);
  app.innerHTML = '';
  status.className = 'status';
  status.textContent = '查詢中…';

  try {
    const raw = await fetchPeriods(game, params.maxResults);
    const periods = mapPeriods(game, raw);
    // viewPeriod = 傳給 view 的 period 陣列：標準彩種維持 newest→oldest；
    // 四星彩比對原 controller 多做一次 array_reverse。
    const viewPeriod = game.digits ? periods.slice().reverse() : periods;

    if (game.digits) {
      app.innerHTML = renderLotto4(game, viewPeriod, params);
    } else {
      const counts = buildCounts(game, periods);
      app.innerHTML = renderStandard(game, viewPeriod, counts, params);
    }

    applyDisplayParams(params.size, params.width, params.height);
    status.textContent = '';
  } catch (err) {
    status.className = 'status status--error';
    status.innerHTML = '查詢失敗，請稍後再試。<button type="button" id="retryBtn">重試</button>';
  }
}

// ===== 事件（委派綁在持久容器 #app / #status 上，只綁一次，re-render 不需重綁）=====
let digitReverse = false;

function wireEvents(game) {
  const app = document.getElementById('app');
  const status = document.getElementById('status');

  app.addEventListener('click', (e) => {
    // 標注號碼點選反白
    const chk = e.target.closest('.chk');
    if (chk) {
      chk.classList.toggle('active');
    }
    // 上方彩種切換
    const navBtn = e.target.closest('[data-href]');
    if (navBtn) {
      window.location.href = navBtn.dataset.href;
    }
    // 顯示最近20筆：導回無參數頁（比對原行為）
    if (e.target.id === 'resetBtn') {
      window.location.href = `${getGameId()}.html`;
    }
  });

  app.addEventListener('input', (e) => {
    // size/width/height 即時套用（純顯示參數，零網路請求）
    const name = e.target.name;
    if (name === 'size' || name === 'width' || name === 'height') {
      const form = document.getElementById('queryForm');
      const d = isMobile() ? game.defaults.mobile : game.defaults.desktop;
      const get = (k, def) => {
        const v = parseInt(form.elements[k].value, 10);
        return Number.isFinite(v) && v > 0 ? v : def;
      };
      const size = get('size', d.size);
      const width = get('width', d.width);
      const height = get('height', d.height);
      applyDisplayParams(size, width, height);
      syncUrl({ size, width, height });
    }
    // 四星彩標注輸入：僅留數字
    if (e.target.classList.contains('inputNumber')) {
      e.target.value = e.target.value.replace(/[^0-9]/g, '');
    }
  });

  // 查詢：只有筆數改變才重抓；顯示參數已即時套用
  app.addEventListener('submit', (e) => {
    if (e.target.id !== 'queryForm') {
      return;
    }
    e.preventDefault();
    const form = e.target;
    const cur = readParams(game);
    const max = Math.min(parseInt(form.elements.max_results.value, 10) || 20, MAX_RESULTS_CAP);
    const size = parseInt(form.elements.size.value, 10) || cur.size;
    const width = parseInt(form.elements.width.value, 10) || cur.width;
    const height = parseInt(form.elements.height.value, 10) || cur.height;
    syncUrl({ max_results: max, size, width, height });
    loadAndRender(game);
  });

  // 四星彩鍵盤跳焦（委派在持久 #app，只綁一次；比對原 jQuery 邏輯）
  if (game.digits) {
    const sideInput = (input, back) => {
      const td = input.closest('td');
      const sib = back ? td.previousElementSibling : td.nextElementSibling;
      return sib ? sib.querySelector('.inputNumber') : null;
    };
    app.addEventListener('keyup', (e) => {
      const input = e.target;
      if (!input.classList.contains('inputNumber')) {
        return;
      }
      let next = sideInput(input, digitReverse);
      if (!sideInput(input, false) && !digitReverse) {
        digitReverse = true;
        next = input;
      }
      if (!sideInput(input, true) && digitReverse) {
        digitReverse = false;
        next = input;
      }
      if (next) {
        next.focus();
      }
    });
    app.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('inputNumber')) {
        e.target.value = '';
      }
    });
  }

  status.addEventListener('click', (e) => {
    if (e.target.id === 'retryBtn') {
      loadAndRender(game);
    }
  });
}

// ===== URL 同步 =====
function syncUrl(patch) {
  const sp = new URLSearchParams(window.location.search);
  Object.entries(patch).forEach(([k, v]) => sp.set(k, v));
  window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
}

function getGameId() {
  return document.body.dataset.game;
}

// ===== 進入點 =====
function init() {
  const game = GAMES[getGameId()];
  if (!game) {
    return;
  }
  document.title = game.title;
  wireEvents(game);
  loadAndRender(game);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

// 匯出供單元測試使用（瀏覽器環境忽略）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GAMES, pad2, range1, countValues, barHeightPx, mapPeriods, buildCounts,
    fetchPeriods, navColspans, readParams,
    MAX_RESULTS_CAP, MONTHS_BACK_CAP, BAR_DIVISOR,
  };
}
