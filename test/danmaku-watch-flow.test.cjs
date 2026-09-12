// test/danmaku-watch-flow.test.cjs — 弹幕检测盯守链路（编排 + 房间库 + 真实规则 module）行为测试
//
// 运行：npm test（node --test）
// 覆盖：开播门控建连/断连、命中计数与检测通知（与开播通知互不覆盖）、窗口与冷却、冷却 0 本场锁定、
// 并发上限 5 与排队、SW 唤醒后按存储重建（首批弹幕不丢）、一房多词共用计数器、
// B站通道（未登录 SW 直连 / 登录态页面桥接 / 采样完成不关页 / 总开关关闭释放桥接页）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, createClock, poll, boot, douyuResult } = require('./support/harness.cjs');

const WATCH = { enabled: true, keywords: ['上车'], threshold: 2, windowMinutes: 5, cooldownMinutes: 30 };
const room = (roomId, platform, watch) => ({ roomId, platform, nickname: `昵称${roomId}`, watch });
const streamer = (roomId, platform, online) => ({ roomId, platform, nickname: `昵称${roomId}`, online });
const online = (roomId, platform = 'douyu') => ({ roomId, platform, online: true });

test('斗鱼：未开播不建连；开播建连，命中达阈值发检测通知（与开播通知互不覆盖）', async () => {
  const harness = createHarness({
    rooms: [{ roomId: '100', platform: 'douyu', nickname: '昵称100', notify: true, watch: WATCH }],
    streamers: [streamer('100', 'douyu', false)]
  }, { apiResults: { douyu: douyuResult([{ roomId: '100', online: false }]) } });

  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), [], '未开播不建检测连接');

  harness.setApiResult('douyu', douyuResult([{ roomId: '100', online: true, title: '在播' }]));
  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['100']);
  assert.equal(harness.notifications.length, 1, '开播通知照发（与检测正交）');
  assert.equal(harness.notifications[0].id, 'douyu_100');

  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '我要上车了', user: '观众甲' });
  assert.equal(harness.notifications.length, 1, '未达阈值不通知');

  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车+1', user: '观众甲' });
  assert.equal(harness.notifications.length, 2);
  assert.equal(harness.notifications[1].id, 'douyu_100_watch');
  assert.equal(harness.notifications[1].content.title, '[斗鱼] 昵称100 弹幕命中！');
  assert.equal(harness.notifications[1].content.message, '观众甲：上车+1');
  assert.equal(harness.notifications[1].content.contextMessage, '5 分钟内「上车」命中 2 次');
});

test('斗鱼：下播断开连接并清空计数，重新开播后需重新凑满阈值', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', WATCH)],
    streamers: [streamer('100', 'douyu', true)]
  }, { apiResults: { douyu: douyuResult([online('100')]) } });

  await poll(harness);
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(harness.notifications.length, 1);

  harness.setApiResult('douyu', douyuResult([{ roomId: '100', online: false }]));
  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), [], '下播断开检测连接');

  harness.setApiResult('douyu', douyuResult([online('100')]));
  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['100'], '重新开播重建连接');
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(harness.notifications.length, 1, '计数已清空，一次命中不够');
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(harness.notifications.length, 2);
});

test('冷却为 0（本场锁定）：触发一次后不再报，下播后解锁', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { ...WATCH, threshold: 1, cooldownMinutes: 0 })],
    streamers: [streamer('100', 'douyu', true)]
  }, { apiResults: { douyu: douyuResult([online('100')]) } });

  await poll(harness);
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(harness.notifications.length, 1, '本场锁定后不再报');

  harness.setApiResult('douyu', douyuResult([{ roomId: '100', online: false }]));
  await poll(harness);
  harness.setApiResult('douyu', douyuResult([online('100')]));
  await poll(harness);
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(harness.notifications.length, 2, '下播解锁，下一场重新报');
});

test('冷却期内命中不计数，冷却结束后重新凑满阈值再报', async () => {
  const clock = createClock();
  const harness = createHarness({
    rooms: [room('100', 'douyu', { ...WATCH, cooldownMinutes: 1 })],
    streamers: [streamer('100', 'douyu', true)]
  }, { apiResults: { douyu: douyuResult([online('100')]) }, clock });

  await poll(harness);
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(harness.notifications.length, 1);

  clock.advance(30 * 1000);
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(harness.notifications.length, 1, '冷却内命中不计数（不补报）');

  clock.advance(40 * 1000); // 累计 70 秒 > 1 分钟冷却
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(harness.notifications.length, 1);
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(harness.notifications.length, 2, '冷却结束后重新凑满再报');
});

