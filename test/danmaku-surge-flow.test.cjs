// test/danmaku-surge-flow.test.cjs — 弹幕激增链路（编排 + 房间库 + 真实规则 module）行为测试
//
// 运行：npm test（node --test）
// 覆盖：只开激增（未配检测词）也建立盯守连接、上桶越过基线数倍触发通知（ID / 标题 / 正文 / 上下文行）、
// 未打开该房开关不判定、总开关、冷启动、冷启动时长可配、基线门槛、冷却复用同一通知 ID、开播边沿清空、
// 名额与排队（检测与激增共用池子）、两个功能正交、通知点击进入直播间、轮询收敛点兜底结算。
// 时间由假时钟驱动（分钟桶），结算走编排的 alarm 入口（settleSurge），与生产同一条路。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, createClock, poll, settleSurge, boot, douyuResult, bilibiliResult } = require('./support/harness.cjs');

const WATCH = { enabled: true, keywords: ['上车'], threshold: 1, windowMinutes: 5, cooldownMinutes: 30 };
const room = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
const streamer = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, online: true, ...extra });
const online = (roomId, platform = 'douyu', extra = {}) => ({ roomId, platform, online: true, ...extra });

/** 灌 n 条弹幕（走编排的弹幕入口，与生产的弹幕回调同一条路） */
async function feed(harness, roomId, n, platform = 'douyu') {
  for (let i = 0; i < n; i++) {
    await harness.orchestrator.handleDanmu(platform, { roomId, text: '666', user: '观众甲' });
  }
}

/** 按每分钟 perMinute 条灌 minutes 分钟，每灌完一分钟把时钟推进一分钟 */
async function feedMinutes(harness, clock, roomId, minutes, perMinute, platform = 'douyu') {
  for (let m = 0; m < minutes; m++) {
    await feed(harness, roomId, perMinute, platform);
    clock.advanceMinutes(1);
  }
}

test('只开激增、未配检测词：一样建立盯守连接，上桶越过基线数倍时收到激增通知', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true })], // 没有 watch 字段：本功能的核心承诺
    streamers: [streamer('100', 'douyu', { title: '在播中' })]
  }, { clock });

  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['100'], '未配检测词也要为激增建盯守连接');

  await feedMinutes(harness, clock, '100', 10, 10); // 平时水位：每分钟 10 条
  await feed(harness, '100', 100);                  // 上一分钟爆量
  clock.advanceMinutes(1);
  await settleSurge(harness);

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'douyu_100_surge');
  assert.equal(harness.notifications[0].content.title, '[斗鱼] 昵称100 弹幕激增！');
  assert.equal(harness.notifications[0].content.message, '在播中', '正文用房间标题');
  assert.equal(harness.notifications[0].content.contextMessage, '上一分钟 100 条，平时约 10 条');
});

test('未打开该房激增开关：不建连接、灌再多弹幕也不通知', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')]
  }, { clock });

  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), [], '没有盯守需求不建连接');

  await feedMinutes(harness, clock, '100', 10, 10);
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);

  assert.equal(harness.notifications.length, 0);
});

test('激增总开关关闭：不盯守不判定（各房开关保留），重新打开后恢复', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true })],
    streamers: [streamer('100', 'douyu')],
    settings: { surgeAlertEnabled: false }
  }, { clock });

  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), [], '总开关关闭：不因激增建连接');
  await feedMinutes(harness, clock, '100', 10, 10);
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 0, '总开关关闭：不判定');
  assert.equal(harness.data.rooms[0].surgeAlert, true, '该房开关保留');

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { surgeAlertEnabled: true } });
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['100'], '重新打开即恢复盯守');

  await feedMinutes(harness, clock, '100', 10, 10); // 关闭期间没有积累，重新攒基线
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 1, '重新打开后恢复判定');
});

test('冷启动：不足 10 个完整桶不判定（开播爬坡不算激增），攒够后开始判定', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true })],
    streamers: [streamer('100', 'douyu')]
  }, { clock });

  await poll(harness);
  await feedMinutes(harness, clock, '100', 3, 10);
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 0, '只有 3 个完整桶：样本不足以看出「突然」');

  await feedMinutes(harness, clock, '100', 7, 10); // 继续攒到 10 个完整桶
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 1, '攒够后同样幅度的上涨就报');
});

test('冷启动时长可配：调小后更早开始判定，设置经 PATCH_SETTINGS 落到判定侧', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true })],
    streamers: [streamer('100', 'douyu')]
  }, { clock });

  await poll(harness);
  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { surgeMinBuckets: 3 } });
  await feedMinutes(harness, clock, '100', 3, 10); // 只攒 3 个完整桶
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);

  assert.equal(harness.notifications.length, 1, '冷启动调到 3 分钟：同样的数据不必等 10 个桶');
  assert.equal(harness.notifications[0].content.contextMessage, '上一分钟 100 条，平时约 10 条');
});

