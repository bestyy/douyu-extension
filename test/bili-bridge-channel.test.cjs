// test/bili-bridge-channel.test.cjs — BiliBridgeChannel（lib/bili-bridge-channel.js）行为测试
//
// 运行：npm test（node --test test/）
// fake 设施：内存 storage + fake tabs（query/create/remove/reload/sendMessage 五方法），
// 全部用例不触网、不依赖 chrome 全局，模块走构造注入。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { BiliBridgeChannel } = require('../lib/bili-bridge-channel.js');

// === fake 设施 ===

// 内存 storage：仅实现 get(key) / set(key, value)（与 StorageHelper 接口一致）
function createFakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    async get(key) {
      return store[key];
    },
    async set(key, value) {
      store[key] = value;
    }
  };
}

// fake tabs：覆盖 query / create / remove / reload / sendMessage 五方法
// - query({url}) 用 url.startsWith('https://live.bilibili.com/') 近似 chrome 的 url 模式匹配
// - responders: tabId → (msg) => response；无 responder 时 sendMessage 抛错（模拟 content script 未注入）
// - autoRespond=true：create 的新 tab 自动注册 responder（模拟 content script 已就绪）
function createFakeTabs({ autoRespond = true } = {}) {
  const tabs = [];
  const responders = new Map();
  const calls = { create: 0, remove: [], reload: [], sendMessage: [] };
  let nextId = 1;

  const api = {
    tabs,
    responders,
    calls,
    autoRespond,

    // 预置标签页（respond 可选：注册 responder 模拟 content script 就绪）
    addTab(url, { respond } = {}) {
      const tab = { id: nextId++, url };
      tabs.push(tab);
      if (respond) {
        responders.set(tab.id, respond);
      }
      return tab;
    },

    async query({ url }) {
      assert.ok(url.startsWith('https://live.bilibili.com/'), `query 只应查 live.bilibili.com 模式: ${url}`);
      return tabs.filter(t => t.url.startsWith('https://live.bilibili.com/'));
    },

    async create({ url, active }) {
      calls.create += 1;
      const tab = { id: nextId++, url, active };
      tabs.push(tab);
      if (autoRespond) {
        responders.set(tab.id, () => ({ ok: true }));
      }
      return tab;
    },

    async remove(id) {
      calls.remove.push(id);
      const i = tabs.findIndex(t => t.id === id);
      if (i !== -1) {
        tabs.splice(i, 1);
        responders.delete(id);
      }
    },

    async reload(id) {
      calls.reload.push(id);
    },

    async sendMessage(id, msg) {
      calls.sendMessage.push({ id, msg });
      const responder = responders.get(id);
      if (!responder) {
        throw new Error(`no responder for tab ${id}`);
      }
      return responder(msg);
    }
  };
  return api;
}

const DEFAULT_SETTINGS = {
  refreshInterval: 60,
  notificationsEnabled: true,
  openInCurrentTab: false,
  fetchDouyuViewerCount: true,
  fetchBilibiliViewerCount: true,
  fetchViewerCount: true
};

// 测试用小的等待参数（waitReadyAttempts / waitReadyInterval 为构造参数，避免慢）
function makeChannel(storage, tabs, { isLoggedIn = async () => false, waitReadyAttempts = 3, waitReadyInterval = 5 } = {}) {
  return new BiliBridgeChannel({ storage, tabs, isLoggedIn, waitReadyAttempts, waitReadyInterval });
}

const BRIDGE_URL = 'https://live.bilibili.com/?dyext=1';

// === 用例 ===

test('sync：关闭 B站观众数开关 → 停用通道、清 streamers 的 rankCount（保留 vipCount）、关桥接页', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS, fetchBilibiliViewerCount: false },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }],
    streamers: [{ roomId: '1', platform: 'bilibili', nickname: '主播', title: 'T', vipCount: 5, rankCount: 3 }],
    biliPageChannelEnabled: true
  });
  const tabs = createFakeTabs();
  tabs.addTab(BRIDGE_URL, { respond: () => ({ ok: true }) });

  const ch = makeChannel(storage, tabs);
  await ch.sync();

  assert.equal(ch.enabled, false);
  assert.equal(storage.store.biliPageChannelEnabled, false);
  // 只删 B站 rankCount，斗鱼 vipCount 原样保留
  assert.deepEqual(storage.store.streamers, [{ roomId: '1', platform: 'bilibili', nickname: '主播', title: 'T', vipCount: 5 }]);
  // 桥接页被关
  assert.equal(tabs.tabs.length, 0);
});

