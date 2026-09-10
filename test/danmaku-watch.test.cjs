// test/danmaku-watch.test.cjs — 弹幕检测纯逻辑（lib/danmaku-watch.js）行为测试
//
// 运行：npm test（node --test test/）
// 覆盖：配置归一化、命中匹配、盯守计划（5 上限与排队）、滑动窗口计数、冷却与锁定。
// 计数时钟通过构造注入可调假时钟，不依赖真实时间。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  WATCH_DEFAULTS,
  WATCH_MAX_CONCURRENT,
  normalizeWatch,
  isDanmakuWatchEnabled,
  matchKeyword,
  selectWatchPlan,
  hasConfiguredBiliWatch,
  DanmakuWatchCounter
} = require('../lib/danmaku-watch.js');

// 可调时钟：now() 返回 t，advance(ms) 推进
function createClock(t = 1000000) {
  return {
    t,
    now() { return this.t; },
    advance(ms) { this.t += ms; }
  };
}

function makeCounter(clock = createClock()) {
  return { counter: new DanmakuWatchCounter({ now: () => clock.now() }), clock };
}

const MIN = 60 * 1000;

// === 配置归一化 ===

test('normalizeWatch：缺省阈值/窗口/冷却按缺省值补齐', () => {
  assert.deepEqual(normalizeWatch({ enabled: true, keywords: ['上车'] }), {
    enabled: true,
    keywords: ['上车'],
    threshold: WATCH_DEFAULTS.threshold,
    windowMinutes: WATCH_DEFAULTS.windowMinutes,
    cooldownMinutes: WATCH_DEFAULTS.cooldownMinutes
  });
});

test('normalizeWatch：未启用 / 缺配置 / 无检测词 → 视为未配置', () => {
  assert.equal(normalizeWatch(undefined), null, '缺 watch 字段');
  assert.equal(normalizeWatch(null), null);
  assert.equal(normalizeWatch({ enabled: false, keywords: ['上车'] }), null, '开关关闭');
  assert.equal(normalizeWatch({ enabled: true }), null, '缺词组');
  assert.equal(normalizeWatch({ enabled: true, keywords: [] }), null, '词组为空');
  assert.equal(normalizeWatch({ enabled: true, keywords: ['', '   ', '\n'] }), null, '词组全是空白行');
});

test('normalizeWatch：词组去空白、去空行、去重（不区分大小写、保留首个写法）', () => {
  const config = normalizeWatch({ enabled: true, keywords: '  上车 \n\n 抽奖\n go \nGO\ngo  ' });
  assert.deepEqual(config.keywords, ['上车', '抽奖', 'go']);
});

test('normalizeWatch：词组上限 20 个、单词上限 10 字', () => {
  const many = Array.from({ length: 25 }, (_, i) => `词${i}`);
  assert.equal(normalizeWatch({ enabled: true, keywords: many }).keywords.length, 20);
  assert.deepEqual(normalizeWatch({ enabled: true, keywords: many }).keywords[19], '词19');

  const long = normalizeWatch({ enabled: true, keywords: ['一二三四五六七八九十十一'] });
  assert.deepEqual(long.keywords, ['一二三四五六七八九十']);
});

test('normalizeWatch：阈值 1–99、窗口 1–60、冷却 0–120 超范围钳制，非数字取缺省', () => {
  const low = normalizeWatch({ enabled: true, keywords: ['a'], threshold: 0, windowMinutes: 0, cooldownMinutes: -5 });
  assert.deepEqual(
    { threshold: low.threshold, windowMinutes: low.windowMinutes, cooldownMinutes: low.cooldownMinutes },
    { threshold: 1, windowMinutes: 1, cooldownMinutes: 0 }
  );

  const high = normalizeWatch({ enabled: true, keywords: ['a'], threshold: 500, windowMinutes: 999, cooldownMinutes: 999 });
  assert.deepEqual(
    { threshold: high.threshold, windowMinutes: high.windowMinutes, cooldownMinutes: high.cooldownMinutes },
    { threshold: 99, windowMinutes: 60, cooldownMinutes: 120 }
  );

  const bad = normalizeWatch({ enabled: true, keywords: ['a'], threshold: 'abc', windowMinutes: null, cooldownMinutes: undefined });
  assert.deepEqual(
    { threshold: bad.threshold, windowMinutes: bad.windowMinutes, cooldownMinutes: bad.cooldownMinutes },
    WATCH_DEFAULTS
  );

  // 数字字符串（设置页 number input 写出的是字符串）按数字解析
  const strNum = normalizeWatch({ enabled: true, keywords: ['a'], threshold: '3', windowMinutes: '7', cooldownMinutes: '0' });
  assert.deepEqual(
    { threshold: strNum.threshold, windowMinutes: strNum.windowMinutes, cooldownMinutes: strNum.cooldownMinutes },
    { threshold: 3, windowMinutes: 7, cooldownMinutes: 0 }
  );
});

