// test/viewer-alert.test.cjs — 观众数提醒规则模块的纯计算单元测试
//
// 运行：npm test（node --test）
// 覆盖：裁决的整条判定链（全局总开关 → 该房配置归一化 → 上升边沿）、阈值随裁决归一化返回、
// 无上升边沿（持续高位、值未变化）、恰好等于阈值算越过、无历史值视为 0、阈值解析与钳制。
// 全部是纯函数调用（不驱动编排、不碰存储），口径即「要不要发这一条观众数提醒」的唯一实现，见 ADR-0002。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { clampViewerThreshold, viewerAlertThreshold, decideViewerAlert } = require('../lib/viewer-alert.js');

/** 该房已启用的观众数提醒配置 */
const alertConfig = threshold => ({ enabled: true, threshold });

// === 整条判定链 ===

test('全局总开关关闭：不提醒，各房配置照旧（重开即恢复）', () => {
  const decision = decideViewerAlert({
    settings: { viewerAlertEnabled: false },
    roomConfig: alertConfig(3000),
    prevValue: 0,
    nextValue: 5000
  });
  assert.equal(decision.notify, false);
  assert.equal(
    decideViewerAlert({ settings: { viewerAlertEnabled: true }, roomConfig: alertConfig(3000), prevValue: 0, nextValue: 5000 }).notify,
    true,
    '同一份配置在总开关打开时照常提醒'
  );
});

test('总开关缺省即开启（旧版本无该字段）', () => {
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue: 0, nextValue: 5000 }).notify, true);
  assert.equal(decideViewerAlert({ roomConfig: alertConfig(3000), prevValue: 0, nextValue: 5000 }).notify, true);
});

test('该房未配置 / 未启用观众数提醒：不提醒', () => {
  const base = { settings: {}, prevValue: 0, nextValue: 5000 };
  assert.equal(decideViewerAlert({ ...base, roomConfig: undefined }).notify, false, '没有 viewerAlert 字段');
  assert.equal(decideViewerAlert({ ...base, roomConfig: null }).notify, false);
  assert.equal(decideViewerAlert({ ...base, roomConfig: { enabled: false, threshold: 10 } }).notify, false);
  assert.equal(decideViewerAlert({ ...base, roomConfig: { threshold: 3000 } }).notify, false, 'enabled 非显式 true');
});

// === 上升边沿 ===

test('上升边沿：上次低于阈值、本次越过即提醒', () => {
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue: 2500, nextValue: 3100 }).notify, true);
});

test('无历史值（新加入的房间、下播清空后）视为 0：首次越过即提醒', () => {
  for (const prevValue of [undefined, null, NaN, Infinity]) {
    assert.equal(
      decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue, nextValue: 5000 }).notify,
      true,
      `prevValue=${String(prevValue)} 视为 0`
    );
  }
});

test('恰好等于阈值算越过（≥ 阈值即触发）', () => {
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue: 2999, nextValue: 3000 }).notify, true);
});

test('持续高位不复报：上次已在阈值以上不再提醒', () => {
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue: 5000, nextValue: 6000 }).notify, false);
});

test('值未变化（含上一次就在阈值以上）：不提醒、不视为边沿', () => {
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue: 5000, nextValue: 5000 }).notify, false);
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue: 3000, nextValue: 3000 }).notify, false);
});

test('回落到阈值以下本身不提醒，再次越过才提醒', () => {
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue: 5000, nextValue: 2500 }).notify, false);
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue: 2500, nextValue: 3000 }).notify, true);
});

test('阈值以下一直不越过：不提醒', () => {
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(3000), prevValue: 0, nextValue: 2999 }).notify, false);
});

// === 阈值随裁决归一化返回 ===

test('阈值随裁决返回：编排拼通知正文不必回读该房配置', () => {
  const decision = decideViewerAlert({ settings: {}, roomConfig: alertConfig(' 800 '), prevValue: 0, nextValue: 800 });
  assert.deepEqual(decision, { notify: true, threshold: 800 }, '字符串阈值先归一再返回');
});

test('阈值越界随裁决钳制（与设置页面板同一口径）', () => {
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(1e9), prevValue: 0, nextValue: 1e9 }).threshold, 999999);
  assert.equal(decideViewerAlert({ settings: {}, roomConfig: alertConfig(0), prevValue: 0, nextValue: 0 }).threshold, 1);
});

test('阈值缺省：按默认 1000 判定并返回', () => {
  const decision = decideViewerAlert({ settings: {}, roomConfig: { enabled: true }, prevValue: 0, nextValue: 1000 });
  assert.deepEqual(decision, { notify: true, threshold: 1000 });
});

// === 阈值解析与钳制（设置页面板与本裁决共用的纯函数）===

test('阈值解析：字符串归一到整数、缺省 1000、范围钳制到 1–999999', () => {
  assert.equal(clampViewerThreshold('2500'), 2500);
  assert.equal(clampViewerThreshold(undefined), 1000);
  assert.equal(clampViewerThreshold('abc'), 1000);
  assert.equal(clampViewerThreshold(0), 1);
  assert.equal(clampViewerThreshold(-5), 1);
  assert.equal(clampViewerThreshold(1e9), 999999);
  assert.equal(clampViewerThreshold(12.7), 12);
  assert.equal(viewerAlertThreshold({ threshold: '800' }), 800);
  assert.equal(viewerAlertThreshold(null), 1000);
});
