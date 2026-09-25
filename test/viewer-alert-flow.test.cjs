// test/viewer-alert-flow.test.cjs — 观众数提醒链路（编排 + 房间库 + 真实规则 module）行为测试
//
// 运行：npm test（node --test）
// 覆盖：上升边沿触发、持续高位不复报、回落重新武装、未配置不判、总开关与平台开关的联动、
// 两轮离线清空后重新武装、单轮抖动不重复、无历史值视为 0。
// 裁决本身（含阈值解析与钳制）的纯单测在 test/viewer-alert.test.cjs。
// 提醒的判定点在「值到达处」（编排的 onViewerCount，对应生产里弹幕客户端的回调），见 ADR-0002。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, poll, douyuResult, bilibiliResult } = require('./support/harness.cjs');

const room = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
const streamer = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, online: true, ...extra });
const alertConfig = threshold => ({ enabled: true, threshold });

test('斗鱼：越阈发提醒，持续高位不复报，回落后再越阈再报', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { viewerAlert: alertConfig(3000) })],
    streamers: [streamer('100', 'douyu', { title: '在播' })]
  });

  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 5000 });
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'douyu_100_viewer');
  assert.equal(harness.notifications[0].content.title, '[斗鱼] 昵称100 贵宾数超过 3000！');
  assert.equal(harness.notifications[0].content.message, '当前 5000 贵宾', '数值在正文：Windows 上只有正文保证渲染');
  assert.equal(harness.notifications[0].content.contextMessage, '在播', '房间标题降为上下文行');

  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 6000 });
  assert.equal(harness.notifications.length, 1, '持续高位不复报');

  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 2500 });
  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 3100 });
  assert.equal(harness.notifications.length, 2, '回落重新武装后再越阈再报');
  assert.equal(harness.data.streamers[0].vipCount, 3100);
});

test('未配置 / 未启用观众数提醒的房间不提醒（配置保留）', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu'), room('101', 'douyu', { viewerAlert: { enabled: false, threshold: 10 } })],
    streamers: [streamer('100', 'douyu'), streamer('101', 'douyu')]
  });

  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 99999 });
  await harness.orchestrator.onViewerCount('douyu', { roomId: '101', value: 99999 });
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.data.streamers[1].vipCount, 99999, '数值照常写入');
  assert.deepEqual(harness.data.rooms[1].viewerAlert, { enabled: false, threshold: 10 });
});

test('观众数提醒总开关关闭：不判定；重新打开后按上升边沿恢复', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { viewerAlert: alertConfig(3000) })],
    streamers: [streamer('100', 'douyu')],
    settings: { viewerAlertEnabled: false }
  });

  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 5000 });
  assert.equal(harness.notifications.length, 0, '总开关关闭时不判定');
  assert.equal(harness.data.streamers[0].vipCount, 5000, '数值照常写入');

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { viewerAlertEnabled: true } });
  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 2500 });
  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 3000 });
  assert.equal(harness.notifications.length, 1, '重新打开即恢复边沿判定');
});

test('平台观众数开关关闭：不写数值也不判定；重新打开即恢复', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { viewerAlert: alertConfig(3000) })],
    streamers: [streamer('100', 'douyu')],
    settings: { fetchDouyuViewerCount: false }
  });

  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 5000 });
  assert.equal(harness.notifications.length, 0);
  assert.ok(!('vipCount' in harness.data.streamers[0]), '采集开关关闭时不写数值');

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { fetchDouyuViewerCount: true } });
  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 2500 });
  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 5000 });
  assert.equal(harness.notifications.length, 1);
});

test('B站：两轮确认离线清空存量后，第二场重新越阈能再提醒', async () => {
  const harness = createHarness({
    rooms: [room('200', 'bilibili', { viewerAlert: alertConfig(3000) })],
    streamers: [streamer('200', 'bilibili')]
  }, { apiResults: { bilibili: bilibiliResult([{ roomId: '200', online: true, title: '第一场' }]) } });

  await harness.orchestrator.onViewerCount('bilibili', { roomId: '200', value: 5000 });
  assert.equal(harness.notifications.length, 1);

  harness.setApiResult('bilibili', bilibiliResult([{ roomId: '200', online: false }]));
  await poll(harness);
  assert.equal(harness.data.streamers[0].rankCount, 5000, '一轮离线只记录，不清存量');
  assert.equal(harness.notifications.length, 1, '清空本身不提醒');

  await poll(harness);
  assert.ok(!('rankCount' in harness.data.streamers[0]), '两轮确认离线清空存量');

  harness.setApiResult('bilibili', bilibiliResult([{ roomId: '200', online: true, title: '第二场' }]));
  await poll(harness);
  await harness.orchestrator.onViewerCount('bilibili', { roomId: '200', value: 5000 });
  assert.equal(harness.notifications.length, 2, '第二场重新武装后再提醒');
  assert.equal(harness.notifications[1].content.title, '[B站] 昵称200 高能榜在线数超过 3000！');
  assert.equal(harness.notifications[1].content.message, '当前 5000 高能榜', 'B站指标文案同样进正文');
  assert.equal(harness.notifications[1].content.contextMessage, '第二场');
});

test('单次 API 抖动（一轮误报离线）：不清存量、同场不重复提醒', async () => {
  const harness = createHarness({
    rooms: [room('200', 'bilibili', { viewerAlert: alertConfig(3000) })],
    streamers: [streamer('200', 'bilibili', { rankCount: 5000 })]
  }, { apiResults: { bilibili: bilibiliResult([{ roomId: '200', online: false }]) } });

  await poll(harness);
  harness.setApiResult('bilibili', bilibiliResult([{ roomId: '200', online: true, title: '同场' }]));
  await poll(harness);
  await harness.orchestrator.onViewerCount('bilibili', { roomId: '200', value: 5000 });
  assert.equal(harness.notifications.length, 0, '值未变化，没有上升边沿');
  assert.equal(harness.data.streamers[0].rankCount, 5000);
});

test('新加入的房间无历史值（视为 0）：首次采到 ≥ 阈值即提醒', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { viewerAlert: alertConfig(3000) })],
    streamers: [streamer('100', 'douyu')]
  });

  await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 3000 });
  assert.equal(harness.notifications.length, 1, '恰好等于阈值也算越过');
});

test('值未变化：不写盘也不判定（斗鱼同样跳过）', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { viewerAlert: alertConfig(3000) })],
    streamers: [streamer('100', 'douyu', { vipCount: 5000 })]
  });

  const changed = await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 5000 });
  assert.equal(changed, false);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.data.streamers[0].vipCount, 5000);
});

test('房间没有主播快照：静默忽略（不抛、不写）', async () => {
  const harness = createHarness({ rooms: [room('100', 'douyu')], streamers: [] });
  const changed = await harness.orchestrator.onViewerCount('douyu', { roomId: '100', value: 5000 });
  assert.equal(changed, false);
  assert.equal(harness.notifications.length, 0);
});
