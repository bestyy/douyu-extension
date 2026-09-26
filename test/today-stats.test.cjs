// test/today-stats.test.cjs — 今日统计规则模块（lib/today-stats.js）的纯计算单元测试
//
// 运行：npm test（node --test）
// 覆盖：平台门、总开关缺省与显式关闭、取数目标筛选（平台门 + 在线门）、保鲜（同一天 / 前一天 /
// 缺 date / 非对象记录）、statsDateKey 的本地日期口径与跨零点、shouldShowTodayStats 的整条判定表。
// 全部是纯函数调用（不驱动编排、不碰存储），口径见 ADR-0007 与 CONTEXT.md「今日统计」。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STATS_PLATFORMS,
  isTodayStatsEnabled,
  selectTodayStatsTargets,
  isStatsFresh,
  statsDateKey,
  shouldShowTodayStats
} = require('../lib/today-stats.js');

const room = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
/** 一条落盘的今日统计记录（date 与其它字段都由编排写入） */
const record = (date, extra = {}) => ({ chatPv: 95013, chatUv: 7459, giftAmount: 15614.9, giftUv: 198, fetchedAt: 0, date, ...extra });

// === 平台门与总开关 ===

test('STATS_PLATFORMS：只有斗鱼有这个形态的数据', () => {
  assert.deepEqual(STATS_PLATFORMS, ['douyu']);
  assert.equal(STATS_PLATFORMS.includes('bilibili'), false, 'B站没有对应物（拿B站房间号去查会错标成同号斗鱼房间）');
});

test('isTodayStatsEnabled：默认开启，仅显式 false 视为关闭（旧版本无该字段）', () => {
  assert.equal(isTodayStatsEnabled(undefined), true, '无 settings');
  assert.equal(isTodayStatsEnabled({}), true, '无字段');
  assert.equal(isTodayStatsEnabled({ todayStatsEnabled: true }), true);
  assert.equal(isTodayStatsEnabled({ todayStatsEnabled: false }), false);
});

// === 取数目标 ===

test('selectTodayStatsTargets：只取开播中的斗鱼房间（平台门 + 在线门）', () => {
  const rooms = [
    room('100', 'douyu', { online: true }),
    room('101', 'douyu', { online: false }),
    room('102', 'douyu'),                 // 无 online 字段（从未取到快照）
    room('200', 'bilibili', { online: true }),
    room('201', 'bilibili', { online: false })
  ];
  assert.deepEqual(selectTodayStatsTargets(rooms).map(r => r.roomId), ['100'], '离线房间与 B站房间都不取数');
});

test('selectTodayStatsTargets：空列表 / 畸形输入都返回空数组，不改动入参', () => {
  assert.deepEqual(selectTodayStatsTargets([]), []);
  assert.deepEqual(selectTodayStatsTargets(null), []);
  assert.deepEqual(selectTodayStatsTargets(undefined), []);
  const rooms = [null, undefined, { platform: 'douyu', online: true }]; // 最后一条缺 roomId 但仍是合法目标
  assert.deepEqual(selectTodayStatsTargets(rooms).map(r => r.online), [true]);
});

// === 保鲜 ===

test('isStatsFresh：date 等于今天才新鲜', () => {
  assert.equal(isStatsFresh(record('2026-09-26'), '2026-09-26'), true);
  assert.equal(isStatsFresh(record('2026-09-25'), '2026-09-26'), false, '昨天的记录跨零点后判废');
  assert.equal(isStatsFresh(record('2026-09-27'), '2026-09-26'), false, '未来日期同样不新鲜（存储被手改）');
});

test('isStatsFresh：缺 date 或非对象记录一律不新鲜（宁可不显示，也不把昨天当今天）', () => {
  assert.equal(isStatsFresh(record(undefined), '2026-09-26'), false);
  assert.equal(isStatsFresh(undefined, '2026-09-26'), false);
  assert.equal(isStatsFresh(null, '2026-09-26'), false);
  assert.equal(isStatsFresh('2026-09-26', '2026-09-26'), false, '字符串不是记录');
  assert.equal(isStatsFresh(record('2026-09-26'), undefined), false, '没有今天的日期口径时不显示');
});

// === 本地日期口径 ===

test('statsDateKey：按本地日期给出 YYYY-MM-DD（月 / 日补零）', () => {
  assert.equal(statsDateKey(new Date(2026, 8, 26, 12, 0, 0)), '2026-09-26');
  assert.equal(statsDateKey(new Date(2026, 0, 5, 9, 30, 0)), '2026-01-05', '月与日都补零');
  assert.equal(statsDateKey(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
});

test('statsDateKey：跨本地零点即换日期（盖戳与判废同源）', () => {
  const before = statsDateKey(new Date(2026, 8, 26, 23, 59, 59));
  const after = statsDateKey(new Date(2026, 8, 27, 0, 0, 1));
  assert.equal(before, '2026-09-26');
  assert.equal(after, '2026-09-27');
  assert.notEqual(before, after);
});

test('statsDateKey：接受时间戳，与同一时刻的 Date 同结论', () => {
  const at = new Date(2026, 8, 26, 8, 0, 0);
  assert.equal(statsDateKey(at.getTime()), statsDateKey(at));
});

// === 整条显示判定 ===

test('shouldShowTodayStats：总开关开且记录是今天的才显示', () => {
  const today = '2026-09-26';
  assert.equal(shouldShowTodayStats({ settings: {}, record: record(today), today }), true, '缺省总开关视为开启');
  assert.equal(
    shouldShowTodayStats({ settings: { todayStatsEnabled: true }, record: record(today), today }),
    true
  );
});

test('shouldShowTodayStats：总开关关闭时不显示（已落盘的数字仍在，只是不展示）', () => {
  assert.equal(
    shouldShowTodayStats({ settings: { todayStatsEnabled: false }, record: record('2026-09-26'), today: '2026-09-26' }),
    false
  );
});

test('shouldShowTodayStats：记录过期（跨零点）时不显示，总开关开着也一样', () => {
  assert.equal(
    shouldShowTodayStats({ settings: {}, record: record('2026-09-25'), today: '2026-09-26' }),
    false
  );
});

test('shouldShowTodayStats：记录缺失（当天还没取到数）时不显示', () => {
  assert.equal(shouldShowTodayStats({ settings: {}, record: undefined, today: '2026-09-26' }), false);
});

test('shouldShowTodayStats：两个条件都不过时不显示；缺参调用不抛', () => {
  assert.equal(
    shouldShowTodayStats({
      settings: { todayStatsEnabled: false },
      record: record('2026-09-25'),
      today: '2026-09-26'
    }),
    false
  );
  assert.equal(shouldShowTodayStats(), false);
  assert.equal(shouldShowTodayStats({}), false);
});
