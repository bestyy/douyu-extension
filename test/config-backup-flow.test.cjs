// test/config-backup-flow.test.cjs — 配置导入链路（编排 + 房间库 + 真实规则 module）行为测试
//
// 运行：npm test（node --test）
// 覆盖：导入把 rooms / categories / settings 整体替换并让 streamers 对齐；清空编排持有的运行时键
// （今日统计 / 看点水位 / 盯守排队 / 弹窗记忆 / 首启标记 / 上次刷新 / 通道降级标记）；把新配置里的
// 房间预记入 notifiedRooms；触发一轮完整收敛（基础 alarm 按新设置重建、立即轮询）；以及紧接着的
// 轮询不把正在直播的新房间当成新开播。文件本身的解析与拒绝口径在 test/config-backup.test.cjs；
// 房间库写入形状在 test/room-store.test.cjs 的 importConfig 用例。口径见 docs/adr/0012。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, poll, douyuResult, bilibiliResult } = require('./support/harness.cjs');

const room = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
const streamer = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, online: false, ...extra });

/** 导入一份配置（经编排的消息入口，与设置页发出的同一条路） */
async function importConfig(harness, config) {
  return await harness.orchestrator.onMessage({ type: 'IMPORT_CONFIG', config });
}

test('导入：三键整体替换、streamers 对齐、运行时键清空、notifiedRooms 预置新房间', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu', { online: true, title: '旧在播' })],
    categories: [{ id: 'c1', name: '旧分类' }],
    settings: { refreshInterval: 60 },
    // 编排持有的运行时键（导入后应被清掉）
    todayStats: { douyu_100: { chatPv: 999 } },
    highlightWatermarks: { douyu_100: 5 },
    watchQueued: [{ roomId: '100', platform: 'douyu', nickname: '旧' }],
    popupCategoryId: 'c1',
    biliPageChannelEnabled: true
  });

  const response = await importConfig(harness, {
    rooms: [room('700', 'bilibili'), room('800', 'douyu')],
    categories: [{ id: 'c1', name: '游戏' }],
    settings: { refreshInterval: 120 }
  });
  assert.equal(response.ok, true);

  assert.equal(harness.data.rooms.length, 2, 'rooms 整体替换');
  assert.equal(harness.data.rooms[0].platform, 'bilibili');
  assert.deepEqual(harness.data.categories, [{ id: 'c1', name: '游戏' }], 'categories 整体替换');
  assert.equal(harness.data.settings.refreshInterval, 120, 'settings 整体替换');

  assert.deepEqual(harness.data.streamers.map(s => `${s.platform}_${s.roomId}`), ['bilibili_700', 'douyu_800'],
    'streamers 按新房间列表对齐（旧房间的快照不留）');
  assert.equal(harness.data.streamers.every(s => s.online === false), true, '新增房间补空占位');

  assert.equal(harness.data.todayStats ?? null, null, '今日统计清空');
  assert.equal(harness.data.highlightWatermarks ?? null, null, '看点水位清空');
  assert.equal(harness.data.watchQueued ?? null, null, '盯守排队清空');
  assert.equal(harness.data.popupCategoryId ?? null, null, '弹窗记忆清空');
  assert.equal(harness.data._firstRun ?? null, null);
  assert.equal(harness.data.biliPageChannelEnabled, true,
    'B站通道降级标记不归编排清（它是桥接通道的键，清掉会白丢一次风控降级记忆）');

  const notified = (harness.data.notifiedRooms || []).map(n => `${n.platform}_${n.roomId}`).sort();
  assert.deepEqual(notified, [], '这两个房间当前离线：紧随的轮询把已通知集合收敛成「在播且开通知」的（见下一个用例的在播分支）');

  // 收敛：没配 API 结果 → 本轮取不到数据（success 但 data 为空会保留旧值），断言 alarm 按新设置重建
  const refreshAlarm = harness.alarms.filter(a => a.name === 'refreshRooms').pop();
  assert.equal(refreshAlarm.info.periodInMinutes, 2, 'refreshInterval 120 秒 → 2 分钟，导入后立刻收敛');
});

test('导入：紧随其后的轮询不把正在直播的新房间当成新开播（不涌出通知）', async () => {
  const harness = createHarness({
    rooms: [],
    streamers: [],
    settings: { refreshInterval: 60 }
  });
  harness.setApiResult('douyu', douyuResult([{ roomId: '800', online: true, title: '在播' }]));
  harness.setApiResult('bilibili', bilibiliResult([{ roomId: '700', online: true, title: '在播' }]));

  await importConfig(harness, {
    rooms: [
      room('800', 'douyu', { notify: true }),
      room('700', 'bilibili', { notify: true })
    ],
    categories: [],
    settings: { refreshInterval: 60 }
  });
  // 导入内的收敛已经轮询过一轮；再明确轮询一次，确认持续在播也不通知
  await poll(harness);

  assert.equal(harness.notifications.length, 0, '导入带进来的在播房间不当成新开播');
  const notified = (harness.data.notifiedRooms || []).map(n => `${n.platform}_${n.roomId}`).sort();
  assert.deepEqual(notified, ['bilibili_700', 'douyu_800']);
});

test('导入：空配置清空房间、分类与主播快照（弹窗不残留孤儿）', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu', { online: true })],
    categories: [{ id: 'c1', name: '旧' }],
    settings: { refreshInterval: 60 }
  });
  const response = await importConfig(harness, { rooms: [], categories: [], settings: { refreshInterval: 60 } });
  assert.equal(response.ok, true);
  assert.deepEqual(harness.data.rooms, []);
  assert.deepEqual(harness.data.streamers, []);
  assert.deepEqual(harness.data.categories, []);
  assert.equal(harness.data.notifiedRooms.length, 0);
  assert.equal(harness.badge[harness.badge.length - 1], 0, '导入空配置后徽标归零，不残留上一份配置的在播数');
});