test('基线门槛：平时水位低于门槛时即使倍数满足也不通知，调低门槛即恢复', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true })],
    streamers: [streamer('100', 'douyu')]
  }, { clock });

  await poll(harness);
  await feedMinutes(harness, clock, '100', 10, 2); // 小体量房间：基线 2 条/分钟
  await feed(harness, '100', 30);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 0, '基线 2 < 门槛 3：涨到 15 倍也不报');

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { surgeMinBaseline: 1 } });
  await feed(harness, '100', 30);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 1, '门槛调到 1 后同样的房间也报（不按体量歧视）');
  assert.equal(harness.notifications[0].content.contextMessage, '上一分钟 30 条，平时约 2 条');
});

test('冷却：冷却内不再通知（同一房间复用同一条通知 ID），冷却结束后可以再报', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true })],
    streamers: [streamer('100', 'douyu')]
  }, { clock }); // 默认冷却 30 分钟

  await poll(harness);
  await feedMinutes(harness, clock, '100', 10, 10);
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 1);

  await feed(harness, '100', 100); // 冷却内再爆一次
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 1, '冷却中不打扰');

  await feedMinutes(harness, clock, '100', 30, 10); // 冷却期照常积累
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 2, '冷却结束后可以再报');
  assert.equal(
    harness.notifications[1].id,
    harness.notifications[0].id,
    '同一房间反复触发复用同一条通知（同 ID 覆盖，不堆积）'
  );
});

test('轮询收敛点兜底结算：跨桶后不依赖结算 alarm 也会裁决，同一桶不重复报', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true })],
    streamers: [streamer('100', 'douyu')]
  }, { clock });

  await poll(harness);
  await feedMinutes(harness, clock, '100', 10, 10);
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await poll(harness); // 不用结算 alarm，轮询自己也裁决
  assert.equal(harness.notifications.length, 1);

  await poll(harness);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 1, '结算幂等：同一个完整桶只报一次');
});

test('开播边沿：下播断开连接并清空桶与冷却，重新开播后需要重新攒够 10 个桶', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true })],
    streamers: [streamer('100', 'douyu', { title: '第一场' })]
  }, { clock, apiResults: { douyu: douyuResult([online('100')]) } });

  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['100']);
  await feedMinutes(harness, clock, '100', 10, 10);
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 1, '第一场触发一次');

  harness.setApiResult('douyu', douyuResult([{ roomId: '100', online: false }]));
  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), [], '下播断开盯守连接');

  harness.setApiResult('douyu', douyuResult([online('100', 'douyu', { title: '第二场' })]));
  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['100'], '重新开播重建连接');

  await feedMinutes(harness, clock, '100', 3, 10);
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 1, '新一场的桶已清空：3 个完整桶不判定');

  await feedMinutes(harness, clock, '100', 7, 10);
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 2, '重新攒够 10 个桶后再报（冷却没有跨场残留）');
  assert.equal(harness.notifications[1].content.message, '第二场');
});

test('名额与排队：超过上限的房间不建连接、不判定，并在 watchQueued 提示；释放名额后按列表顺序补位', async () => {
  const clock = createClock(0);
  const rooms = [];
  const streamers = [];
  const data = [];
  for (let i = 1; i <= 6; i++) {
    rooms.push(room(String(i), 'douyu', { surgeAlert: true }));
    streamers.push(streamer(String(i), 'douyu'));
    data.push(online(String(i)));
  }
  const harness = createHarness({ rooms, streamers }, { clock, apiResults: { douyu: douyuResult(data) } });

  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['1', '2', '3', '4', '5']);
  assert.deepEqual(harness.data.watchQueued, [{ roomId: '6', platform: 'douyu', nickname: '昵称6' }]);

  await feedMinutes(harness, clock, '6', 10, 10); // 排队的 6 号灌再多也不判定
  await feed(harness, '6', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 0, '排队中的房间不计数不判定');

  harness.setApiResult('douyu', douyuResult(data.map(d => (d.roomId === '1' ? { roomId: '1', online: false } : d))));
  await poll(harness);
  assert.deepEqual(harness.clients.douyuWatch.roomCalls.at(-1), ['2', '3', '4', '5', '6'], '按列表顺序补位');
  assert.deepEqual(harness.data.watchQueued, []);
});

test('名额共用：检测房与激增房按房间列表顺序共享同一个名额池，不按需求类型优先', async () => {
  const clock = createClock(0);
  const rooms = [
    room('1', 'douyu', { surgeAlert: true }),
    room('2', 'douyu', { watch: WATCH }),
    room('3', 'douyu', { surgeAlert: true }),
    room('4', 'douyu', { watch: WATCH }),
    room('5', 'douyu', { surgeAlert: true }),
    room('6', 'douyu', { watch: WATCH })
  ];
  const data = ['1', '2', '3', '4', '5', '6'].map(id => online(id));
  const harness = createHarness({
    rooms,
    streamers: data.map(d => streamer(d.roomId, 'douyu'))
  }, { clock, apiResults: { douyu: douyuResult(data) } });

  await poll(harness);
  assert.deepEqual(
    harness.clients.douyuWatch.roomCalls.at(-1),
    ['1', '2', '3', '4', '5'],
    '两种需求排在同一队列里，前 5 个拿到名额'
  );
  assert.deepEqual(harness.data.watchQueued, [{ roomId: '6', platform: 'douyu', nickname: '昵称6' }]);

  // 拿到名额的激增房照常触发（池子里没有「哪种需求更优先」的规则）
  await feedMinutes(harness, clock, '1', 10, 10);
  await feed(harness, '1', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'douyu_1_surge');
});