// === 命中匹配 ===

test('matchKeyword：子串包含且不区分大小写，返回命中的检测词', () => {
  const config = normalizeWatch({ enabled: true, keywords: ['上车', 'go'] });
  assert.equal(matchKeyword('快上车了', config), '上车');
  assert.equal(matchKeyword('GO GO GO', config), 'go');
  assert.equal(matchKeyword('随便聊聊', config), null);
  assert.equal(matchKeyword('', config), null);
  assert.equal(matchKeyword(undefined, config), null);
});

test('matchKeyword：多词命中按配置顺序返回第一个', () => {
  const config = normalizeWatch({ enabled: true, keywords: ['抽奖', '上车'] });
  assert.equal(matchKeyword('上车抽奖啦', config), '抽奖');
});

test('matchKeyword：一条弹幕命中多词也只算一次命中（匹配结果恒为单个词）', () => {
  const config = normalizeWatch({ enabled: true, keywords: ['上车', '抽奖', 'go'] });
  // 命中多个词时只返回一个 → background 每条弹幕只调用一次 recordHit（一房多词共用计数器）
  assert.equal(matchKeyword('go 上车抽奖', config), '上车', '返回配置顺序第一个命中的词');
  assert.equal(matchKeyword('上车', config), '上车');
});

// === 盯守计划 ===

function room(roomId, watch, platform = 'douyu') {
  return { roomId: String(roomId), platform, nickname: `主播${roomId}`, watch };
}

const ON = (watch) => ({ enabled: true, keywords: ['上车'], ...watch });

test('selectWatchPlan：按房间列表顺序取前 5 个在线且启用的房间，其余排队', () => {
  const rooms = [1, 2, 3, 4, 5, 6].map(i => room(i, ON({})));
  const onlineKeys = new Set(rooms.map(r => `douyu_${r.roomId}`));

  const plan = selectWatchPlan(rooms, onlineKeys);

  assert.deepEqual(plan.active.map(e => e.roomId), ['1', '2', '3', '4', '5']);
  assert.deepEqual(plan.queued.map(e => e.roomId), ['6'], '超出的在线房间排队');
  assert.equal(plan.active.length, WATCH_MAX_CONCURRENT);
  assert.equal(plan.active[0].key, 'douyu_1');
  assert.equal(plan.active[0].config.threshold, WATCH_DEFAULTS.threshold, '计划条目带归一化配置');
});

test('selectWatchPlan：未开播 / 未配置 / 未启用 / 空检测词 / 无弹幕通道平台都不进计划', () => {
  const rooms = [
    room(1, ON({})),                       // 在线且启用 → 盯
    room(2, ON({})),                       // 未开播 → 不盯
    room(3, null),                         // 无检测配置 → 不盯
    room(4, { enabled: false, keywords: ['上车'] }), // 开关关闭 → 不盯
    room(5, ON({ keywords: [' ', ''] })),  // 检测词为空 → 不盯
    room(6, ON({}), 'other')               // 无弹幕通道的平台 → 不盯
  ];
  // 除 2 号外都在线
  const onlineKeys = new Set(['douyu_1', 'douyu_3', 'douyu_4', 'douyu_5', 'other_6']);

  const plan = selectWatchPlan(rooms, onlineKeys);

  assert.deepEqual(plan.active.map(e => e.roomId), ['1']);
  assert.deepEqual(plan.queued, [], '不在线的房间不算排队');
});

test('selectWatchPlan：下播释放名额后按列表顺序补位，在线房间不被抢占', () => {
  const rooms = [1, 2, 3, 4, 5, 6].map(i => room(i, ON({})));
  const allOnline = new Set(rooms.map(r => `douyu_${r.roomId}`));

  // 6 个都在线：6 号排队，再次计算（轮询重复）结果不变 → 不抢占
  assert.deepEqual(selectWatchPlan(rooms, allOnline).active.map(e => e.roomId), ['1', '2', '3', '4', '5']);
  assert.deepEqual(selectWatchPlan(rooms, allOnline).active.map(e => e.roomId), ['1', '2', '3', '4', '5']);

  // 3 号下播释放名额 → 6 号补位（而非抢占在线的房间）
  const without3 = new Set([...allOnline].filter(k => k !== 'douyu_3'));
  const plan = selectWatchPlan(rooms, without3);
  assert.deepEqual(plan.active.map(e => e.roomId), ['1', '2', '4', '5', '6']);
  assert.deepEqual(plan.queued, []);
});

