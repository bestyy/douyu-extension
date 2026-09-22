// test/highlight-alert.test.cjs — 看点通知规则模块的纯计算单元测试
//
// 运行：npm test（node --test）
// 覆盖：平台门、总开关、首次观测只记水位、编号严格大于水位、编号相等不算新、列表乱序取最大编号、
// 缺编号 / 非数字编号的条目不参与也不进水位、空列表水位原地不动、水位只增不减、多条只报最新。
// 全部是纯函数调用（不驱动编排、不碰存储），口径即「什么算新看点」的唯一实现，见 ADR-0006。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { HIGHLIGHT_PLATFORMS, isHighlightAlertEnabled, selectNewHighlights } = require('../lib/highlight-alert.js');

/** 一条收敛后的看点（API 层给编排的形状） */
const item = (highlightId, title = `看点${highlightId}`) => ({ highlightId, title, startTime: 0, endTime: 0, heat: 0 });

// === 平台门与总开关 ===

test('HIGHLIGHT_PLATFORMS：只有斗鱼有看点这个形态', () => {
  assert.deepEqual(HIGHLIGHT_PLATFORMS, ['douyu']);
  assert.equal(HIGHLIGHT_PLATFORMS.includes('bilibili'), false, 'B站没有对应物');
});

test('isHighlightAlertEnabled：默认开启，仅显式 false 视为关闭（旧版本无该字段）', () => {
  assert.equal(isHighlightAlertEnabled(undefined), true, '无 settings');
  assert.equal(isHighlightAlertEnabled({}), true, '无字段');
  assert.equal(isHighlightAlertEnabled({ highlightAlertEnabled: true }), true);
  assert.equal(isHighlightAlertEnabled({ highlightAlertEnabled: false }), false);
});

// === 首次观测 ===

test('首次观测（没有水位）：只记本轮最大编号，不发通知', () => {
  const result = selectNewHighlights([item(60410), item(60411), item(60412)], undefined);
  assert.deepEqual(result, { newest: null, count: 0, watermark: 60412 }, '整场都算「没通知过」，因此只记水位');
});

test('没有水位的三种形态（缺省 / NaN / Infinity）都按首次观测处理', () => {
  for (const watermark of [undefined, NaN, Infinity]) {
    assert.equal(
      selectNewHighlights([item(60412)], watermark).newest,
      null,
      `watermark=${String(watermark)} 视为没有水位`
    );
    assert.equal(selectNewHighlights([item(60412)], watermark).watermark, 60412);
  }
});

// === 有水位 ===

test('有水位：编号严格大于水位的才算新，最新那条是编号最大的', () => {
  const result = selectNewHighlights([item(60411), item(60413), item(60412)], 60410);
  assert.equal(result.newest.highlightId, 60413, '最新 = 编号最大，且取编号大于水位的那条');
  assert.equal(result.count, 3);
  assert.equal(result.watermark, 60413);
});

test('编号等于水位不算新（同一批重放不重报）', () => {
  const result = selectNewHighlights([item(60412), item(60411)], 60412);
  assert.equal(result.newest, null);
  assert.equal(result.count, 0);
  assert.equal(result.watermark, 60412, '水位原地不动');
});

test('列表乱序不影响口径：不依赖「最新在前」', () => {
  const ascending = selectNewHighlights([item(1), item(2), item(3)], 0);
  const descending = selectNewHighlights([item(3), item(2), item(1)], 0);
  assert.equal(ascending.newest.highlightId, 3);
  assert.equal(descending.newest.highlightId, 3, '倒序列表同样取编号最大的那条');
  assert.equal(ascending.count, descending.count);
});

test('一次发现多条只给出最新那一条，count 是全部新看点的个数', () => {
  const list = [item(60410), item(60411), item(60412), item(60413)];
  const result = selectNewHighlights(list, 60409);
  assert.equal(result.newest.highlightId, 60413);
  assert.equal(result.count, 4, 'count 含最新那条（编排用它算「另有 N-1 条」）');
  assert.equal(result.watermark, 60413, '其余几条在水位里一并消化');
});

test('水位落后很多（关掉开关一周后重开）：一轮里的大量「新」看点只推高水位一次', () => {
  const list = [];
  for (let id = 70001; id <= 70020; id++) {
    list.push(item(id));
  }
  const result = selectNewHighlights(list, 70000);
  assert.equal(result.newest.highlightId, 70020);
  assert.equal(result.count, 20);
  assert.equal(result.watermark, 70020);
});

// === 无效条目与空列表 ===

test('编号缺失或非数字的条目：不参与判定、也不进水位（宁可不报也不重报）', () => {
  const list = [
    { title: '没有编号' },
    { highlightId: '60412', title: '字符串编号' },
    { highlightId: null, title: '空编号' },
    { highlightId: NaN, title: 'NaN 编号' },
    item(60411)
  ];
  const first = selectNewHighlights(list, undefined);
  assert.equal(first.watermark, 60411, '只有 60411 是可用的编号');
  assert.equal(first.newest, null, '首次观测只记水位');

  const next = selectNewHighlights(list, 60410);
  assert.equal(next.newest.highlightId, 60411);
  assert.equal(next.count, 1, '非数字编号不算新看点');
  assert.equal(next.watermark, 60411);
});

test('空列表 / 全无效条目：水位原地不动（首次观测也不会写下水位）', () => {
  assert.deepEqual(selectNewHighlights([], undefined), { newest: null, count: 0, watermark: undefined });
  assert.deepEqual(selectNewHighlights([], 60412), { newest: null, count: 0, watermark: 60412 });
  assert.deepEqual(selectNewHighlights(null, 60412), { newest: null, count: 0, watermark: 60412 });
  assert.deepEqual(
    selectNewHighlights([{ title: '没有编号' }], 60412),
    { newest: null, count: 0, watermark: 60412 },
    '全是无效条目时同样不动水位'
  );
});

// === 水位只增不减 ===

test('水位只增不减：本轮最大编号小于既有水位时（接口回退 / 换场残留）输出仍是既有水位', () => {
  const result = selectNewHighlights([item(60400), item(60401)], 60412);
  assert.equal(result.newest, null);
  assert.equal(result.count, 0);
  assert.equal(result.watermark, 60412, '水位不回落');
});

test('不修改入参：列表与水位都只读', () => {
  const list = [item(60411)];
  const result = selectNewHighlights(list, 60410);
  assert.equal(list.length, 1);
  assert.equal(list[0].highlightId, 60411);
  assert.notEqual(result.newest, undefined);
  assert.equal(selectNewHighlights(list, 60410).watermark, 60411);
});