test('sync：旧总开关 fetchViewerCount=false 回退 → 停用通道、清 rankCount（新字段未写入时）', async () => {
  const storage = createFakeStorage({
    settings: { refreshInterval: 60, notificationsEnabled: true, openInCurrentTab: false, fetchViewerCount: false },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }],
    streamers: [{ roomId: '1', platform: 'bilibili', nickname: '主播', rankCount: 9 }]
  });
  const tabs = createFakeTabs();

  const ch = makeChannel(storage, tabs);
  await ch.sync();

  assert.equal(ch.enabled, false);
  assert.equal(storage.store.biliPageChannelEnabled, false);
  assert.deepEqual(storage.store.streamers, [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]);
});

test('sync：无 B站房间 → 停用通道但不清 streamers（斗鱼贵宾数仍有效）', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'douyu', nickname: '主播' }],
    streamers: [{ roomId: '1', platform: 'douyu', nickname: '主播', vipCount: 5 }]
  });
  const tabs = createFakeTabs();

  const ch = makeChannel(storage, tabs);
  await ch.sync();

  assert.equal(ch.enabled, false);
  assert.equal(storage.store.biliPageChannelEnabled, false);
  assert.deepEqual(storage.store.streamers, [{ roomId: '1', platform: 'douyu', nickname: '主播', vipCount: 5 }]);
});

test('sync：登录态 → 启用页面通道并持久化', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]
  });
  const tabs = createFakeTabs();

  const ch = makeChannel(storage, tabs, { isLoggedIn: async () => true });
  await ch.sync();

  assert.equal(ch.enabled, true);
  assert.equal(storage.store.biliPageChannelEnabled, true);
});

test('sync：未登录 + 持久化降级标记 → 启用页面通道', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }],
    biliPageChannelEnabled: true
  });
  const tabs = createFakeTabs();

  const ch = makeChannel(storage, tabs);
  await ch.sync();

  assert.equal(ch.enabled, true);
});

test('sync：未登录无标记 + 残留桥接页 → 停用通道并清理页面', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]
  });
  const tabs = createFakeTabs();
  tabs.addTab(BRIDGE_URL, { respond: () => ({ ok: true }) });

  const ch = makeChannel(storage, tabs);
  await ch.sync();

  assert.equal(ch.enabled, false);
  assert.equal(tabs.tabs.length, 0, '残留桥接页应被关闭');
});

test('watch：有现有页 → 下发盯守列表（不等待完成信号、不关页）', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]
  });
  const tabs = createFakeTabs();
  const existing = tabs.addTab(BRIDGE_URL, { respond: () => ({ ok: true }) });

  const ch = makeChannel(storage, tabs);
  await ch.watch(['1', '2']);

  assert.equal(tabs.calls.create, 0, '复用现有页');
  const msg = tabs.calls.sendMessage.find(c => c.msg.type === 'BILI_WATCH_ROOMS');
  assert.ok(msg, '应发送 BILI_WATCH_ROOMS');
  assert.deepEqual(msg.msg.roomIds, ['1', '2']);
  assert.equal(msg.id, existing.id);
  assert.deepEqual(tabs.calls.remove, [], '盯守期间不关页');
});

test('watch：空列表 → 清掉残留检测连接，但不为此开页', async () => {
  const storage = createFakeStorage({ settings: { ...DEFAULT_SETTINGS } });
  const tabs = createFakeTabs();
  const existing = tabs.addTab(BRIDGE_URL, { respond: () => ({ ok: true }) });

  const ch = makeChannel(storage, tabs);
  await ch.watch([]);

  const msg = tabs.calls.sendMessage.find(c => c.msg.type === 'BILI_WATCH_ROOMS');
  assert.deepEqual(msg?.msg.roomIds, [], '应向现有页下发空列表');

  // 没有桥接页时不开页（轮询每轮都会下发空列表）
  const tabs2 = createFakeTabs();
  const ch2 = makeChannel(storage, tabs2);
  await ch2.watch([]);
  assert.equal(tabs2.calls.create, 0, '没有桥接页时不应创建');
  assert.equal(tabs2.calls.sendMessage.length, 0);
});

