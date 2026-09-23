// test/douyu-barrage.test.cjs — 斗鱼弹幕客户端（lib/douyu-barrage.js）的协议解析与采样超时兜底
//
// 运行：npm test（node --test test/）
// 这个文件此前没有任何测试：采样超时兜底依赖 WebSocket + 全局 fetch，替身成本太高，
// 于是那段承重的分支（决定「按贵宾数 0 上报」还是「重连一次」）从未被执行过。
// 现在开播状态经注入的 probeOnline port 取得、裁决是零依赖纯函数，两者都可单独驱动。
//
// 两组：
// - 协议解析：encodeFrame / decodeFrame / parseDyMessage（纯函数）
// - 采样兜底：decideSampleTimeout 的裁决表 + _handleTimeout 的接线（假 port、可控定时器、假 WebSocket）

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  BarrageClient,
  decideSampleTimeout,
  encodeFrame,
  decodeFrame,
  parseDyMessage
} = require('../lib/douyu-barrage.js');

// === 假设施 ===

/** 手动驱动的定时器：回调收起来、由测试决定何时触发（不注入就得等真实 20 秒） */
function createManualTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** 触发当前待处理的全部定时器（超时回调是异步的，等它跑完） */
    async fire() {
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) {
        await job.fn();
      }
    }
  };
}

/**
 * 安装假 WebSocket：node 有原生实现，不覆盖会真连网。
 * 只满足构造与 _disconnect 需要的面（send / close 为空操作）。
 */
function installFakeWebSocket(t) {
  const original = globalThis.WebSocket;
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      instances.push(this);
    }
    send() { }
    close() { this.readyState = 3; }
  }
  FakeWebSocket.OPEN = 1;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    if (original === undefined) {
      delete globalThis.WebSocket;
    } else {
      globalThis.WebSocket = original;
    }
  });
  return instances;
}

/** 采样实例：注入假 port 与可控定时器，收集 onVipCount 回调 */
function makeSamplingClient(t, probeOnline) {
  const timers = createManualTimers();
  const counts = [];
  const probeCalls = [];
  const client = new BarrageClient({
    probeOnline: async roomId => {
      probeCalls.push(roomId);
      return probeOnline(roomId);
    },
    onVipCount: data => counts.push(data),
    timers
  });
  return { client, timers, counts, probeCalls, sockets: installFakeWebSocket(t) };
}

// === 协议解析（纯函数） ===

test('encodeFrame：帧头两个长度字段为 body 字节数 + 9，类型 689，UTF-8 字节数而非字符数', () => {
  const body = 'type@=oni/vn@=123/';           // 纯 ASCII
  const cjk = 'type@=chatmsg/txt@=你好/';      // 含中文：字节数 ≠ 字符数

  for (const text of [body, cjk]) {
    const bytes = new TextEncoder().encode(text);
    const frame = encodeFrame(text);
    const view = new DataView(frame);

    assert.equal(frame.byteLength, 13 + bytes.length, `${text} 帧长 = 12B 头 + body + \\0`);
    assert.equal(view.getUint32(0, true), bytes.length + 9, '长度字段 1 = body 字节数 + 9');
    assert.equal(view.getUint32(4, true), bytes.length + 9, '长度字段 2 与字段 1 相同');
    assert.equal(view.getUint32(8, true), 689, '类型恒为 689');
    assert.deepEqual(
      [...new Uint8Array(frame, 12, bytes.length)],
      [...bytes],
      'body 按 UTF-8 原样写入'
    );
    assert.equal(new Uint8Array(frame)[frame.byteLength - 1], 0, '帧尾是 \\0');
  }
});

test('decodeFrame：剥掉 12B 头与尾部 \\0；字符串入参原样返回', () => {
  assert.equal(decodeFrame('type@=oni/'), 'type@=oni/', '字符串直接返回（不解析）');
  assert.equal(decodeFrame(encodeFrame('type@=oni/vn@=1/')), 'type@=oni/vn@=1/', '与 encodeFrame 往返一致');
  assert.equal(decodeFrame(encodeFrame('type@=chatmsg/txt@=中文弹幕/')), 'type@=chatmsg/txt@=中文弹幕/', '中文往返一致');

  // 尾部多个 \0 一并去掉（服务端补齐时可能不止一个）
  const padded = new Uint8Array([...new Uint8Array(encodeFrame('type@=uenter/')), 0, 0]);
  assert.equal(decodeFrame(padded), 'type@=uenter/');
});

test('parseDyMessage：key@=value/ 逐对解析，空值合法，键不含 / 与 @', () => {
  assert.deepEqual(parseDyMessage('type@=oni/vn@=123/rid@=100/'), { type: 'oni', vn: '123', rid: '100' });
  assert.deepEqual(parseDyMessage('type@=chatmsg/nn@=用户1/txt@=你好/'), { type: 'chatmsg', nn: '用户1', txt: '你好' });
  assert.deepEqual(parseDyMessage('type@=uenter/'), { type: 'uenter' });
  assert.deepEqual(parseDyMessage('type@=chatmsg/txt@=/'), { type: 'chatmsg', txt: '' }, '空值也算解析出来');
  assert.deepEqual(parseDyMessage(''), {}, '空串没有键值对');
});

