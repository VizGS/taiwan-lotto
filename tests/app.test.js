'use strict';

/**
 * 測試目標：app.js 匯出的純函式 + fetchPeriods（終止守衛 regression）
 * 情境：Unit（node 環境，mock fetch）
 * Mock：globalThis.fetch（vi.stubGlobal）、window stub（readParams 用）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── readParams 依賴 window.location / window.matchMedia；
//    在 node 環境補最小 stub，讓 require() 不爆炸。
globalThis.window = {
  location: { search: '' },
  matchMedia: () => ({ matches: false }),
};

const {
  GAMES,
  pad2,
  range1,
  countValues,
  escapeHtml,
  mapPeriods,
  buildCounts,
  fetchPeriods,
  readParams,
  MAX_RESULTS_CAP,
  MONTHS_BACK_CAP,
} = require('../assets/app.js');

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * 建立假開獎資料一筆
 * @param {string} period  期號
 * @param {string} date    ISO datetime
 * @param {number[]} nums  drawNumberAppear
 */
function makeItem(period, date, nums) {
  return { period, lotteryDate: date, drawNumberAppear: nums };
}

/**
 * 建立 fetch mock，每次呼叫依序回傳 responses 陣列中的一個。
 * responses 格式：null 表示該月回空陣列；Array 表示該月資料。
 */
function makeFetchMock(game, responses) {
  let callIndex = 0;
  return vi.fn(async (_url) => {
    const items = responses[callIndex] ?? [];
    callIndex += 1;
    const body = {
      content: {
        [game.contentKey]: items,
      },
    };
    return {
      ok: true,
      json: async () => body,
    };
  });
}

// ── pad2 ──────────────────────────────────────────────────────────────────────

describe('pad2', () => {
  it('單位數補零', () => {
    // Arrange / Act / Assert
    expect(pad2(1)).toBe('01');
    expect(pad2(9)).toBe('09');
  });

  it('兩位數不補零', () => {
    expect(pad2(10)).toBe('10');
    expect(pad2(99)).toBe('99');
  });

  it('零補兩位', () => {
    expect(pad2(0)).toBe('00');
  });
});

// ── range1 ────────────────────────────────────────────────────────────────────

