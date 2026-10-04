// test/subscription-alert.test.cjs — 订阅裁决模块的纯计算单元测试
//
// 运行：npm test（node --test）
// 覆盖：宽限期边界（内 → 照发、恰好等于 → 照发、超过 → 丢弃、at 恰等于 now → 照发）、
// 多条同时到期各自独立裁决、未来订阅不进任一分支且被算作下一个待触发时刻、空列表无待触发时刻、
// 展示名回退。订阅通知的文案构造已迁入 lib/notifications.js，其用例见 test/notifications.test.cjs。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SUBSCRIPTION_GRACE_MS,
  decideSubscriptions,
  subscriptionDisplayName
} = require('../lib/subscription-alert.js');

/** 一条订阅（存储里的形状） */
const sub = (id, at, extra = {}) => ({ id, platform: 'douyu', roomId: '100', at, ...extra });

const NOW = 1_000_000_000_000; // 固定时刻，避免依赖真实时间

// === 宽限期边界 ===

test('宽限期内：延迟不超过宽限期的订阅照发', () => {
  const { notify, dropped, nextAt } = decideSubscriptions(
    [sub('s1', NOW - 1000), sub('s2', NOW)],
    NOW
  );
  assert.deepEqual(notify.map(s => s.id), ['s1', 's2']);
  assert.deepEqual(dropped, []);
  assert.equal(nextAt, undefined, '没有未来订阅时没有下一个待触发时刻');
});

test('宽限期边界：恰好等于宽限期照发（「不超过」含边界），超过一毫秒丢弃', () => {
  const atBoundary = decideSubscriptions([sub('s1', NOW - SUBSCRIPTION_GRACE_MS)], NOW);
  assert.deepEqual(atBoundary.notify.map(s => s.id), ['s1'], '恰好等于宽限期：照发');
  assert.deepEqual(atBoundary.dropped, []);

  const over = decideSubscriptions([sub('s1', NOW - SUBSCRIPTION_GRACE_MS - 1)], NOW);
  assert.deepEqual(over.notify, []);
  assert.deepEqual(over.dropped.map(s => s.id), ['s1'], '超过一毫秒：丢弃');
});

test('超过宽限期：静默丢弃，不发通知', () => {
  const { notify, dropped } = decideSubscriptions([sub('s1', NOW - SUBSCRIPTION_GRACE_MS - 1)], NOW);
  assert.deepEqual(notify, []);
  assert.deepEqual(dropped.map(s => s.id), ['s1']);
});

test('at 恰等于 now：算到期且延迟为 0，照发', () => {
  const { notify, dropped } = decideSubscriptions([sub('s1', NOW)], NOW);
  assert.deepEqual(notify.map(s => s.id), ['s1']);
  assert.deepEqual(dropped, []);
});

// === 多条 / 独立裁决 ===

test('多条同时到期各自独立裁决：同宽限期、异延迟分流到两组', () => {
  const { notify, dropped } = decideSubscriptions([
    sub('s1', NOW - 1000),
    sub('s2', NOW - SUBSCRIPTION_GRACE_MS - 5),
    sub('s3', NOW - 100)
  ], NOW);
  assert.deepEqual(notify.map(s => s.id), ['s1', 's3']);
  assert.deepEqual(dropped.map(s => s.id), ['s2']);
});

test('同一房间的多条订阅各自独立：一条在宽限期内、一条已超期', () => {
  const { notify, dropped } = decideSubscriptions([
    sub('s1', NOW - 1000, { roomId: '100' }),
    sub('s2', NOW - SUBSCRIPTION_GRACE_MS - 1, { roomId: '100' })
  ], NOW);
  assert.deepEqual(notify.map(s => s.id), ['s1']);
  assert.deepEqual(dropped.map(s => s.id), ['s2']);
});

// === 未来订阅与 nextAt ===

test('未来订阅不进任一分支，并给出最早的 at 作为下一个待触发时刻', () => {
  const { notify, dropped, nextAt } = decideSubscriptions([
    sub('s1', NOW + 5000),
    sub('s2', NOW + 1000),
    sub('s3', NOW - 1)
  ], NOW);
  assert.deepEqual(notify.map(s => s.id), ['s3']);
  assert.deepEqual(dropped, []);
  assert.equal(nextAt, NOW + 1000, 'nextAt 是未来订阅里最早的那个');
});

test('空列表 / 非数组：无待触发时刻', () => {
  assert.deepEqual(decideSubscriptions([], NOW), { notify: [], dropped: [], nextAt: undefined });
  assert.deepEqual(decideSubscriptions(null, NOW), { notify: [], dropped: [], nextAt: undefined });
});

test('不修改入参', () => {
  const list = [sub('s1', NOW + 1)];
  decideSubscriptions(list, NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].at, NOW + 1);
});

// === 展示名回退 ===

test('subscriptionDisplayName：有昵称用昵称，没有则回退「平台 房间号」', () => {
  assert.equal(
    subscriptionDisplayName({ subscription: sub('s1', 0), streamer: { nickname: '主播甲' }, platformLabel: '斗鱼' }),
    '主播甲'
  );
  assert.equal(
    subscriptionDisplayName({ subscription: sub('s1', 0), streamer: null, platformLabel: '斗鱼' }),
    '斗鱼 100',
    '房间已被移除：回退为「平台 房间号」'
  );
});
