// test/danmaku-surge.test.cjs — 弹幕激增规则模块的纯计算单元测试
//
// 运行：npm test（node --test）
// 覆盖：参数归一化与总开关、分钟桶的时间轴对齐与空分钟补 0、只保留 30 桶、中位数基线、
// 冷启动（含桶数可配）、倍数与基线门槛、冷却、一次跨多桶只结算最近的完整桶、未跨桶不结算、reset。
// 全部用显式时刻驱动（recordDanmu / tick 都接受 now），不依赖真实时间。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SURGE_DEFAULTS,
  SURGE_MAX_BUCKETS,
  clampSurgeNumber,
  normalizeSurgeSettings,
  isSurgeAlertEnabled,
  SurgeMeter
} = require('../lib/danmaku-surge.js');

const MIN = 60 * 1000;
const at = minutes => minutes * MIN; // 第 minutes 分钟的任意时刻
const CONFIG = { multiple: 3, minBaseline: 3, cooldownMinutes: 30, minBuckets: 10 };

/** 在某分钟内灌 n 条弹幕 */
function feed(meter, key, minute, n) {
  for (let i = 0; i < n; i++) {
    meter.recordDanmu(key, at(minute));
  }
}

/** 每分钟 n 条，灌 minutes 分钟（用于铺垫基线） */
function feedBaseline(meter, key, minutes, n) {
  for (let m = 0; m < minutes; m++) {
    feed(meter, key, m, n);
  }
}

// === 参数归一化与总开关 ===

test('normalizeSurgeSettings：缺省值、字符串解析与范围钳制', () => {
  assert.deepEqual(
    normalizeSurgeSettings(undefined),
    { multiple: 3, minBaseline: 3, cooldownMinutes: 30, minBuckets: 10 }
  );
  assert.deepEqual(normalizeSurgeSettings({}), SURGE_DEFAULTS, '无字段取缺省');
  assert.deepEqual(
    normalizeSurgeSettings({
      surgeMultiple: '5', surgeMinBaseline: '10', surgeCooldownMinutes: '60', surgeMinBuckets: '20'
    }),
    { multiple: 5, minBaseline: 10, cooldownMinutes: 60, minBuckets: 20 },
    '表单字符串照解析'
  );
  assert.deepEqual(
    normalizeSurgeSettings({ surgeMultiple: 1, surgeMinBaseline: 0, surgeCooldownMinutes: 0, surgeMinBuckets: 1 }),
    { multiple: 1.1, minBaseline: 1, cooldownMinutes: 1, minBuckets: 2 },
    '低于下限钳到下限（倍数 1 是退化值，下限 1.1；冷启动只剩 1 个桶时基线恒为 0，下限 2）'
  );
  assert.deepEqual(
    normalizeSurgeSettings({ surgeMultiple: 99, surgeMinBaseline: 1e6, surgeCooldownMinutes: 999, surgeMinBuckets: 1e6 }),
    { multiple: 10, minBaseline: 999, cooldownMinutes: 180, minBuckets: 30 },
    '高于上限钳到上限（冷启动上限即每房保留的桶数）'
  );
  assert.deepEqual(
    normalizeSurgeSettings({ surgeMultiple: 'abc', surgeMinBaseline: NaN, surgeCooldownMinutes: null, surgeMinBuckets: null }),
    SURGE_DEFAULTS,
    '非法值取缺省'
  );
  assert.equal(clampSurgeNumber(7.9, [1, 10], 3), 7, '小数位的参数取整');
});

test('normalizeSurgeSettings：倍数支持一位小数，多余的位数截断', () => {
  assert.equal(normalizeSurgeSettings({ surgeMultiple: 1.5 }).multiple, 1.5, '表单字符串与数字都照收');
  assert.equal(normalizeSurgeSettings({ surgeMultiple: '1.5' }).multiple, 1.5, '字符串小数照解析');
  assert.equal(normalizeSurgeSettings({ surgeMultiple: 1.57 }).multiple, 1.5, '第二位小数截断');
  assert.equal(normalizeSurgeSettings({ surgeMultiple: 1.04 }).multiple, 1.1, '截断后低于下限仍被抬起');
  assert.equal(clampSurgeNumber(1.55, [1.1, 10], 3, 1), 1.5, '按 decimals 截断');
});

test('isSurgeAlertEnabled：默认开启，仅显式 false 视为关闭（旧版本无该字段）', () => {
  assert.equal(isSurgeAlertEnabled(undefined), true, '无 settings');
  assert.equal(isSurgeAlertEnabled({}), true, '无字段');
  assert.equal(isSurgeAlertEnabled({ surgeAlertEnabled: true }), true);
  assert.equal(isSurgeAlertEnabled({ surgeAlertEnabled: false }), false);
});

// === 分钟桶与基线 ===