test('selectWatchPlan：跨平台按房间列表顺序统一排队', () => {
  const rooms = [
    room(1, ON({})),
    room(200, ON({}), 'bilibili'),
    room(2, ON({})),
    room(201, ON({}), 'bilibili')
  ];
  const onlineKeys = new Set(['douyu_1', 'douyu_2', 'bilibili_200', 'bilibili_201']);

  const plan = selectWatchPlan(rooms, onlineKeys);

  assert.deepEqual(plan.active.map(e => e.key), ['douyu_1', 'bilibili_200', 'douyu_2', 'bilibili_201']);
});

// === 弹幕检测总开关 ===

test('isDanmakuWatchEnabled：默认开启，仅显式 false 视为关闭（旧版本无该字段）', () => {
  assert.equal(isDanmakuWatchEnabled(undefined), true, '无 settings');
  assert.equal(isDanmakuWatchEnabled({}), true, '无字段');
  assert.equal(isDanmakuWatchEnabled({ danmakuWatchEnabled: true }), true);
  assert.equal(isDanmakuWatchEnabled({ danmakuWatchEnabled: false }), false);
});

test('selectWatchPlan：总开关关闭时不盯守也不排队（房间配置照旧）', () => {
  const rooms = [1, 2, 3, 4, 5, 6].map(i => room(i, ON({})));
  const onlineKeys = new Set(rooms.map(r => `douyu_${r.roomId}`));

  const on = selectWatchPlan(rooms, onlineKeys);
  assert.equal(on.active.length, 5, '开启时照常盯守');
  assert.equal(on.queued.length, 1, '开启时超出上限的房间排队');

  const off = selectWatchPlan(rooms, onlineKeys, { enabled: false });
  assert.deepEqual(off.active, [], '关闭时不盯守');
  assert.deepEqual(off.queued, [], '关闭时也不排队（排队提示随之消失）');
});

test('hasConfiguredBiliWatch：总开关关闭时不备 B站通道', () => {
  const rooms = [room(200, ON({}), 'bilibili')];
  assert.equal(hasConfiguredBiliWatch(rooms), true, '默认开启时备通道');
  assert.equal(hasConfiguredBiliWatch(rooms, false), false, '关闭时不备通道');
  assert.equal(hasConfiguredBiliWatch([], true), false, '无配置房间时不备通道');
});

// === 滑动窗口计数与冷却 ===

test('计数：窗口内命中数达到阈值触发，未达阈值不触发', () => {
  const { counter, clock } = makeCounter();
  const config = { threshold: 3, windowMinutes: 5, cooldownMinutes: 10 };

  assert.equal(counter.recordHit('douyu_1', config).triggered, false);
  clock.advance(1000);
  assert.equal(counter.recordHit('douyu_1', config).triggered, false);
  clock.advance(1000);
  const hit = counter.recordHit('douyu_1', config);
  assert.equal(hit.triggered, true, '第 3 次命中触发');
  assert.equal(hit.count, 3);
});

test('计数：阈值 1 时首次命中即触发', () => {
  const { counter } = makeCounter();
  const hit = counter.recordHit('douyu_1', { threshold: 1, windowMinutes: 5, cooldownMinutes: 10 });
  assert.equal(hit.triggered, true);
  assert.equal(hit.count, 1);
});

test('计数：窗口外的旧命中不计入（滑动窗口）', () => {
  const { counter, clock } = makeCounter();
  const config = { threshold: 4, windowMinutes: 5, cooldownMinutes: 10 };

  counter.recordHit('douyu_1', config); // t0
  clock.advance(1 * MIN);
  counter.recordHit('douyu_1', config); // t0+1min
  clock.advance(1 * MIN);
  counter.recordHit('douyu_1', config); // t0+2min（3 条，未达阈值 4）
  clock.advance(5 * MIN);               // t0+7min：三条命中的时刻都已滑出 5 分钟窗口
  const afterGap = counter.recordHit('douyu_1', config);
  assert.equal(afterGap.triggered, false, '三小时前的词不和现在的词加在一起');
  assert.equal(afterGap.count, 1, '窗口内只剩这一条');
  clock.advance(30 * 1000);
  assert.equal(counter.recordHit('douyu_1', config).count, 2);
  clock.advance(30 * 1000);
  assert.equal(counter.recordHit('douyu_1', config).count, 3);
  clock.advance(30 * 1000);
  assert.equal(counter.recordHit('douyu_1', config).triggered, true, '同一窗口内凑满 4 条 → 触发');
});

