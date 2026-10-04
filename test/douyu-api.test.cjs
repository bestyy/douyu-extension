// test/douyu-api.test.cjs — 斗鱼 API（lib/douyu-api.js）的房间页靓号解析
//
// 运行：npm test（node --test）
// betard 只认内部 room_id，靓号（页面上叫 vipId）要拉一次房间页从内嵌数据里取。
// 这里覆盖：纯函数 extractInternalRoomId 的提取与守卫；fetchRoomInfo 的
// 「直查失败→页面解析→再查」流程、roomId 回显输入号、以及解析结果的缓存。
// 网络用假 fetch 路由替身，不发真实请求。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { HtmlEntities } = require('../lib/html-entities.js');
// douyu-api 在收敛接口文本时用全局 HtmlEntities（SW 里由 importScripts 提供），node 下手工补上
globalThis.HtmlEntities = HtmlEntities;
const { DouyuAPI, extractInternalRoomId } = require('../lib/douyu-api.js');

/** 一段房间页内嵌数据（与真实页面一样带反斜杠转义） */
const embedded = (roomId, vipId) =>
  `...{"roomInfo\\":{\\"room\\":{\\"room_id\\":${roomId},\\"vipId\\":${vipId},\\"isVertical\\":0}}...`;

// === 纯函数：从房间页内嵌数据提取内部 room_id ===

test('extractInternalRoomId：普通房间直接命中内部号（vipId 为 0）', () => {
  assert.equal(extractInternalRoomId(embedded(9999, 0), '9999'), '9999');
});

test('extractInternalRoomId：靓号页用 vipId 对上输入号，返回内部 room_id', () => {
  assert.equal(extractInternalRoomId(embedded(8727436, 91224), '91224'), '8727436');
});

test('extractInternalRoomId：无效号页没有 roomInfo，返回 null', () => {
  assert.equal(extractInternalRoomId('<!DOCTYPE html><html><body>该房间目前没有开放</body></html>', '999999999'), null);
});

test('extractInternalRoomId：只有 room_idle 之类近似字段时不误取', () => {
  assert.equal(extractInternalRoomId('{"room_idle\\":{\\"active\\":1,"minute_limit":40}}', '91224'), null);
});

test('extractInternalRoomId：页面里的推荐房间（内部号与靓号都不等于输入号）不认', () => {
  assert.equal(extractInternalRoomId(embedded(111, 0), '222'), null);
});

test('extractInternalRoomId：内嵌数据未转义时同样可用', () => {
  const plain = '{"roomInfo":{"room":{"room_id":8727436,"vipId":91224,"isVertical":0}}';
  assert.equal(extractInternalRoomId(plain, '91224'), '8727436');
});

// === fetchRoomInfo：靓号解析流程 ===

test('fetchRoomInfo：直查失败后按房间页解析内部号再查，roomId 回显输入号并缓存', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const routes = {
    // betard 不认靓号：回一页 HTML，JSON.parse 失败 → 非成功
    'https://www.douyu.com/betard/91225': { ok: true, body: '<!DOCTYPE html><html>该房间目前没有开放</html>' },
    // 房间页内嵌 vipId 91225 → 内部号 8727437
    'https://www.douyu.com/91225': { ok: true, body: embedded(8727437, 91225) },
    'https://www.douyu.com/betard/8727437': {
      ok: true,
      body: JSON.stringify({ room: { room_id: 8727437, owner_name: '暖妹QWQ', room_name: '晚上十点到泉州开播哦～', show_status: 2 } })
    }
  };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const route = routes[String(url)];
    return route ? { ok: route.ok, text: async () => route.body } : { ok: false, text: async () => '' };
  };

  try {
    const result = await DouyuAPI.fetchRoomInfo('91225');
    assert.equal(result.success, true);
    assert.equal(result.data.nickname, '暖妹QWQ', '昵称来自内部号直查的结果');
    assert.equal(result.data.roomId, '91225', 'roomId 回显调用方传入的靓号（复合键对齐）');
    assert.equal(result.data.internalRoomId, '8727437', '回传本次实际查询的内部号');
    assert.deepEqual(calls, [
      'https://www.douyu.com/betard/91225',
      'https://www.douyu.com/91225',
      'https://www.douyu.com/betard/8727437'
    ]);

    calls.length = 0;
    const cached = await DouyuAPI.fetchRoomInfo('91225');
    assert.equal(cached.success, true);
    assert.equal(cached.data.roomId, '91225');
    assert.equal(cached.data.internalRoomId, '8727437', '缓存命中时仍回传内部号');
    assert.deepEqual(calls, ['https://www.douyu.com/betard/8727437'], '缓存命中后直接查内部号，不再拉页面');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchRoomInfo：普通房间不被缓存影响，走一次直查', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      text: async () => JSON.stringify({ room: { room_id: 9999, owner_name: 'yyfyyf', room_name: '陪伴每一天！', show_status: 1 } })
    };
  };

  try {
    const result = await DouyuAPI.fetchRoomInfo('9999');
    assert.equal(result.success, true);
    assert.equal(result.data.online, true);
    assert.equal(result.data.roomId, '9999');
    assert.equal(result.data.internalRoomId, '9999', '普通房间内部号与输入号相同');
    assert.deepEqual(calls, ['https://www.douyu.com/betard/9999']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchRoomInfo：页面里没有对应房间时返回失败，不写缓存（下一轮可重试）', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/betard/900001')) {
      return { ok: true, text: async () => '<!DOCTYPE html><html>提示信息</html>' };
    }
    return { ok: true, text: async () => '<!DOCTYPE html><html>无效号页，无 roomInfo</html>' };
  };

  try {
    const result = await DouyuAPI.fetchRoomInfo('900001');
    assert.equal(result.success, false);

    calls.length = 0;
    await DouyuAPI.fetchRoomInfo('900001');
    assert.deepEqual(calls, [
      'https://www.douyu.com/betard/900001',
      'https://www.douyu.com/900001'
    ], '失败不缓存，下一轮仍按原号直查并重试解析');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// === fetchHighlights：调用方传入的号就是线上取数用的内部号（见 ADR-0017） ===

test('fetchHighlights：不再查内存缓存，收到的号即传下去的号', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    calls.push({ url: u, body: options && options.body });
    if (u.endsWith('/betard/91227')) {
      return { ok: true, text: async () => '<!DOCTYPE html><html>提示信息</html>' };
    }
    if (u.endsWith('/91227')) {
      return { ok: true, text: async () => embedded(8727439, 91227) };
    }
    if (u.endsWith('/betard/8727439')) {
      return { ok: true, text: async () => JSON.stringify({ room: { room_id: 8727439, owner_name: '甲', room_name: '在播', show_status: 1 } }) };
    }
    return { ok: true, text: async () => JSON.stringify({ error: 0, data: { highlightList: [] } }) };
  };

  try {
    // 先跑一次靓号解析，把 91227 → 8727439 写进内存缓存：若 fetchHighlights 仍读缓存，下面会被暴露
    await DouyuAPI.fetchRoomInfo('91227');
    calls.length = 0;

    await DouyuAPI.fetchHighlights('91227');
    assert.equal(calls[0].url, 'https://www.douyu.com/wgapi/vodnc/center/ailive/getHighlightDetail');
    assert.deepEqual(JSON.parse(calls[0].body), { rid: 91227, sort: 0 },
      '传入什么号就用什么号取，不读缓存换算（编排已负责传内部号）');

    calls.length = 0;
    await DouyuAPI.fetchHighlights('8727439');
    assert.deepEqual(JSON.parse(calls[0].body), { rid: 8727439, sort: 0 }, '传入内部号即内部号');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