test('分钟桶按绝对分钟对齐，安静分钟补 0：基线把安静时间算进去', () => {
  const meter = new SurgeMeter();
  feedBaseline(meter, 'k', 5, 10); // 第 0–4 分钟每分钟 10 条
  feed(meter, 'k', 10, 15);        // 第 5–9 分钟无弹幕，第 10 分钟来 15 条

  const result = meter.tick('k', at(11), CONFIG);

  assert.equal(result.bucketCount, 15, '评估的是第 10 分钟这个完整桶');
  assert.equal(result.baseline, 5, '10 个归档桶 = 5 个 10 条 + 5 个 0 条，中位数 5');
  assert.equal(result.triggered, true, '15 ≥ 5×3 且基线 5 ≥ 门槛 3');
});

test('基线取中位数：单点抖动不抬高水位', () => {
  const meter = new SurgeMeter();
  for (let m = 0; m < 3; m++) feed(meter, 'k', m, 10);
  feed(meter, 'k', 3, 100); // 历史桶里的单点抖动
  for (let m = 4; m < 13; m++) feed(meter, 'k', m, 10);
  feed(meter, 'k', 13, 40);

  const result = meter.tick('k', at(14), CONFIG);

  assert.equal(result.baseline, 10, '中位数不受单个 100 影响');
  assert.equal(result.triggered, true, '40 ≥ 10×3');
});

test(`只保留最近 ${SURGE_MAX_BUCKETS} 个归档桶：更早的水位不再参与基线`, () => {
  const meter = new SurgeMeter();
  for (let m = 0; m < 40; m++) feed(meter, 'k', m, 100); // 前 40 分钟：每分钟 100 条
  for (let m = 40; m < 70; m++) feed(meter, 'k', m, 5);  // 后 30 分钟：每分钟 5 条
  feed(meter, 'k', 70, 20);                              // 第 70 分钟来 20 条

  const result = meter.tick('k', at(71), CONFIG);

  assert.equal(result.baseline, 5, '40 分钟前的 100 条已被挤出窗口');
  assert.equal(result.bucketCount, 20);
  assert.equal(result.triggered, true, '20 ≥ 5×3 且基线 5 ≥ 3');
});

// === 冷启动 ===

test(`冷启动：归档桶不足 ${CONFIG.minBuckets} 个不裁决，攒够后开始裁决`, () => {
  const meter = new SurgeMeter();
  feedBaseline(meter, 'k', 8, 10); // 第 0–7 分钟每分钟 10 条
  feed(meter, 'k', 8, 100);        // 开播爬坡：第 8 分钟暴涨

  const cold = meter.tick('k', at(9), CONFIG);
  assert.equal(cold.bucketCount, 100);
  assert.equal(cold.triggered, false, '只有 9 个归档桶：样本不足以看出「突然」');

  for (let m = 9; m <= 16; m++) feed(meter, 'k', m, 10); // 攒桶期间照常每分钟 10 条
  feed(meter, 'k', 17, 100);
  const warm = meter.tick('k', at(18), CONFIG);

  assert.equal(warm.bucketCount, 100);
  assert.equal(warm.triggered, true, '样本够了，同样幅度的上涨就报');
});

test('冷启动桶数是参数：调小后同样的数据更早判定（调大则更晚）', () => {
  const meter = new SurgeMeter();
  for (const key of ['strict', 'loose']) {
    feedBaseline(meter, key, 5, 10); // 5 个归档桶，基线 10
    feed(meter, key, 5, 100);        // 第 5 分钟爆量
  }

  assert.equal(
    meter.tick('strict', at(6), CONFIG).triggered,
    false,
    '默认要 10 个桶：5 个样本不足，攒够之前不裁决'
  );
  assert.equal(
    meter.tick('loose', at(6), { ...CONFIG, minBuckets: 5 }).triggered,
    true,
    '冷启动调到 5：同一组数据立刻判定（100 ≥ 10×3）'
  );
});

// === 倍数与基线门槛 ===

test('倍数：上桶未达基线的倍数不触发，恰好达到就触发', () => {
  const meter = new SurgeMeter();
  for (const key of ['low', 'hit']) {
    feedBaseline(meter, key, 10, 10); // 基线 10
  }
  feed(meter, 'low', 10, 29);
  feed(meter, 'hit', 10, 30);

  assert.equal(meter.tick('low', at(11), CONFIG).triggered, false, '29 < 10×3');
  assert.equal(meter.tick('hit', at(11), CONFIG).triggered, true, '恰好 30 = 10×3');
});

test('倍数支持小数：1.5 倍下基线 10 的阈值是 15 条', () => {
  const meter = new SurgeMeter();
  for (const key of ['low', 'hit']) {
    feedBaseline(meter, key, 10, 10); // 基线 10
  }
  feed(meter, 'low', 10, 14); // 1.4 倍
  feed(meter, 'hit', 10, 15); // 1.5 倍

  const config = { ...CONFIG, multiple: 1.5 };
  const low = meter.tick('low', at(11), config);
  const hit = meter.tick('hit', at(11), config);

  assert.equal(low.triggered, false, '14 < 10×1.5 = 15');
  assert.equal(hit.triggered, true, '恰好 15 = 10×1.5');
  assert.equal(hit.baseline, 10, '基线仍是中位数，与倍数的小数位无关');
});

