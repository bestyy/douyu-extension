// test/today-stats-flow.test.cjs — 今日统计链路（编排 + 房间库 + 真实规则 module）行为测试
//
// 运行：npm test（node --test）
// 覆盖：取数目标只含开播斗鱼房间、成功写入 todayStats 且带本地日期戳与取数时刻、值无变化不重写、
// 单房失败保留旧值、跨零点旧记录在显示判定里判废、总开关关闭时不发生任何取数调用、
// 取数 alarm 的创建与清除收敛点（有斗鱼房间且开关开才建、全无则清）、房间移除后该房条目被清，
// 以及「不产生任何通知」这条硬约束。
// 取数走编排的 alarm 入口（pollTodayStats），与生产同一条路；站点响应由 harness 的假 port 脚本化。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, poll, pollTodayStats, douyuResult } = require('./support/harness.cjs');
const { statsDateKey, isStatsFresh, shouldShowTodayStats } = require('../lib/today-stats.js');

const room = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
const streamer = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, online: true, ...extra });
const online = (roomId, platform = 'douyu', extra = {}) => ({ roomId, platform, online: true, ...extra });

/** 站点取数的成功返回（分已换成元，见 lib/doseeing-api.js） */
const stats = (extra = {}) => ({
  success: true,
  data: { chatPv: 95013, chatUv: 7459, giftAmount: 15614.9, giftUv: 198, ts: 12345, ...extra }
});

const today = () => statsDateKey(new Date());

test('取数目标只含开播中的斗鱼房间：离线房间与 B站房间都不请求', async () => {
  const harness = createHarness({
    rooms: [
      room('100', 'douyu', { online: true }),
      room('101', 'douyu', { online: false }),
      room('200', 'bilibili', { online: true })
    ],
    streamers: [streamer('100', 'douyu'), streamer('101', 'douyu', { online: false }), streamer('200', 'bilibili')]
  }, { todayStatsResult: stats() });

  await pollTodayStats(harness);

  assert.deepEqual(harness.todayStatsCalls, [{ roomId: '100' }], '只问开播的斗鱼房间');
  assert.deepEqual(Object.keys(harness.data.todayStats), ['douyu_100']);
});

test('取数成功：四项数字与本地日期戳落盘，取数时刻记为 fetchedAt；全程不产生任何通知', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { online: true })],
    streamers: [streamer('100', 'douyu')]
  }, { todayStatsResult: stats() });

  await pollTodayStats(harness);

  assert.deepEqual(harness.data.todayStats, {
    douyu_100: {
      chatPv: 95013,
      chatUv: 7459,
      giftAmount: 15614.9,
      giftUv: 198,
      date: today(),
      fetchedAt: 12345
    }
  });
  assert.equal(harness.notifications.length, 0, '这是本项目第一个不产生通知的功能');
  assert.equal(harness.badge.length, 0, '也不参与在线角标');
});

test('值无变化不重写：同一天同样的数字再取一次，落盘记录原地不动（fetchedAt 不刷新）', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { online: true })],
    streamers: [streamer('100', 'douyu')],
    todayStats: {
      douyu_100: { chatPv: 95013, chatUv: 7459, giftAmount: 15614.9, giftUv: 198, date: today(), fetchedAt: 1 }
    }
  }, { todayStatsResult: stats({ ts: 99999 }) });

  await pollTodayStats(harness);

  assert.equal(harness.data.todayStats.douyu_100.fetchedAt, 1, '数字没变就不写回');
});

test('值有变化才写回：数字涨了即更新，日期戳跟着当天的口径', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { online: true })],
    streamers: [streamer('100', 'douyu')],
    todayStats: {
      douyu_100: { chatPv: 1, chatUv: 1, giftAmount: 0, giftUv: 0, date: today(), fetchedAt: 1 }
    }
  }, { todayStatsResult: stats({ ts: 99999 }) });

  await pollTodayStats(harness);

  assert.deepEqual(harness.data.todayStats.douyu_100, {
    chatPv: 95013, chatUv: 7459, giftAmount: 15614.9, giftUv: 198, date: today(), fetchedAt: 99999
  });
});

test('单房失败保留旧值：接口抖动不让数字忽隐忽现，也不打扰用户', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { online: true })],
    streamers: [streamer('100', 'douyu')],
    todayStats: {
      douyu_100: { chatPv: 95013, chatUv: 7459, giftAmount: 15614.9, giftUv: 198, date: today(), fetchedAt: 1 }
    }
  }, { todayStatsResult: { success: false, error: 'timeout' } });

  await pollTodayStats(harness);

  assert.deepEqual(harness.data.todayStats.douyu_100, {
    chatPv: 95013, chatUv: 7459, giftAmount: 15614.9, giftUv: 198, date: today(), fetchedAt: 1
  }, '失败只记日志，不动该房旧值');
  assert.equal(harness.notifications.length, 0);

  harness.setTodayStatsResult({ success: false, error: 'room_not_found' });
  await pollTodayStats(harness);
  assert.equal(harness.data.todayStats.douyu_100.fetchedAt, 1, '再失败一次同样不动');
});