test('上限与排队：最多盯 5 个开播房间，超出按房间列表顺序排队并在 watchQueued 提示', async () => {
  const rooms = [];
  const streamers = [];
  const data = [];
  for (let i = 1; i <= 6; i++) {
    rooms.push(room(String(i), 'douyu', WATCH));
    streamers.push(streamer(String(i), 'douyu', true));
    data.push(online(String(i)));
  }
  const harness = createHarness({ rooms, streamers }, { apiResults: { douyu: douyuResult(data) } });

  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['1', '2', '3', '4', '5']);
  assert.deepEqual(harness.data.watchQueued, [{ roomId: '6', platform: 'douyu', nickname: '昵称6' }]);

  harness.setApiResult('douyu', douyuResult(data.map(d => (d.roomId === '1' ? { roomId: '1', online: false } : d))));
  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['2', '3', '4', '5', '6'], '下播释放名额后按列表顺序补位');
  assert.deepEqual(harness.data.watchQueued, []);
});

test('SW 被回收后唤醒：start 按存储重建盯守配置，首批弹幕不被丢弃', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', WATCH)],
    streamers: [streamer('100', 'douyu', true)]
  });

  const started = harness.orchestrator.start(); // 不 await：模拟唤醒后弹幕立刻到达
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  await started;

  assert.equal(harness.notifications.length, 1, '首批弹幕按重建后的配置计数');
});

test('一房多词共用一个计数器：一条弹幕命中多词也只计一次', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { ...WATCH, keywords: ['上车', '发车'], threshold: 1 })],
    streamers: [streamer('100', 'douyu', true)]
  }, { apiResults: { douyu: douyuResult([online('100')]) } });

  await poll(harness);
  await harness.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车就发车' });
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].content.contextMessage, '5 分钟内「上车」命中 1 次');
});

test('未配置检测（空检测词 / 未启用）的房间不建连接', async () => {
  const harness = createHarness({
    rooms: [
      room('100', 'douyu', { ...WATCH, keywords: [] }),
      room('101', 'douyu', { ...WATCH, enabled: false })
    ],
    streamers: [streamer('100', 'douyu', true), streamer('101', 'douyu', true)]
  }, { apiResults: { douyu: douyuResult([online('100'), online('101')]) } });

  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), []);
});

test('B站未登录：检测走 SW 直连长连接，命中触发检测通知', async () => {
  const harness = createHarness({
    rooms: [room('200', 'bilibili', WATCH)],
    streamers: [streamer('200', 'bilibili', true)]
  }, { apiResults: { bilibili: { success: true, data: [online('200', 'bilibili')] } } });

  await boot(harness);
  await poll(harness);
  assert.equal(harness.bridge.enabled, false);
  assert.deepEqual(harness.clients.bilibiliWatch.roomCalls.at(-1), ['200']);
  assert.deepEqual(harness.tabApi.calls.sendMessage, [], '未登录不开桥接页');

  await harness.orchestrator.handleDanmu('bilibili', { roomId: '200', text: '上车' });
  await harness.orchestrator.handleDanmu('bilibili', { roomId: '200', text: '上车' });
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'bilibili_200_watch');
});

test('B站登录态：检测下发到常驻桥接页，采样完成不关页；总开关关闭时释放页面且残留弹幕不计数', async () => {
  const harness = createHarness({
    rooms: [room('200', 'bilibili', WATCH)],
    streamers: [streamer('200', 'bilibili', true)]
  }, { isLoggedIn: async () => true });

  await boot(harness);
  assert.equal(harness.bridge.enabled, true, '登录态走页面通道');
  const bridgeTab = () => harness.tabApi.tabs.find(t => t.url.includes('dyext=1'));
  assert.ok(bridgeTab(), '桥接页已打开');

  const watchMsgs = () => harness.tabApi.calls.sendMessage.filter(c => c.msg.type === 'BILI_WATCH_ROOMS');
  assert.deepEqual(watchMsgs().at(-1).msg.roomIds, ['200'], '盯守列表下发到页面');
  assert.deepEqual(harness.clients.bilibiliWatch.roomCalls.at(-1), [], '页面通道启用时不留 SW 直连');

  await harness.orchestrator.onMessage({ type: 'BILI_SAMPLE_DONE' });
  assert.ok(bridgeTab(), '有检测盯守时采样完成不关页');

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { danmakuWatchEnabled: false } });
  assert.deepEqual(watchMsgs().at(-1).msg.roomIds, [], '关总开关后下发空列表');
  assert.equal(bridgeTab(), undefined, '桥接页被释放');

  const before = harness.notifications.length;
  await harness.orchestrator.handleDanmu('bilibili', { roomId: '200', text: '上车' });
  assert.equal(harness.notifications.length, before, '残留弹幕不计数');
});
