// test/doseeing-api.test.cjs — 第三方数据站 doseeing 取数模块（lib/doseeing-api.js）的收敛输出测试
//
// 运行：npm test（node --test）
// 桩掉 globalThis.fetch 喂录制的 JSON 响应（夹具取自真实响应，见 ADR-0007），钉住 fetchTodayStats 的
// 五个错误码与字段收敛：room 为 null 判 room_not_found、gift.paid.price 由分换元、stats[0] 缺失判
// no_stats、超时与非法 JSON 各自的错误码。
// 这一处最值得钉：分 / 元的换算错了只会静默显示错金额（站点前端自己也 /100 才成元）。
//
// 先例是 test/douyu-barrage.test.cjs 桩 globalThis.WebSocket 的做法。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fetchTodayStats } = require('../lib/doseeing-api.js');

// === 夹具（录制的真实响应，房间 12899565，2026-09-26）===

/** 成功响应：hours=today 的区间聚合 + 房间信息 */
const okResponse = {
  stats: [{
    rid: '12899565',
    'chat.pv': 95013,
    'chat.uv': 7459,
    'gift.paid.price': 1561490,
    'gift.paid.uv': 198,
    'gift.all.price': 1634490,
    'gift.all.uv': 349
  }],
  room: {
    rid: '12899565',
    nn: '馨馨子79',
    rn: '包在我身上',
    ol: 284428,
    ts: 1790409903,
    cid_names: '户外,颜值'
  },
  meta: { count: 981, unit: 'minute' }
};

/** 房间不存在：room 为 null，统计字段全 0（据此不可信） */
const notFoundResponse = {
  stats: [{
    rid: '99999999999',
    'chat.pv': 0,
    'chat.uv': 0,
    'gift.paid.price': 0,
    'gift.paid.uv': 0,
    'gift.all.price': 0,
    'gift.all.uv': 0
  }],
  room: null,
  meta: { count: 981, unit: 'minute' }
};

// === 假设施 ===

/** 安装假 fetch：记录调用参数，按脚本返回响应（或抛出） */
function installFakeFetch(t, impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  t.after(() => {
    if (original === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = original;
    }
  });
  return calls;
}

/** 手动驱动的定时器：把超时回调收起来、由测试决定何时触发（不注入就得等真实 10 秒） */
function installManualTimers(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pending = new Map();
  let nextId = 1;
  globalThis.setTimeout = (fn, ms) => {
    const id = nextId++;
    pending.set(id, { fn, ms });
    return id;
  };
  globalThis.clearTimeout = id => { pending.delete(id); };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
  return {
    /** 已登记的定时器（断言超时时长用） */
    entries: () => [...pending.values()],
    /** 触发全部待处理的定时器（超时回调同步 abort，不 await） */
    fire() {
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) job.fn();
    }
  };
}

const jsonResponse = body => ({ text: async () => JSON.stringify(body) });
/** 形如 fetch 被 AbortController 中断时抛出的错误 */
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// === 成功路径与字段收敛 ===

test('成功：四项数字收敛为 { chatPv, chatUv, giftAmount, giftUv, ts }，礼物金额由分换成元', async t => {
  const calls = installFakeFetch(t, async () => jsonResponse(okResponse));

  const result = await fetchTodayStats('12899565');

  assert.equal(result.success, true);
  assert.deepEqual(
    { ...result.data, ts: typeof result.data.ts },
    { chatPv: 95013, chatUv: 7459, giftAmount: 15614.9, giftUv: 198, ts: 'number' },
    '1561490 分 = 15614.9 元；ts 是取数完成时刻'
  );
  assert.equal('gift.all.price' in result.data, false, '全部礼物（含免费）不进收敛形状');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://www.doseeing.com/api/room_stat?room=12899565&hours=today',
    '请求就是契约里的那一个接口与 hours 枚举值'
  );
});

test('请求头带常见桌面 UA、Referer、X-Requested-With 与 Accept（匿名可用、无签名 token）', async t => {
  const calls = installFakeFetch(t, async () => jsonResponse(okResponse));

  await fetchTodayStats('12899565');

  const headers = calls[0].options.headers;
  assert.match(headers['User-Agent'], /Mozilla\/5\.0.*Chrome/, '带常见桌面 UA');
  assert.equal(headers.Referer, 'https://www.doseeing.com/room/12899565', 'Referer 指向该房房间页');
  assert.equal(headers['X-Requested-With'], 'XMLHttpRequest');
  assert.match(headers.Accept, /application\/json/);
});

test('分换元：整数分与带余分都只保留两位小数', async t => {
  const cases = [
    [1561490, 15614.9],
    [150, 1.5],
    [1, 0.01],
    [0, 0],
    [999, 9.99]
  ];
  for (const [cents, yuan] of cases) {
    installFakeFetch(t, async () => jsonResponse({
      ...okResponse,
      stats: [{ ...okResponse.stats[0], 'gift.paid.price': cents }]
    }));
    const result = await fetchTodayStats('12899565');
    assert.equal(result.data.giftAmount, yuan, `${cents} 分 = ${yuan} 元`);
  }
});

// === 失败路径 ===

test('room 为 null → room_not_found（统计字段全 0，据此不可信）', async t => {
  installFakeFetch(t, async () => jsonResponse(notFoundResponse));

  const result = await fetchTodayStats('99999999999');

  assert.deepEqual(result, { success: false, error: 'room_not_found' });
});

test('stats[0] 缺失或不可用 → no_stats', async t => {
  for (const stats of [undefined, [], [null]]) {
    installFakeFetch(t, async () => jsonResponse({ ...okResponse, stats }));
    const result = await fetchTodayStats('12899565');
    assert.deepEqual(result, { success: false, error: 'no_stats' }, `stats=${JSON.stringify(stats)}`);
  }
});

test('非法 JSON（站点返回 HTML 页）→ parse_error', async t => {
  installFakeFetch(t, async () => ({ text: async () => '<!DOCTYPE html><html>登录</html>' }));

  const result = await fetchTodayStats('12899565');

  assert.deepEqual(result, { success: false, error: 'parse_error' });
});

test('10 秒超时 → timeout（AbortController 中断这次请求）', async t => {
  const timers = installManualTimers(t);
  installFakeFetch(t, (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(abortError()));
  }));

  const pending = fetchTodayStats('12899565');
  assert.deepEqual(timers.entries().map(e => e.ms), [10000], '与本仓库其它 API 层同一套 10 秒超时');
  timers.fire();

  assert.deepEqual(await pending, { success: false, error: 'timeout' });
});

test('网络错误 → network_error，并带上原始 message', async t => {
  installFakeFetch(t, async () => { throw new Error('getaddrinfo ENOTFOUND www.doseeing.com'); });

  const result = await fetchTodayStats('12899565');

  assert.equal(result.success, false);
  assert.equal(result.error, 'network_error');
  assert.match(result.message, /ENOTFOUND/);
});

test('字段缺失时按 0 处理（站点给的是稀疏对象，缺字段不该判失败）', async t => {
  installFakeFetch(t, async () => jsonResponse({ ...okResponse, stats: [{ rid: '12899565', 'chat.pv': 12 }] }));

  const result = await fetchTodayStats('12899565');

  assert.deepEqual(
    { ...result.data, ts: typeof result.data.ts },
    { chatPv: 12, chatUv: 0, giftAmount: 0, giftUv: 0, ts: 'number' }
  );
});