test('一个房失败不影响另一个房：同批并行取数各自处理', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { online: true }), room('101', 'douyu', { online: true })],
    streamers: [streamer('100', 'douyu'), streamer('101', 'douyu')]
  }, {
    todayStatsResult: roomId => (roomId === '100'
      ? { success: false, error: 'network_error' }
      : stats({ chatPv: 7 }))
  });

  await pollTodayStats(harness);

  assert.deepEqual(Object.keys(harness.data.todayStats), ['douyu_101'], '成功的照写，失败的没有条目');
  assert.equal(harness.data.todayStats.douyu_101.chatPv, 7);
});

test('跨零点：昨天的记录在显示判定里判废（这一行整行不显示），今天取到的才显示', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { online: true })],
    streamers: [streamer('100', 'douyu')],
    todayStats: {
      // 昨天取到的数字：跨过本地零点后仍是昨天那一场，不能当作「今天」
      douyu_100: { chatPv: 88888, chatUv: 6666, giftAmount: 1, giftUv: 1, date: '2000-01-01', fetchedAt: 1 }
    }
  }, { todayStatsResult: { success: false, error: 'timeout' } });

  await pollTodayStats(harness);
  const record = harness.data.todayStats.douyu_100;
  assert.equal(isStatsFresh(record, today()), false, '旧值与今天的日期口径不同源');
  assert.equal(shouldShowTodayStats({ settings: {}, record, today: today() }), false, '取数失败时旧值判废 → 整行隐藏');

  harness.setTodayStatsResult(stats());
  await pollTodayStats(harness);
  const fresh = harness.data.todayStats.douyu_100;
  assert.equal(isStatsFresh(fresh, today()), true);
  assert.equal(shouldShowTodayStats({ settings: {}, record: fresh, today: today() }), true);
});

test('总开关关闭：不请求第三方站点、不落盘；重新打开后恢复取数（已落盘的数字保留）', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { online: true })],
    streamers: [streamer('100', 'douyu')],
    settings: { todayStatsEnabled: false }
  }, { todayStatsResult: stats() });

  await pollTodayStats(harness);
  assert.deepEqual(harness.todayStatsCalls, [], '关掉后完全不请求该站');
  assert.equal(harness.data.todayStats, undefined);

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { todayStatsEnabled: true } });
  await pollTodayStats(harness);
  assert.equal(harness.todayStatsCalls.length, 1, '重新打开后最多等一个刷新周期就能看到');
  assert.deepEqual(Object.keys(harness.data.todayStats), ['douyu_100']);
});

test('取数 alarm 的收敛点：有斗鱼房间且开关开才建、已在跑不重建、全无则清', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')]
  });
  const statsAlarms = () => harness.alarms.filter(a => a.name === 'todayStatsPoll');

  await poll(harness);
  assert.equal(statsAlarms().length, 1, '有斗鱼房间且开关开就建');
  assert.equal(statsAlarms()[0].info.periodInMinutes, 5, '周期写死 5 分钟（不受轮询间隔设置影响）');

  await poll(harness);
  assert.equal(statsAlarms().length, 1, '已在跑不重建（避免每轮把取数一直往后推）');

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { todayStatsEnabled: false } });
  assert.deepEqual(harness.clearedAlarms, ['todayStatsPoll'], '总开关关闭即清掉，不给 SW 留无用唤醒');

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { todayStatsEnabled: true } });
  assert.equal(statsAlarms().length, 2, '重新打开即恢复');
});

test('只有 B站房间时不建取数 alarm（平台门与开关共同决定 alarm 的存在）', async () => {
  const harness = createHarness({
    rooms: [room('200', 'bilibili')],
    streamers: [streamer('200', 'bilibili')]
  });

  await poll(harness);

  assert.equal(harness.alarms.filter(a => a.name === 'todayStatsPoll').length, 0, '没有斗鱼房间就没有取数节拍');
});

test('移除房间清掉该房条目：重新添加不会沿用旧数字', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { online: true })],
    streamers: [streamer('100', 'douyu')]
  }, { todayStatsResult: stats() });

  await pollTodayStats(harness);
  assert.deepEqual(Object.keys(harness.data.todayStats), ['douyu_100']);

  await harness.orchestrator.onMessage({ type: 'REMOVE_ROOM', roomId: '100', platform: 'douyu' });

  assert.deepEqual(harness.data.todayStats, {}, '移除房间顺手清掉该房的今日统计');
});

test('与开播通知总开关正交：关掉开播通知不影响今日统计取数', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { online: true })],
    streamers: [streamer('100', 'douyu')],
    settings: { notificationsEnabled: false }
  }, { todayStatsResult: stats() });

  await pollTodayStats(harness);

  assert.deepEqual(harness.todayStatsCalls, [{ roomId: '100' }]);
  assert.deepEqual(Object.keys(harness.data.todayStats), ['douyu_100']);
});

test('开播状态由轮询确定：离线时不取数，转为开播后的下一轮才取', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu', { online: false })]
  }, { todayStatsResult: stats() });

  await pollTodayStats(harness);
  assert.deepEqual(harness.todayStatsCalls, [], '下播房间的卡片本就不显示，不查');

  harness.setApiResult('douyu', douyuResult([online('100')]));
  await poll(harness);
  await pollTodayStats(harness);

  assert.deepEqual(harness.todayStatsCalls, [{ roomId: '100' }], '开播后照常取数');
});