describe('range1', () => {
  it('range1(5) 回 [1,2,3,4,5]', () => {
    expect(range1(5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('range1(1) 回 [1]', () => {
    expect(range1(1)).toEqual([1]);
  });

  it('range1(39) 長度為 39，首尾正確', () => {
    const r = range1(39);
    expect(r).toHaveLength(39);
    expect(r[0]).toBe(1);
    expect(r[38]).toBe(39);
  });
});

// ── countValues ───────────────────────────────────────────────────────────────

describe('countValues', () => {
  it('計算每個值的出現次數', () => {
    // Arrange
    const input = [1, 2, 1, 3, 2, 1];
    // Act
    const result = countValues(input);
    // Assert
    expect(result).toEqual({ 1: 3, 2: 2, 3: 1 });
  });

  it('空陣列回空物件', () => {
    expect(countValues([])).toEqual({});
  });

  it('所有值相同時計數等於長度', () => {
    expect(countValues([7, 7, 7])).toEqual({ 7: 3 });
  });

  it('字串鍵值也能正確計數', () => {
    // drawNumberAppear 在部分情況可能是字串
    const result = countValues(['5', '5', '3']);
    expect(result['5']).toBe(2);
    expect(result['3']).toBe(1);
  });
});

// ── escapeHtml（全站唯一 XSS 防線）────────────────────────────────────────────

describe('escapeHtml', () => {
  it('五個危險字元各自轉成對應 entity', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('XSS payload 完全轉義，輸出不含原始 < >', () => {
    const out = escapeHtml('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('& 先被轉義，不會把後續 entity 二次破壞', () => {
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('非字串輸入以 String() 包裝、不丟例外', () => {
    expect(escapeHtml(539)).toBe('539');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
  });

  it('安全字串（純中文、純數字、期號）原樣輸出', () => {
    expect(escapeHtml('今彩539')).toBe('今彩539');
    expect(escapeHtml('115000151')).toBe('115000151');
    expect(escapeHtml('2026-06-22')).toBe('2026-06-22');
  });
});

// ── mapPeriods ────────────────────────────────────────────────────────────────

describe('mapPeriods', () => {
  it('威力彩：最後一碼 pop 成 second，code 剩前段', () => {
    // Arrange
    const game = GAMES.lottosuper; // secondMax=8
    const raw = [
      makeItem('113000001', '2024-01-10T00:00:00', [3, 12, 25, 30, 35, 38, 5]),
    ];
    // Act
    const result = mapPeriods(game, raw);
    // Assert
    expect(result[0].second).toBe(5);
    expect(result[0].code).toEqual([3, 12, 25, 30, 35, 38]);
    expect(result[0].date).toBe('2024-01-10');
    expect(result[0].period).toBe('113000001');
  });

  it('大樂透：不 pop，code 保留全部（含特別號）', () => {
    // Arrange
    const game = GAMES.lottobig; // secondMax=0
    const raw = [
      makeItem('113000001', '2024-01-10T00:00:00', [5, 10, 20, 30, 40, 49, 7]),
    ];
    // Act
    const result = mapPeriods(game, raw);
    // Assert
    expect(result[0].code).toEqual([5, 10, 20, 30, 40, 49, 7]);
    expect(result[0]).not.toHaveProperty('second');
    expect(result[0].date).toBe('2024-01-10');
  });

  it('今彩539：不 pop，code 保留全部', () => {
    // Arrange
    const game = GAMES.lotto539;
    const raw = [
      makeItem('113000001', '2024-01-10T00:00:00', [1, 2, 3, 4, 5]),
    ];
    // Act
    const result = mapPeriods(game, raw);
    // Assert
    expect(result[0].code).toEqual([1, 2, 3, 4, 5]);
    expect(result[0]).not.toHaveProperty('second');
  });

  it('date 只取 ISO 前 10 字元（Y-m-d）', () => {
    const game = GAMES.lotto539;
    const raw = [makeItem('X', '2026-06-20T15:30:00', [1, 2, 3, 4, 5])];
    const result = mapPeriods(game, raw);
    expect(result[0].date).toBe('2026-06-20');
  });

  it('威力彩不改動原始陣列（防止 slice 未用到就 mutation）', () => {
    const game = GAMES.lottosuper;
    const originalNums = [3, 12, 25, 30, 35, 38, 5];
    const raw = [makeItem('X', '2024-01-10T00:00:00', [...originalNums])];
    mapPeriods(game, raw);
    // raw[0].drawNumberAppear 應未被 mutation（mapPeriods 有 .slice()）
    expect(raw[0].drawNumberAppear).toEqual(originalNums);
  });
});

// ── buildCounts ───────────────────────────────────────────────────────────────

describe('buildCounts', () => {
  it('四星彩（hasCount:false）回 null', () => {
    const game = GAMES.lotto4;
    const periods = [{ period: 'X', code: ['1', '2', '3', '4'], date: '2024-01-10' }];
    expect(buildCounts(game, periods)).toBeNull();
  });

  it('威力彩：分 main/second 兩組計次', () => {
    // Arrange
    const game = GAMES.lottosuper;
    const periods = [
      { period: 'A', code: [3, 12, 25], second: 5, date: '2024-01-10' },
      { period: 'B', code: [3, 30, 38], second: 2, date: '2024-01-03' },
    ];
    // Act
    const counts = buildCounts(game, periods);
    // Assert
    expect(counts.main[3]).toBe(2);  // 出現 2 次
    expect(counts.main[12]).toBe(1);
    expect(counts.main[30]).toBe(1);
    expect(counts.second[5]).toBe(1);
    expect(counts.second[2]).toBe(1);
  });

  it('大樂透：main 包含特別號（全部 7 碼都算）', () => {
    // Arrange
    const game = GAMES.lottobig; // special:true, secondMax:0
    const periods = [
      // code 最後一碼 7 為特別號，但 buildCounts 一律計次
      { period: 'A', code: [5, 10, 20, 30, 40, 49, 7], date: '2024-01-10' },
    ];
    // Act
    const counts = buildCounts(game, periods);
    // Assert
    expect(counts.main[7]).toBe(1);   // 特別號也計次
    expect(counts.main[49]).toBe(1);
    expect(counts.second).toBeNull(); // secondMax=0
  });

  it('大樂透 second 為 null（secondMax=0）', () => {
    const game = GAMES.lottobig;
    const periods = [{ period: 'A', code: [1, 2, 3, 4, 5, 6, 7], date: '2024-01-10' }];
    const counts = buildCounts(game, periods);
    expect(counts.second).toBeNull();
  });

  it('今彩539 second 為 null（secondMax=0）', () => {
    const game = GAMES.lotto539;
    const periods = [{ period: 'A', code: [1, 2, 3, 4, 5], date: '2024-01-10' }];
    const counts = buildCounts(game, periods);
    expect(counts.second).toBeNull();
  });

  it('空 periods 陣列：main 計次為空物件', () => {
    const game = GAMES.lotto539;
    const counts = buildCounts(game, []);
    expect(counts.main).toEqual({});
    expect(counts.second).toBeNull();
  });
});

// ── fetchPeriods：終止守衛 regression ────────────────────────────────────────

describe('fetchPeriods：終止守衛 regression', () => {
  const game = GAMES.lotto539;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[守衛 a] 所有月份皆空 → 回 []，且往前翻不超過 MONTHS_BACK_CAP 次（不無限迴圈）', async () => {
    // Arrange：每個月都回空陣列（模擬該彩種完全無歷史 / API 全空）
    const mockFetch = makeFetchMock(game, [[]]);
    vi.stubGlobal('fetch', mockFetch);

    // Act
    const result = await fetchPeriods(game, 20);

    // Assert
    expect(result).toEqual([]);
    // 一筆都沒抓到的空月份不可當歷史起點而中斷，須續往前翻，
    // 但受 MONTHS_BACK_CAP 硬上限保護，不會無限迴圈。
    expect(mockFetch).toHaveBeenCalledTimes(MONTHS_BACK_CAP);
  });

  it('[跨月 regression] 當月空、前一月有資料 → 不因當月空而中斷，正確回前一月資料', async () => {
    // Arrange：模擬月初剛跨月 —— 當月（第 1 次 fetch）尚無開獎回空，
    //          前一月（第 2 次 fetch）有 20 筆。
    //          修正前：當月空月即 break → 回 0 筆（bug）。
    const twentyItems = Array.from({ length: 20 }, (_, i) =>
      makeItem(`P${i}`, `2024-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:00`, [1, 2, 3, 4, 5])
    );
    const responses = [
      [],          // 當月：跨月後尚無開獎
      twentyItems, // 前一月：20 筆
    ];
    const mockFetch = makeFetchMock(game, responses);
    vi.stubGlobal('fetch', mockFetch);

    // Act
    const result = await fetchPeriods(game, 20);

    // Assert：不因當月空而回 0 筆，正確抓到前一月 20 筆
    expect(result).toHaveLength(20);
    // 當月空（跳過）+ 前一月抓滿 → 共呼叫 2 次
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('[守衛 b] MONTHS_BACK_CAP 硬上限為 60', () => {
    expect(MONTHS_BACK_CAP).toBe(60);
  });

  it('[守衛 b] maxResults 超大（99999）→ fetch 次數 ≤ MONTHS_BACK_CAP（60）', async () => {
    // Arrange：每月永遠回 10 筆，模擬資料無限
    const tenItems = Array.from({ length: 10 }, (_, i) =>
      makeItem(`P${i}`, `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00`, [1, 2, 3, 4, 5])
    );
    // 永遠回 10 筆（不回空，讓月份上限守衛生效）
    const mockFetch = vi.fn(async (_url) => ({
      ok: true,
      json: async () => ({ content: { [game.contentKey]: tenItems } }),
    }));
    vi.stubGlobal('fetch', mockFetch);

    // Act
    const result = await fetchPeriods(game, 99999);

    // Assert：fetch 次數不超過 MONTHS_BACK_CAP
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(MONTHS_BACK_CAP);
    // 結果長度 = MAX_RESULTS_CAP（clamp 生效）
    expect(result).toHaveLength(MAX_RESULTS_CAP);
  });

  it('[守衛 c] MAX_RESULTS_CAP 硬上限為 500', () => {
    expect(MAX_RESULTS_CAP).toBe(500);
  });

  it('[守衛 c] maxResults clamp：傳入 999 最終抓到 500 筆', async () => {
    // Arrange：每月回 100 筆
    const hundredItems = Array.from({ length: 100 }, (_, i) =>
      makeItem(`P${i}`, `2024-01-01T00:00:00`, [1, 2, 3, 4, 5])
    );
    const mockFetch = vi.fn(async (_url) => ({
      ok: true,
      json: async () => ({ content: { [game.contentKey]: hundredItems } }),
    }));
    vi.stubGlobal('fetch', mockFetch);

    // Act
    const result = await fetchPeriods(game, 999);

    // Assert
    expect(result).toHaveLength(MAX_RESULTS_CAP); // 500，不超過 cap
  });

  it('逐月回部分資料、湊滿 maxResults 即停', async () => {
    // Arrange：第 1 月 3 筆、第 2 月 3 筆，maxResults=5 → 抓完 5 筆即停
    const makeItems = (count, datePrefix) =>
      Array.from({ length: count }, (_, i) =>
        makeItem(`P${i}`, `${datePrefix}T00:00:00`, [1, 2, 3, 4, 5])
      );

    const responses = [
      makeItems(3, '2024-02-01'), // 月 1：3 筆
      makeItems(3, '2024-01-01'), // 月 2：3 筆（只需要 2 筆湊滿 5）
    ];
    const mockFetch = makeFetchMock(game, responses);
    vi.stubGlobal('fetch', mockFetch);

    // Act
    const result = await fetchPeriods(game, 5);

    // Assert：精確 5 筆，不多抓
    expect(result).toHaveLength(5);
    // 呼叫 2 次（第 1 月抓 3 筆，還差 2 筆，第 2 月再抓）
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('第二月起回空 → 只抓到第一月資料', async () => {
    // Arrange：第 1 月 5 筆，第 2 月空
    const fiveItems = Array.from({ length: 5 }, (_, i) =>
      makeItem(`P${i}`, `2024-02-01T00:00:00`, [1, 2, 3, 4, 5])
    );
    const responses = [fiveItems, []];
    const mockFetch = makeFetchMock(game, responses);
    vi.stubGlobal('fetch', mockFetch);

    // Act
    const result = await fetchPeriods(game, 20);

    // Assert：拿到 5 筆後空月 break，fetch 共 2 次
    expect(result).toHaveLength(5);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fetch 回 HTTP 非 ok → throw Error 往上拋', async () => {
    // Arrange
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));

    // Act / Assert
    await expect(fetchPeriods(game, 10)).rejects.toThrow('HTTP 503');
  });
});

// ── readParams：基本冒煙測試（node 環境 stub window）────────────────────────

describe('readParams', () => {
  afterEach(() => {
    globalThis.window = {
      location: { search: '' },
      matchMedia: () => ({ matches: false }),
    };
  });

  it('無 query string → 回 desktop 預設值（lotto539）', () => {
    // Arrange：window.location.search 已為空字串
    const game = GAMES.lotto539;
    // Act
    const params = readParams(game);
    // Assert：desktop defaults = { size:20, width:100, height:100 }，maxResults=20
    expect(params.maxResults).toBe(20);
    expect(params.size).toBe(20);
    expect(params.width).toBe(100);
    expect(params.height).toBe(100);
  });

  it('max_results=999 → clamp 到 MAX_RESULTS_CAP（500）', () => {
    // Arrange
    globalThis.window.location = { search: '?max_results=999' };
    // Act
    const params = readParams(GAMES.lotto539);
    // Assert
    expect(params.maxResults).toBe(MAX_RESULTS_CAP);
  });

  it('max_results=0（無效值）→ 回預設 20', () => {
    globalThis.window.location = { search: '?max_results=0' };
    const params = readParams(GAMES.lotto539);
    expect(params.maxResults).toBe(20);
  });

  it('mobile 環境 → 回 mobile 預設值', () => {
    // Arrange：mock matchMedia 回 mobile
    globalThis.window.matchMedia = () => ({ matches: true });
    globalThis.window.location = { search: '' };
    const game = GAMES.lotto539;
    // Act
    const params = readParams(game);
    // Assert：mobile defaults = { size:16, width:150, height:80 }
    expect(params.size).toBe(16);
    expect(params.width).toBe(150);
    expect(params.height).toBe(80);
  });
});