// === 采样超时的裁决（纯函数） ===

test('decideSampleTimeout：未开播上报 0 / 在播首次重试 / 重试过即跳过 / 查不到放弃 / 已上报不动', () => {
  const cases = [
    [{ online: false }, 'report-zero'],
    [{ online: true, retried: false }, 'retry'],
    [{ online: true, retried: true }, 'skip'],
    [{ online: true }, 'retry'],
    [{ online: undefined }, 'abandon'],
    [{}, 'abandon'],
    [{ online: null }, 'abandon'],
    [{ online: 1 }, 'abandon'],
    [{ online: '1' }, 'abandon'],
    [{ online: false, reported: true }, 'ignore'],
    [{ online: true, reported: true }, 'ignore'],
    [{ online: undefined, reported: true }, 'ignore']
  ];
  for (const [facts, expected] of cases) {
    assert.equal(decideSampleTimeout(facts), expected, `facts=${JSON.stringify(facts)}`);
  }
});

// === 采样超时的接线 ===

test('构造：缺 probeOnline port 直接抛（不静默失去兜底）', () => {
  assert.throws(() => new BarrageClient({}), { name: 'TypeError' });
  assert.throws(() => new BarrageClient(), { name: 'TypeError' });
  assert.doesNotThrow(() => new BarrageClient({ probeOnline: async () => true }));
});

test('采样超时：未开播 → 按贵宾数 0 上报并收尾，不重连', async t => {
  const h = makeSamplingClient(t, async () => false);
  h.client.sample(['100']);

  assert.equal(h.timers.pending.size, 1, 'sample 排了一次采样超时');
  assert.equal([...h.timers.pending.values()][0].ms, 20000, '超时时长与 SAMPLE_TIMEOUT_MS 一致');
  assert.equal(h.sockets.length, 1);

  await h.timers.fire();

  assert.deepEqual(h.counts, [{ roomId: '100', vipCount: 0 }]);
  assert.equal(h.client.connections.size, 0, '收尾后不留连接');
  assert.equal(h.timers.pending.size, 0, '不再排新的超时');
});

test('采样超时：在播但没收到 oni → 立刻重连重试一次（重试连接有自己的超时）', async t => {
  const h = makeSamplingClient(t, async () => true);
  h.client.sample(['100']);

  await h.timers.fire();

  assert.deepEqual(h.counts, [], '未上报任何贵宾数');
  assert.equal(h.sockets.length, 2, '重连了一次');
  assert.equal(h.client.connections.size, 1);
  assert.equal(h.timers.pending.size, 1, '重试连接排了自己的超时');
});

test('采样超时：重试后仍超时 → 本轮跳过，不再重连也不再上报', async t => {
  const h = makeSamplingClient(t, async () => true);
  h.client.sample(['100']);

  await h.timers.fire(); // 第一次：retry
  await h.timers.fire(); // 第二次：skip

  assert.deepEqual(h.counts, []);
  assert.equal(h.sockets.length, 2, '只重连一次，不无限重试');
  assert.equal(h.client.connections.size, 0);
  assert.equal(h.timers.pending.size, 0);
});

test('采样超时：查不到开播状态 → 本轮放弃（不报 0、不重连）', async t => {
  for (const probe of [async () => undefined, async () => { throw new Error('boom'); }]) {
    const h = makeSamplingClient(t, probe);
    h.client.sample(['100']);

    await h.timers.fire();

    assert.deepEqual(h.counts, [], '查不到不等于未开播');
    assert.equal(h.sockets.length, 1, '不重连');
    assert.equal(h.timers.pending.size, 0);
    assert.equal(h.client.connections.size, 0);
  }
});

test('采样超时：探测期间 oni 已到达并上报 → 不被陈旧的探测结果覆盖成 0', async t => {
  const timers = createManualTimers();
  const counts = [];
  const sockets = installFakeWebSocket(t);
  let state = null;
  // 探测（最长 10 秒）期间，连接上的 oni 处理函数会把 state.reported 置真并自己上报
  let probeOnline = async () => false;
  const client = new BarrageClient({
    probeOnline: roomId => probeOnline(roomId),
    onVipCount: data => counts.push(data),
    timers
  });

  client.sample(['100']);
  state = client.connections.get('100');
  probeOnline = async () => {
    state.reported = true;
    return false;
  };

  await timers.fire();

  assert.deepEqual(counts, [], '已上报过的房间不再被 0 覆盖');
  assert.equal(sockets.length, 1);
  assert.equal(timers.pending.size, 0);
});

test('采样超时：同一个超时回调被触发两次 → 第二次不再白问一次开播状态', async t => {
  const h = makeSamplingClient(t, async () => false);
  h.client.sample(['100']);
  const [{ fn }] = [...h.timers.pending.values()];

  await fn(); // 第一次：report-zero，state.reported 置真
  await fn(); // 第二次：已上报 → ignore，不该再探测

  assert.deepEqual(h.counts, [{ roomId: '100', vipCount: 0 }], '只上报一次');
  assert.deepEqual(h.probeCalls, ['100'], '只探测一次');
});