test('正交性：检测总开关关闭时激增照常工作，激增总开关关闭时检测照常工作', async () => {
  const clock = createClock(0);
  const both = { surgeAlert: true, watch: WATCH };

  // 检测关闭：连接为激增保留，命中检测词不再计数
  const watchOff = createHarness({
    rooms: [room('100', 'douyu', both)],
    streamers: [streamer('100', 'douyu')]
  }, { clock });

  await watchOff.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { danmakuWatchEnabled: false } });
  assert.deepEqual(watchOff.clients.douyuWatch.roomCalls.at(-1), ['100'], '连接为激增保留');
  await watchOff.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(watchOff.notifications.length, 0, '检测总开关关闭：命中不发检测通知');

  await feedMinutes(watchOff, clock, '100', 10, 10);
  await feed(watchOff, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(watchOff);
  assert.equal(watchOff.notifications.length, 1);
  assert.equal(watchOff.notifications[0].id, 'douyu_100_surge');

  // 激增关闭：连接为检测保留，命中照发检测通知，但不判定激增
  const surgeOffClock = createClock(0);
  const surgeOff = createHarness({
    rooms: [room('100', 'douyu', both)],
    streamers: [streamer('100', 'douyu')],
    settings: { surgeAlertEnabled: false }
  }, { clock: surgeOffClock });

  await poll(surgeOff);
  assert.deepEqual(surgeOff.clients.douyuWatch.roomCalls.at(-1), ['100'], '连接为检测保留');
  await surgeOff.orchestrator.handleDanmu('douyu', { roomId: '100', text: '上车' });
  assert.equal(surgeOff.notifications.length, 1, '检测总开关开着：命中即发检测通知');
  assert.equal(surgeOff.notifications[0].id, 'douyu_100_watch');

  await feedMinutes(surgeOff, surgeOffClock, '100', 10, 10);
  await feed(surgeOff, '100', 100);
  surgeOffClock.advanceMinutes(1);
  await settleSurge(surgeOff);
  assert.equal(surgeOff.notifications.length, 1, '激增总开关关闭：不判定');
});

test('激增通知只受自己的总开关约束：开播通知总开关关闭不影响', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true })],
    streamers: [streamer('100', 'douyu')],
    settings: { notificationsEnabled: false }
  }, { clock });

  await poll(harness);
  await feedMinutes(harness, clock, '100', 10, 10);
  await feed(harness, '100', 100);
  clock.advanceMinutes(1);
  await settleSurge(harness);

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'douyu_100_surge');
});

test('B站：只开激增的房间也备好通道（登录态下发到桥接页），触发后发 B站激增通知', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('200', 'bilibili', { surgeAlert: true })],
    streamers: [streamer('200', 'bilibili', { title: 'B站在播' })]
  }, { clock, isLoggedIn: async () => true });

  await boot(harness);
  assert.equal(harness.bridge.enabled, true, '登录态走页面通道');

  await poll(harness);
  const watchMsgs = () => harness.tabApi.calls.sendMessage.filter(c => c.msg.type === 'BILI_WATCH_ROOMS');
  assert.deepEqual(watchMsgs().at(-1).msg.roomIds, ['200'], '只开激增、未配检测词也把盯守列表下发到桥接页');
  assert.deepEqual(harness.clients.bilibiliWatch.roomCalls.at(-1), [], '页面通道启用时不留 SW 直连');

  await feedMinutes(harness, clock, '200', 10, 10, 'bilibili');
  await feed(harness, '200', 100, 'bilibili');
  clock.advanceMinutes(1);
  await settleSurge(harness);

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'bilibili_200_surge');
  assert.equal(harness.notifications[0].content.title, '[B站] 昵称200 弹幕激增！');
  assert.equal(harness.notifications[0].content.message, 'B站在播');
});

test('通知点击：激增通知解析回对应平台的直播间地址', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { surgeAlert: true }), room('200', 'bilibili', { surgeAlert: true })]
  });

  await harness.orchestrator.onNotificationClicked('douyu_100_surge');
  await harness.orchestrator.onNotificationClicked('bilibili_200_surge');

  assert.deepEqual(harness.openedTabs.map(t => t.url), [
    'https://www.douyu.com/100',
    'https://live.bilibili.com/200'
  ]);
});

test('B站未登录：只开激增的房间走 SW 直连盯守', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('200', 'bilibili', { surgeAlert: true })],
    streamers: [streamer('200', 'bilibili')]
  }, { clock, apiResults: { bilibili: bilibiliResult([online('200', 'bilibili')]) } });

  await poll(harness);

  assert.equal(harness.bridge.enabled, false);
  assert.deepEqual(harness.clients.bilibiliWatch.roomCalls.at(-1), ['200']);
  assert.deepEqual(harness.tabApi.calls.sendMessage, [], '未登录不开桥接页');
});
