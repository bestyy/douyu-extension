// test/notify-flow.test.cjs — 开播通知链路（编排 + 房间库 + 真实规则 module）行为测试
//
// 运行：npm test（node --test）
// 覆盖：下播→开播边沿只发一条、持续在线不重复、新场次再发、notify 标记与总开关的静默、
// 接口失败保留旧态、首启只记录不通知、通知点击进入直播间（含派生 ID）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, poll, douyuResult, bilibiliResult } = require('./support/harness.cjs');

const room = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
const streamer = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, online: false, ...extra });

test('斗鱼：下播→开播发一条通知，持续在线不重复，下播后再开播算新场次再发', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { notify: true })],
    streamers: [streamer('100', 'douyu')]
  }, { apiResults: { douyu: douyuResult([{ roomId: '100', online: true, title: '在播', category: '游戏', nickname: '昵称100' }]) } });

  await poll(harness);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'douyu_100');
  assert.equal(harness.notifications[0].content.title, '[斗鱼] 昵称100 开播了！');
  assert.equal(harness.notifications[0].content.message, '在播');
  assert.equal(harness.notifications[0].content.contextMessage, '游戏');
  assert.deepEqual(harness.badge, [1]);

  await poll(harness);
  assert.equal(harness.notifications.length, 1, '持续在线不再通知');

  harness.setApiResult('douyu', douyuResult([{ roomId: '100', online: false, nickname: '昵称100' }]));
  await poll(harness);
  harness.setApiResult('douyu', douyuResult([{ roomId: '100', online: true, title: '第二场', nickname: '昵称100' }]));
  await poll(harness);
  assert.equal(harness.notifications.length, 2, '下播后再开播是新场次');
  assert.equal(harness.notifications[1].content.message, '第二场');
});

test('B站：开播通知标题带 [B站]，统计文案用高能榜在线数', async () => {
  const harness = createHarness({
    rooms: [room('200', 'bilibili', { notify: true })],
    streamers: [streamer('200', 'bilibili', { rankCount: 12000 })]
  }, { apiResults: { bilibili: bilibiliResult([{ roomId: '200', online: true, title: '在播', category: '虚拟主播', nickname: '昵称200' }]) } });

  await poll(harness);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'bilibili_200');
  assert.equal(harness.notifications[0].content.title, '[B站] 昵称200 开播了！');
  assert.equal(harness.notifications[0].content.contextMessage, '虚拟主播 · 1.2万 高能榜');
});

test('notify 标记为 false 或字段缺失（旧数据）：开播静默', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { notify: false }), room('101', 'douyu')],
    streamers: [streamer('100', 'douyu'), streamer('101', 'douyu')]
  }, {
    apiResults: { douyu: douyuResult([{ roomId: '100', online: true }, { roomId: '101', online: true }]) }
  });

  await poll(harness);
  assert.equal(harness.notifications.length, 0);
});

test('开播通知总开关关闭：不通知（房间标记保留）', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { notify: true })],
    streamers: [streamer('100', 'douyu')],
    settings: { notificationsEnabled: false }
  }, { apiResults: { douyu: douyuResult([{ roomId: '100', online: true }]) } });

  await poll(harness);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.data.rooms[0].notify, true);
});

test('接口失败：保留旧在线态、静默失效（不误报开播）', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { notify: true })],
    streamers: [streamer('100', 'douyu', { online: false })]
  }, { apiResults: { douyu: { success: false, data: [] } } });

  await poll(harness);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.data.streamers[0].online, false, '失败保留旧状态');
});

test('首次运行：已在线房间只记入 notifiedRooms 不通知，并清掉首启标记', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { notify: true }), room('101', 'douyu', { notify: true })],
    streamers: [streamer('100', 'douyu'), streamer('101', 'douyu')],
    _firstRun: true
  }, {
    apiResults: { douyu: douyuResult([{ roomId: '100', online: true }, { roomId: '101', online: false }]) }
  });

  await poll(harness);
  assert.equal(harness.notifications.length, 0);
  assert.deepEqual(harness.data.notifiedRooms, [{ roomId: '100', platform: 'douyu' }]);
  assert.equal(harness.data._firstRun, null);
});

test('通知点击进入直播间：开播通知与派生 ID 各自解析到同一房间', async () => {
  const harness = createHarness({ rooms: [room('100', 'douyu')] });
  for (const id of ['douyu_100', 'douyu_100_watch', 'douyu_100_viewer']) {
    await harness.orchestrator.onNotificationClicked(id);
  }
  await harness.orchestrator.onNotificationClicked('bilibili_200_viewer');
  assert.deepEqual(harness.openedTabs.map(t => t.url), [
    'https://www.douyu.com/100',
    'https://www.douyu.com/100',
    'https://www.douyu.com/100',
    'https://live.bilibili.com/200'
  ]);
});

test('新增房间先记为已通知：添加后第一轮轮询不把它当成新开播', async () => {
  const harness = createHarness({ rooms: [], streamers: [] }, {
    resolve: { douyu: { success: true, nickname: '新主播' } },
    apiResults: { douyu: douyuResult([{ roomId: '300', online: true, title: '在播' }]) }
  });

  const added = await harness.orchestrator.handleAddRoom('300', 'douyu');
  assert.equal(added.ok, true);
  assert.equal(added.nickname, '新主播');
  assert.equal(harness.notifications.length, 0, '新加入且已在线的房间不报开播');
  // 新房间 notify 默认关闭，轮询收敛时 notifiedRooms 只保留「在线且有通知标记」的房间
  assert.deepEqual(harness.data.notifiedRooms, []);
});

test('轮询按平台分组派发，没有房间的平台不发起请求', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu'), room('200', 'bilibili')],
    streamers: [streamer('100', 'douyu'), streamer('200', 'bilibili')]
  }, {
    apiResults: {
      douyu: douyuResult([{ roomId: '100', online: false }]),
      bilibili: bilibiliResult([{ roomId: '200', online: false }])
    }
  });

  await poll(harness);
  assert.deepEqual(harness.apiCalls, [
    { platform: 'douyu', ids: ['100'] },
    { platform: 'bilibili', ids: ['200'] }
  ]);
});

test('房间列表为空：不发请求、不稳动 lastRefresh', async () => {
  const harness = createHarness({ rooms: [], streamers: [] });
  await poll(harness);
  assert.deepEqual(harness.apiCalls, []);
  assert.equal('lastRefresh' in harness.data, false);
});