test('sample：无现有页 → 创建一次并驱动采样', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]
  });
  const tabs = createFakeTabs({ autoRespond: true });

  const ch = makeChannel(storage, tabs);
  await ch.sample(['12345']);

  assert.equal(tabs.calls.create, 1);
  const roomMsg = tabs.calls.sendMessage.find(c => c.msg.type === 'BILI_SAMPLE_ROOMS');
  assert.ok(roomMsg, '应发送 BILI_SAMPLE_ROOMS');
  assert.deepEqual(roomMsg.msg.roomIds, ['12345']);
  assert.equal(roomMsg.id, tabs.tabs[0].id);
});

test('sample：复用现有页（不新建）', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]
  });
  const tabs = createFakeTabs();
  const existing = tabs.addTab(BRIDGE_URL, { respond: () => ({ ok: true }) });

  const ch = makeChannel(storage, tabs);
  await ch.sample(['1']);

  assert.equal(tabs.calls.create, 0);
  const roomMsg = tabs.calls.sendMessage.find(c => c.msg.type === 'BILI_SAMPLE_ROOMS');
  assert.ok(roomMsg);
  assert.equal(roomMsg.id, existing.id);
});

test('sample：现有页 content script 失效 → reload 重新注入后仍无法就绪则关页', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]
  });
  const tabs = createFakeTabs();
  tabs.addTab(BRIDGE_URL); // 无 responder → ping 抛错

  const ch = makeChannel(storage, tabs);
  await ch.sample(['1']);

  assert.equal(tabs.calls.reload.length, 1, 'content script 未响应应 reload 一次');
  // reload 后重试仍无 responder → _waitReady 失败 → close
  assert.equal(tabs.tabs.length, 0);
});

test('sample：页面未就绪（重试用尽）→ 关闭页面且不发送采样消息', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]
  });
  const tabs = createFakeTabs({ autoRespond: false });

  const ch = makeChannel(storage, tabs); // waitReadyAttempts=3
  await ch.sample(['1']);

  assert.equal(tabs.calls.create, 1);
  assert.ok(!tabs.calls.sendMessage.some(c => c.msg.type === 'BILI_SAMPLE_ROOMS'), '不应发送 BILI_SAMPLE_ROOMS');
  assert.equal(tabs.calls.sendMessage.length, 3, 'ping 应重试 3 次后放弃');
  assert.equal(tabs.tabs.length, 0, '未就绪应关闭页面');
});

test('sample：驱动采样消息发送失败 → 关闭页面', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]
  });
  const tabs = createFakeTabs();
  tabs.addTab(BRIDGE_URL, {
    respond: (msg) => {
      if (msg.type === 'BILI_SAMPLE_ROOMS') {
        throw new Error('boom');
      }
      return { ok: true };
    }
  });

  const ch = makeChannel(storage, tabs);
  await ch.sample(['1']);

  assert.equal(tabs.tabs.length, 0, '发送失败应关闭页面');
});

test('close：只关桥接页，不动用户自己打开的 B站页面', async () => {
  const storage = createFakeStorage({ settings: { ...DEFAULT_SETTINGS } });
  const tabs = createFakeTabs();
  const bridge = tabs.addTab(BRIDGE_URL);
  const user = tabs.addTab('https://live.bilibili.com/12345');

  const ch = makeChannel(storage, tabs);
  await ch.close();

  assert.deepEqual(tabs.tabs, [user]);
  assert.deepEqual(tabs.calls.remove, [bridge.id]);
});

test('sample 并发去重：两次并发只创建一个页面', async () => {
  const storage = createFakeStorage({
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '1', platform: 'bilibili', nickname: '主播' }]
  });
  const tabs = createFakeTabs({ autoRespond: true });

  const ch = makeChannel(storage, tabs);
  await Promise.all([ch.sample(['1']), ch.sample(['2'])]);

  assert.equal(tabs.calls.create, 1);
});

test('enableFallback：启用页面通道并持久化', async () => {
  const storage = createFakeStorage({ settings: { ...DEFAULT_SETTINGS } });
  const tabs = createFakeTabs();

  const ch = makeChannel(storage, tabs);
  await ch.enableFallback();

  assert.equal(ch.enabled, true);
  assert.equal(storage.store.biliPageChannelEnabled, true);
});

test('enableFallback：关闭 B站观众数开关时不降级', async () => {
  const storage = createFakeStorage({ settings: { ...DEFAULT_SETTINGS, fetchBilibiliViewerCount: false } });
  const tabs = createFakeTabs();

  const ch = makeChannel(storage, tabs);
  await ch.enableFallback();

  assert.equal(ch.enabled, false);
  assert.equal(storage.store.biliPageChannelEnabled, undefined, '不应写入降级标记');
});