test('计数：恰好等于窗口时长的命中算窗口外（边界）', () => {
  const { counter, clock } = makeCounter();
  const config = { threshold: 2, windowMinutes: 5, cooldownMinutes: 10 };

  counter.recordHit('douyu_1', config); // t0
  clock.advance(5 * MIN);               // 恰好 5 分钟
  assert.equal(counter.recordHit('douyu_1', config).triggered, false, 't0 命中已滑出窗口');
  clock.advance(1);
  assert.equal(counter.recordHit('douyu_1', config).triggered, true);
});

test('计数：不同房间互不影响', () => {
  const { counter } = makeCounter();
  const config = { threshold: 2, windowMinutes: 5, cooldownMinutes: 10 };

  assert.equal(counter.recordHit('douyu_1', config).triggered, false);
  assert.equal(counter.recordHit('douyu_2', config).triggered, false);
  assert.equal(counter.recordHit('bilibili_1', config).triggered, false);
  assert.equal(counter.recordHit('douyu_1', config).triggered, true);
  assert.equal(counter.recordHit('douyu_2', config).triggered, true);
});

test('冷却：触发后冷却内命中既不计数也不再触发，冷却结束后重新计数', () => {
  const { counter, clock } = makeCounter();
  const config = { threshold: 2, windowMinutes: 5, cooldownMinutes: 10 };

  counter.recordHit('douyu_1', config);
  assert.equal(counter.recordHit('douyu_1', config).triggered, true, '达到阈值触发');

  // 冷却内命中被压制，且不累计
  clock.advance(1 * MIN);
  assert.equal(counter.recordHit('douyu_1', config).triggered, false);
  clock.advance(1 * MIN);
  assert.equal(counter.recordHit('douyu_1', config).triggered, false);

  // 冷却结束后需要重新凑满阈值（前面被压制的命中不计数）
  clock.advance(9 * MIN); // 距触发 11 分钟 > 冷却 10 分钟
  assert.equal(counter.recordHit('douyu_1', config).triggered, false, '冷却后第 1 条只是重新开始计数');
  assert.equal(counter.recordHit('douyu_1', config).triggered, true, '第 2 条凑满阈值再次触发');
});

test('冷却为 0：触发后本场锁定，不再触发', () => {
  const { counter, clock } = makeCounter();
  const config = { threshold: 1, windowMinutes: 5, cooldownMinutes: 0 };

  assert.equal(counter.recordHit('douyu_1', config).triggered, true);
  clock.advance(60 * MIN);
  assert.equal(counter.recordHit('douyu_1', config).triggered, false, '锁定期间再多的命中也只报一次');
  clock.advance(60 * MIN);
  assert.equal(counter.recordHit('douyu_1', config).triggered, false);
});

test('reset：清空命中的窗口、冷却与锁定（下播清空）', () => {
  const { counter, clock } = makeCounter();
  const config = { threshold: 2, windowMinutes: 5, cooldownMinutes: 10 };

  counter.recordHit('douyu_1', config);
  assert.equal(counter.recordHit('douyu_1', config).triggered, true);

  counter.reset('douyu_1');
  // 冷却被清掉：立刻重新计数
  assert.equal(counter.recordHit('douyu_1', config).triggered, false, '清空后第 1 条重新计数');
  assert.equal(counter.recordHit('douyu_1', config).triggered, true);

  // 锁定同样被清掉
  const locked = { threshold: 1, windowMinutes: 5, cooldownMinutes: 0 };
  assert.equal(counter.recordHit('douyu_2', locked).triggered, true);
  assert.equal(counter.recordHit('douyu_2', locked).triggered, false);
  counter.reset('douyu_2');
  clock.advance(1000);
  assert.equal(counter.recordHit('douyu_2', locked).triggered, true);
});

test('resetAll：清空全部房间状态', () => {
  const { counter } = makeCounter();
  const config = { threshold: 1, windowMinutes: 5, cooldownMinutes: 0 };

  assert.equal(counter.recordHit('douyu_1', config).triggered, true);
  assert.equal(counter.recordHit('douyu_2', config).triggered, true);
  counter.resetAll();
  assert.equal(counter.recordHit('douyu_1', config).triggered, true);
  assert.equal(counter.recordHit('douyu_2', config).triggered, true);
});