test('基线门槛：基线低于门槛时即使倍数满足也不触发（小体量房间可调低门槛）', () => {
  const meter = new SurgeMeter();
  for (const key of ['strict', 'loose']) {
    feedBaseline(meter, key, 10, 2); // 小体量房间：基线 2 条/分钟
  }
  feed(meter, 'strict', 10, 30);
  feed(meter, 'loose', 10, 30);

  assert.equal(
    meter.tick('strict', at(11), CONFIG).triggered,
    false,
    '基线 2 < 门槛 3：涨到 15 倍也不报（不是房间体量的问题，是门槛设高了）'
  );
  assert.equal(
    meter.tick('loose', at(11), { ...CONFIG, minBaseline: 1 }).triggered,
    true,
    '门槛调到 1 后，同样的数据就报'
  );
});

// === 冷却 ===

test('冷却：触发后冷却内不再触发，冷却结束后可再报', () => {
  const meter = new SurgeMeter();
  feedBaseline(meter, 'k', 10, 10);
  feed(meter, 'k', 10, 100);
  assert.equal(meter.tick('k', at(11), CONFIG).triggered, true, '第一次激增');

  feed(meter, 'k', 11, 100); // 冷却内再爆一次
  assert.equal(meter.tick('k', at(12), CONFIG).triggered, false, '冷却中不打扰');

  for (let m = 12; m <= 41; m++) feed(meter, 'k', m, 10); // 冷却期照常积累（30 分钟冷却到第 41 分钟）
  feed(meter, 'k', 42, 100);
  assert.equal(meter.tick('k', at(43), CONFIG).triggered, true, '冷却结束后同一房可以再报');
});

// === 跨桶与结算口径 ===

test('一次跨过多个桶（SW 挂起后恢复）只结算最近的完整桶，中间的桶不补报', () => {
  const meter = new SurgeMeter();
  feedBaseline(meter, 'k', 10, 10);
  feed(meter, 'k', 10, 100); // 爆点落在第 10 分钟

  const result = meter.tick('k', at(20), CONFIG); // 中间挂起 9 分钟，第 20 分钟才恢复

  assert.equal(result.bucketCount, 0, '结算的是最近的完整桶（第 19 分钟，0 条），不是第 10 分钟的 100 条');
  assert.equal(result.triggered, false, '陈旧的爆点不补报');
});

test('归档由先跨桶的一方完成：弹幕先跨桶时，随后的结算照样裁决那个桶（热闹房间不会漏判）', () => {
  const meter = new SurgeMeter();
  feedBaseline(meter, 'k', 10, 10);
  feed(meter, 'k', 10, 100); // 第 10 分钟的第一条弹幕先把第 9 分钟归档了

  const result = meter.tick('k', at(10), CONFIG); // 结算发生在同一个分钟内（生产里 alarm 相位不定的常见情形）

  assert.equal(result.bucketCount, 10, '裁决的是刚归档的第 9 分钟，而不是正在积累的第 10 分钟');
  assert.equal(result.baseline, 10);
  assert.equal(result.triggered, false, '10 < 10×3，但这说明裁决确实发生了');
});

test('同一个完整桶不重复裁决；正在积累的桶不评估', () => {
  const meter = new SurgeMeter();
  feedBaseline(meter, 'k', 10, 10);
  feed(meter, 'k', 10, 100);

  assert.equal(meter.tick('k', at(10), CONFIG).bucketCount, 10, '第一次结算：裁决刚归档的桶');
  assert.deepEqual(
    meter.tick('k', at(10), CONFIG),
    { triggered: false, bucketCount: 0, baseline: 0 },
    '同一个桶已经裁决过，不再重复'
  );

  feed(meter, 'k', 10, 500); // 正在积累的桶爆量
  assert.deepEqual(
    meter.tick('k', at(10), CONFIG),
    { triggered: false, bucketCount: 0, baseline: 0 },
    '当前这个桶还没结束，不参与评估'
  );
});

test('没有状态（从未收到弹幕）的房间结算不裁决', () => {
  const meter = new SurgeMeter();
  assert.deepEqual(meter.tick('none', at(5), CONFIG), { triggered: false, bucketCount: 0, baseline: 0 });
});

// === reset ===

test('reset：清空该房的桶与冷却（下播 / 停用后重新积累）', () => {
  const meter = new SurgeMeter();
  feedBaseline(meter, 'k', 10, 10);
  feed(meter, 'k', 10, 100);
  assert.equal(meter.tick('k', at(11), CONFIG).triggered, true, '触发后冷却到第 41 分钟');

  meter.reset('k');
  assert.deepEqual(
    meter.tick('k', at(12), CONFIG),
    { triggered: false, bucketCount: 0, baseline: 0 },
    '状态已清空'
  );

  // 重新积累并再次触发：原冷却（第 41 分钟）不应还在，否则这里不会报
  for (let m = 12; m <= 21; m++) feed(meter, 'k', m, 10);
  feed(meter, 'k', 22, 100);
  assert.equal(meter.tick('k', at(23), CONFIG).triggered, true, '冷却随 reset 清空，重新攒够就再报');
});
