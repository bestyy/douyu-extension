// test/danmaku-watch-flow.test.cjs — 弹幕检测链路（background.js 开播门控 → 长连接 → 计数 → 检测通知）行为测试
//
// 运行：npm test（node --test test/）
// fake 设施：内存 chrome（storage/alarms/notifications/action/cookies/tabs + 消息监听捕获）
//           + 可编程 fetch 路由 + 可调时钟（注入 Date）+ fake WebSocket（测试显式驱动 open/message/close）。
// lib/* 与 background.js 通过 vm context 拼接加载（剥离 importScripts，每用例独立 context）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// === 可调时钟 ===
// 注入 sandbox 的 Date：窗口滑动与冷却用假时间推进，用例不依赖真实等待
function createClock(start = 1600000000000) {
  const state = { t: start };
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [state.t]));
    }
    static now() {
      return state.t;
    }
  }
  return {
    state,
    FakeDate,
    advance(ms) { state.t += ms; }
  };
}

const MINUTE = 60 * 1000;

// === fake WebSocket ===
// 连接生命周期完全由测试驱动（serverOpen/serverMessage），close 同步记录：
// 客户端主动关闭时 onclose 会同步回调，但 state.stopped 已置位，重连逻辑不会启动。
function createWebSocketStub() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = String(url);
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.closeCalls = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      sockets.push(this);
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.closeCalls += 1;
      if (this.readyState === FakeWebSocket.CLOSED) {
        return;
      }
      this.readyState = FakeWebSocket.CLOSED;
      if (this.onclose) {
        this.onclose({ code: 1000, wasClean: true });
      }
    }

    get closed() {
      return this.readyState === FakeWebSocket.CLOSED;
    }

    // --- 测试驱动 ---
    serverOpen() {
      this.readyState = FakeWebSocket.OPEN;
      if (this.onopen) {
        this.onopen({});
      }
    }

    async serverMessage(data) {
      if (this.onmessage) {
        await this.onmessage({ data });
      }
    }
  }
  return {
    FakeWebSocket,
    sockets,
    open: () => sockets.filter(s => !s.closed),
    douyu: () => sockets.filter(s => s.url.startsWith('wss://danmuproxy')),
    bili: () => sockets.filter(s => s.url.includes('comet.test'))
  };
}

// === chrome stub ===
function createChromeStub({ loggedIn = false } = {}) {
  const store = {};
  const created = [];
  const alarmListeners = [];
  const messageListeners = [];
  const createdAlarms = [];

  // fake tabs（B站桥接页通道）：create 出的新页自动注册 responder（模拟 content script 就绪）
  const tabs = [];
  const responders = new Map();
  const tabCalls = { create: 0, remove: [], reload: [], sendMessage: [] };
  let nextTabId = 1;

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === null) return JSON.parse(JSON.stringify(store));
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) {
            if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v));
        },
        async getAll() {
          return JSON.parse(JSON.stringify(store));
        }
      }
    },
    alarms: {
      create(name, info) { createdAlarms.push({ name, info }); },
      onAlarm: { addListener(cb) { alarmListeners.push(cb); } }
    },
    notifications: {
      create(id, opts) { created.push({ id, opts }); return Promise.resolve(id); },
      onClicked: { addListener() {} },
      onButtonClicked: { addListener() {} }
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {}
    },
    cookies: {
      async get({ name }) {
        return loggedIn && name === 'SESSDATA' ? { name, value: 'sess-value' } : null;
      },
      async set() {}
    },
    tabs: {
      async query() { return tabs.filter(t => t.url.startsWith('https://live.bilibili.com/')); },
      async create({ url, active }) {
        tabCalls.create += 1;
        const tab = { id: nextTabId++, url, active };
        tabs.push(tab);
        responders.set(tab.id, () => ({ ok: true }));
        return tab;
      },
      async remove(id) {
        tabCalls.remove.push(id);
        const i = tabs.findIndex(t => t.id === id);
        if (i !== -1) tabs.splice(i, 1);
        responders.delete(id);
      },
      async reload(id) { tabCalls.reload.push(id); },
      async sendMessage(id, msg) {
        tabCalls.sendMessage.push({ id, msg });
        const responder = responders.get(id);
        if (!responder) throw new Error(`no responder for tab ${id}`);
        return responder(msg);
      }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(cb) { messageListeners.push(cb); } }
    },
    __store: store,
    __created: created,
    __alarmListeners: alarmListeners,
    __messageListeners: messageListeners,
    __createdAlarms: createdAlarms,
    __tabs: tabs,
    __tabCalls: tabCalls
  };
  return chrome;
}

// === 可编程 fetch 路由 ===
function createFetchStub(handlers) {
  return async function fetch(url) {
    for (const h of handlers) {
      if (h.match(String(url))) return h.respond(String(url));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const FALLBACK = { match: () => true, respond: () => ({ ok: true, text: async () => '', json: async () => ({ code: -1 }) }) };

function douyuRoomPayload({ online, roomId, nickname = '测试主播', title = '测试标题' }) {
  return JSON.stringify({
    room: {
      room_id: roomId,
      owner_name: nickname,
      room_name: title,
      show_status: online ? 1 : 0,
      videoLoop: 0,
      room_src: '',
      owner_avatar: '',
      room_biz_all: { hot: 0 },
      cate_name: '英雄联盟',
      show_time: '0'
    }
  });
}

function biliInfoPayload({ online, roomId = '200', nickname = 'B站主播' }) {
  return {
    code: 0,
    data: {
      room_id: roomId,
      uid: 42,
      uname: nickname,
      title: 'B站标题',
      live_status: online ? 1 : 0,
      user_cover: '',
      face: '',
      online: 0,
      parent_area_name: '网游',
      live_time: '0'
    }
  };
}

// 斗鱼轮询 handler（betard）；弹幕连接本身不联网
function douyuHandlers(onlineState) {
  return [
    {
      match: u => u.includes('www.douyu.com/betard/'),
      respond: u => ({
        ok: true,
        text: async () => douyuRoomPayload({ online: onlineState.online, roomId: u.split('/betard/')[1] })
      })
    },
    FALLBACK
  ];
}

// B站轮询 + 弹幕连接所需的全部 handler（spi / room_init / getDanmuInfo）
function biliHandlers(onlineState) {
  return [
    {
      match: u => u.includes('room/v1/Room/get_info'),
      respond: () => ({ ok: true, json: async () => biliInfoPayload({ online: onlineState.online }) })
    },
    {
      match: u => u.includes('web-interface/card'),
      respond: () => ({ ok: true, json: async () => ({ code: 0, data: { card: { name: 'B站主播', face: '' } } }) })
    },
    {
      match: u => u.includes('/x/frontend/finger/spi'),
      respond: () => ({ ok: true, json: async () => ({ code: 0, data: { b_3: 'ABCD-1234-5678-9ABC-infoc', b_4: 'B4VALUE' } }) })
    },
    {
      match: u => u.includes('Room/room_init'),
      respond: () => ({ ok: true, json: async () => ({ code: 0, data: { room_id: 200 } }) })
    },
    {
      match: u => u.includes('getDanmuInfo'),
      respond: () => ({ ok: true, json: async () => ({ code: 0, data: { host_list: [{ host: 'comet.test', wss_port: 2245 }], token: 'tok' } }) })
    },
    FALLBACK
  ];
}

// === 加载 background.js（剥离 importScripts，拼接 lib 源码）===
function loadBackground(chrome, fetchStub, clock, wsStub) {
  const libs = [
    'lib/storage.js',
    'lib/danmaku-watch.js',
    'lib/douyu-api.js',
    'lib/bilibili-api.js',
    'lib/douyu-barrage.js',
    'lib/bilibili-barrage.js',
    'lib/bili-bridge-channel.js'
  ];
  let src = libs.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')
    .replace(/^importScripts\([^)]*\);\s*$/gm, '');
  src += '\n;\n' + bg;

  const sandbox = {
    chrome,
    fetch: fetchStub,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    Date: clock.FakeDate,
    navigator: { userAgent: 'node-test' },
    WebSocket: wsStub.FakeWebSocket
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background-harness.js' });
  // B站弹幕帧在 vm 上下文内构造：保证 ArrayBuffer 属于该 realm（客户端 instanceof 判定成立）
  vm.runInContext(`
    globalThis.__biliDanmuFrame = (text, user) => {
      const body = JSON.stringify({ cmd: 'DANMU_MSG', info: [[], text, [0, user, 0], []] });
      const bodyBytes = new TextEncoder().encode(body);
      const buf = new ArrayBuffer(16 + bodyBytes.length);
      const view = new DataView(buf);
      view.setUint32(0, 16 + bodyBytes.length, false);
      view.setUint16(4, 16, false);
      view.setUint16(6, 1, false);
      view.setUint32(8, 5, false);
      view.setUint32(12, 0, false);
      new Uint8Array(buf, 16).set(bodyBytes);
      return buf;
    };
  `, sandbox, { filename: 'frame-builder.js' });
  return sandbox;
}

// 斗鱼弹幕消息帧（客户端 decodeFrame 对字符串原样解析，不覆盖帧编解码）
function dyChat(text, user = '观众', roomId = '100') {
  return `type@=chatmsg/rid@=${roomId}/txt@=${text}/nn@=${user}/level@=1/`;
}

const DEFAULT_SETTINGS = {
  refreshInterval: 60,
  notificationsEnabled: true,
  openInCurrentTab: false,
  fetchDouyuViewerCount: true,
  fetchBilibiliViewerCount: true
};

function flush(rounds = 3) {
  return new Promise(resolve => {
    let n = 0;
    const step = () => {
      if (++n >= rounds) return resolve();
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

// 触发一次 refreshRooms（走真实的 onAlarm 监听器，验证接线）
async function fireAlarm(chrome, name = 'refreshRooms') {
  assert.ok(chrome.__alarmListeners.length > 0, 'onAlarm 监听器应已注册');
  for (const cb of chrome.__alarmListeners) {
    await cb({ name, scheduledTime: Date.now() });
  }
  await flush();
}

// 给 SW 派发一条运行时消息（如桥接页回传的弹幕 / 采样完成）
async function dispatchMessage(chrome, message) {
  for (const cb of chrome.__messageListeners) {
    await new Promise(resolve => {
      const keepAlive = cb(message, {}, resolve);
      if (keepAlive !== true) {
        resolve();
      }
    });
  }
  await flush();
}

function notesById(chrome, id) {
  return chrome.__created.filter(n => n.id === id);
}

function detectionNotes(chrome) {
  return chrome.__created.filter(n => n.id.endsWith('_watch'));
}

// 建立一个典型环境：房间 + 轮询路由 + 弹幕连接设施
// 存储先于 background 加载写入（与真实 SW 被唤醒时一致：存储里已有上次的快照与配置）
// 用例结束销毁检测客户端（心跳定时器否则会吊住 node 进程）
async function setup(t, { rooms, streamers = [], onlineState, fetchHandlers, loggedIn = false }) {
  const clock = createClock();
  const chrome = createChromeStub({ loggedIn });
  const wsStub = createWebSocketStub();
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS },
    rooms,
    streamers,
    notifiedRooms: []
  });
  const sandbox = loadBackground(chrome, createFetchStub(fetchHandlers || douyuHandlers(onlineState || { online: false })), clock, wsStub);
  t.after(() => {
    vm.runInContext(
      'douyuWatchClient.destroy(); bilibiliWatchClient.destroy(); barrageClient.destroy(); bilibiliBarrageClient.destroy();',
      sandbox
    );
  });
  return { clock, chrome, sandbox, ws: wsStub };
}

function watchConfig(overrides = {}) {
  return { enabled: true, keywords: ['上车'], threshold: 2, windowMinutes: 5, cooldownMinutes: 10, ...overrides };
}

// === 用例 ===

test('斗鱼：未开播不建连接；开播后建检测长连接，命中达阈值发检测通知（与开播通知互不覆盖）', async (t) => {
  const online = { online: false };
  const { chrome, ws, clock } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: true, watch: watchConfig() }],
    fetchHandlers: douyuHandlers(online)
  });

  // 未开播：轮询正常运行但不建任何弹幕连接
  await fireAlarm(chrome);
  assert.equal(ws.sockets.length, 0, '未开播不应建立检测连接');

  // 开播：建长连接 + 开播通知
  online.online = true;
  await fireAlarm(chrome);
  assert.equal(ws.douyu().length, 1, '开播应建立一条检测长连接');
  assert.equal(notesById(chrome, 'douyu_100').length, 1, '开播通知照常发送');

  const sock = ws.douyu()[0];
  sock.serverOpen();

  // 未命中检测词的弹幕不计入
  await sock.serverMessage(dyChat('随便聊聊'));
  assert.equal(detectionNotes(chrome).length, 0, '未命中不应通知');

  // 第 1 条命中：未达阈值 2
  await sock.serverMessage(dyChat('快上车了', '小明'));
  assert.equal(detectionNotes(chrome).length, 0, '未达阈值不应通知');

  // 第 2 条命中：触发检测通知
  await sock.serverMessage(dyChat('上车！', '小红'));
  const hits = detectionNotes(chrome);
  assert.equal(hits.length, 1, '达到阈值应发一条检测通知');
  assert.equal(hits[0].id, 'douyu_100_watch', '检测通知用派生 ID（不覆盖开播通知）');
  assert.match(hits[0].opts.title, /测试主播/);
  assert.match(hits[0].opts.title, /弹幕命中/);
  assert.match(hits[0].opts.message, /上车/);
  assert.equal(notesById(chrome, 'douyu_100').length, 1, '开播通知未被检测通知覆盖');

  // 同一房间再次触发（冷却结束后重新凑满阈值）：通知 ID 相同（覆盖而非堆积）
  clock.advance(11 * MINUTE);
  await sock.serverMessage(dyChat('上车啦'));
  await sock.serverMessage(dyChat('又上车'));
  const after = detectionNotes(chrome);
  assert.equal(after.length, 2, '冷却结束后重新凑满阈值再触发一条');
  assert.ok(after.every(n => n.id === 'douyu_100_watch'), '同一房间重复触发复用同一通知 ID');
});

test('斗鱼：下播断开连接并清空计数，重新开播后需重新凑满阈值', async (t) => {
  const online = { online: false };
  const { chrome, ws } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false, watch: watchConfig() }],
    fetchHandlers: douyuHandlers(online)
  });

  online.online = true;
  await fireAlarm(chrome);
  const first = ws.douyu()[0];
  first.serverOpen();
  await first.serverMessage(dyChat('上车'));
  assert.equal(detectionNotes(chrome).length, 0, '第 1 条未达阈值');

  // 下播：断开连接
  online.online = false;
  await fireAlarm(chrome);
  assert.equal(first.closed, true, '下播应断开检测长连接');
  assert.equal(ws.open().length, 0);

  // 重新开播：计数已清空，第 2 条命中不足以触发
  online.online = true;
  await fireAlarm(chrome);
  const second = ws.douyu().find(s => !s.closed);
  assert.ok(second && second !== first, '重新开播应建新连接');
  second.serverOpen();
  await second.serverMessage(dyChat('上车'));
  assert.equal(detectionNotes(chrome).length, 0, '下播已清空计数，不能与上一场累加');

  await second.serverMessage(dyChat('上车'));
  assert.equal(detectionNotes(chrome).length, 1, '重新凑满阈值才触发');
});

test('冷却为 0（本场锁定）：触发一次后不再报，下播后解锁', async (t) => {
  const online = { online: true };
  const { chrome, ws } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false, watch: watchConfig({ threshold: 1, cooldownMinutes: 0 }) }],
    fetchHandlers: douyuHandlers(online)
  });

  await fireAlarm(chrome);
  const sock = ws.douyu()[0];
  sock.serverOpen();
  await sock.serverMessage(dyChat('上车'));
  assert.equal(detectionNotes(chrome).length, 1);

  await sock.serverMessage(dyChat('上车'));
  await sock.serverMessage(dyChat('又上车'));
  assert.equal(detectionNotes(chrome).length, 1, '本场锁定后不再打扰');

  // 下播 → 重新开播：锁定解除
  online.online = false;
  await fireAlarm(chrome);
  online.online = true;
  await fireAlarm(chrome);
  const next = ws.douyu().find(s => !s.closed);
  next.serverOpen();
  await next.serverMessage(dyChat('上车'));
  assert.equal(detectionNotes(chrome).length, 2, '下一场重新可报');
});

test('冷却期内命中不计数，冷却结束后重新凑满阈值再报', async (t) => {
  const online = { online: true };
  const { chrome, ws, clock } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false, watch: watchConfig({ threshold: 1, cooldownMinutes: 10 }) }],
    fetchHandlers: douyuHandlers(online)
  });

  await fireAlarm(chrome);
  const sock = ws.douyu()[0];
  sock.serverOpen();

  await sock.serverMessage(dyChat('上车'));
  assert.equal(detectionNotes(chrome).length, 1);

  clock.advance(5 * MINUTE);
  await sock.serverMessage(dyChat('上车'));
  assert.equal(detectionNotes(chrome).length, 1, '冷却内命中被压制');

  clock.advance(6 * MINUTE); // 距上次触发 11 分钟 > 冷却 10 分钟
  await sock.serverMessage(dyChat('上车'));
  assert.equal(detectionNotes(chrome).length, 2, '冷却结束后重新可报');
});

test('上限与排队：最多盯 5 个开播房间，超出按房间列表顺序排队并在 watchQueued 中提示', async (t) => {
  // 每个房间独立控制开播状态（改动后由下一轮轮询的 API 结果驱动门控）
  const online = { byRoom: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true } };
  const handlers = [
    {
      match: u => u.includes('www.douyu.com/betard/'),
      respond: u => {
        const roomId = u.split('/betard/')[1];
        return { ok: true, text: async () => douyuRoomPayload({ online: online.byRoom[roomId], roomId }) };
      }
    },
    FALLBACK
  ];
  const rooms = [1, 2, 3, 4, 5, 6].map(i => ({
    roomId: String(i),
    nickname: `主播${i}`,
    platform: 'douyu',
    notify: false,
    watch: watchConfig({ threshold: 1 })
  }));
  const { chrome, ws } = await setup(t, { rooms, fetchHandlers: handlers });

  await fireAlarm(chrome);
  assert.equal(ws.open().length, 5, '同时最多 5 条检测连接');

  // 重复轮询不抢占：仍是房间列表前 5 个
  await fireAlarm(chrome);
  assert.equal(ws.open().length, 5);

  const triggered = [];
  for (const sock of ws.open()) {
    sock.serverOpen();
    await sock.serverMessage(dyChat('上车'));
  }
  triggered.push(...detectionNotes(chrome).map(n => n.id));
  assert.deepEqual(triggered.sort(), ['douyu_1_watch', 'douyu_2_watch', 'douyu_3_watch', 'douyu_4_watch', 'douyu_5_watch']);
  assert.deepEqual(
    chrome.__store.watchQueued,
    [{ roomId: '6', platform: 'douyu', nickname: '主播6' }],
    '排队房间写入 watchQueued 供 popup 提示'
  );

  // 3 号下播释放名额 → 6 号补位
  online.byRoom[3] = false;
  await fireAlarm(chrome);
  assert.equal(ws.open().length, 5, '名额释放后仍是 5 条');
  const newly = ws.open().filter(s => s.sent.length === 0);
  assert.equal(newly.length, 1, '补位房间建立 1 条新连接');
  for (const sock of newly) {
    sock.serverOpen();
    await sock.serverMessage(dyChat('上车'));
  }
  assert.equal(notesById(chrome, 'douyu_6_watch').length, 1, '排队的 6 号补位后开始盯');
  assert.deepEqual(chrome.__store.watchQueued, [], '补位后无排队房间');
});

test('SW 被回收后唤醒（未及轮询）：按存储重建盯守配置与连接，首批弹幕不被丢弃', async (t) => {
  const { chrome, ws } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false, watch: watchConfig({ threshold: 1 }) }],
    // 存储里是上次轮询留下的在线快照（SW 唤醒时先据此重建盯守，不等下一轮 60 秒轮询）
    streamers: [{ roomId: '100', platform: 'douyu', nickname: '测试主播', online: true, title: 'T' }],
    fetchHandlers: douyuHandlers({ online: true })
  });
  await flush();

  const sock = ws.douyu()[0];
  assert.ok(sock, '唤醒即按在线快照恢复检测长连接');
  sock.serverOpen();
  await sock.serverMessage(dyChat('上车', '小明'));

  const notes = notesById(chrome, 'douyu_100_watch');
  assert.equal(notes.length, 1, '唤醒后的首批弹幕照常计数触发');
  assert.match(notes[0].opts.message, /小明/);
});

test('一房多词共用一个计数器：一条弹幕命中多词也只计一次', async (t) => {
  const cfg = { enabled: true, keywords: ['上车', '抽奖'], threshold: 2, windowMinutes: 5, cooldownMinutes: 10 };
  const { chrome, ws } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false, watch: cfg }],
    fetchHandlers: douyuHandlers({ online: true })
  });

  await fireAlarm(chrome);
  const sock = ws.douyu()[0];
  sock.serverOpen();

  // 一条弹幕同时命中两个检测词：只计 1 次，未达阈值
  await sock.serverMessage(dyChat('上车抽奖啦'));
  assert.equal(detectionNotes(chrome).length, 0, '一条弹幕命中多词只计一次，未达阈值 2');

  // 再来一条（换另一个词）→ 计数到 2 → 触发；通知里带的是命中的那个检测词
  await sock.serverMessage(dyChat('口令抽奖'));
  const notes = detectionNotes(chrome);
  assert.equal(notes.length, 1, '第二条才凑满阈值');
  assert.match(notes[0].opts.contextMessage, /抽奖/);
});

test('检测通知点击进入直播间：派生 ID 与开播通知各自解析到同一房间', async (t) => {
  const { sandbox } = await setup(t, {
    rooms: [],
    fetchHandlers: douyuHandlers({ online: false })
  });

  const url = id => vm.runInContext(`getLiveUrlFromNotificationId(${JSON.stringify(id)})`, sandbox);
  assert.equal(url('douyu_100'), 'https://www.douyu.com/100', '开播通知 ID');
  assert.equal(url('douyu_100_watch'), 'https://www.douyu.com/100', '检测通知派生 ID（去掉 _watch 后缀）');
  assert.equal(url('bilibili_200_watch'), 'https://live.bilibili.com/200');
});

test('未配置检测（空检测词 / 开关关闭）的房间不建连接', async (t) => {
  const online = { online: true };
  const { chrome, ws } = await setup(t, {
    rooms: [
      { roomId: '100', nickname: 'A', platform: 'douyu', notify: false, watch: { enabled: true, keywords: ['', '  '], threshold: 1 } },
      { roomId: '101', nickname: 'B', platform: 'douyu', notify: false, watch: { enabled: false, keywords: ['上车'], threshold: 1 } },
      { roomId: '102', nickname: 'C', platform: 'douyu', notify: false }
    ],
    fetchHandlers: douyuHandlers(online)
  });

  await fireAlarm(chrome);
  assert.equal(ws.sockets.length, 0, '空配置不放连接');
  assert.deepEqual(chrome.__store.watchQueued || [], [], '无排队房间时不写 watchQueued');
});

test('B站未登录：检测走 SW 直连长连接，DANMU_MSG 命中触发检测通知', async (t) => {
  const online = { online: true };
  const { chrome, sandbox, ws } = await setup(t, {
    rooms: [{ roomId: '200', nickname: 'B站主播', platform: 'bilibili', notify: true, watch: watchConfig({ threshold: 1, keywords: ['抽奖'] }) }],
    fetchHandlers: biliHandlers(online)
  });

  await fireAlarm(chrome);
  assert.equal(ws.bili().length, 1, '未登录应走 SW 直连建检测长连接');
  assert.equal(chrome.__tabCalls.create, 0, '未登录不打开桥接页');

  const sock = ws.bili()[0];
  sock.serverOpen();
  await sock.serverMessage(sandbox.__biliDanmuFrame('抽奖口令来了', '小明'));

  const notes = notesById(chrome, 'bilibili_200_watch');
  assert.equal(notes.length, 1, 'DANMU_MSG 命中应发检测通知');
  assert.match(notes[0].opts.message, /抽奖/);
  assert.equal(notesById(chrome, 'bilibili_200').length, 1, '开播通知与检测通知并存');
});

test('B站登录态：检测连接下发到桥接页（不建 SW 直连），采样完成不关闭桥接页', async (t) => {
  const online = { online: true };
  const { chrome, ws } = await setup(t, {
    rooms: [{ roomId: '200', nickname: 'B站主播', platform: 'bilibili', notify: false, watch: watchConfig({ threshold: 1, keywords: ['抽奖'] }) }],
    fetchHandlers: biliHandlers(online),
    loggedIn: true
  });

  await fireAlarm(chrome);
  assert.equal(ws.bili().length, 0, '登录态检测不走 SW 直连');
  const watchMsg = chrome.__tabCalls.sendMessage.find(c => c.msg.type === 'BILI_WATCH_ROOMS');
  assert.ok(watchMsg, '应向桥接页下发检测房间列表');
  assert.deepEqual([...watchMsg.msg.roomIds], ['200']); // 展开复制：vm 上下文的数组原型与本文件不同
  assert.equal(chrome.__tabCalls.create, 1, '登录态临时打开桥接页');

  // 桥接页回传的弹幕（页面通道）同样进检测链路
  await dispatchMessage(chrome, { type: 'BILI_DANMU', roomId: '200', text: '抽奖口令来了', user: '小明' });
  assert.equal(notesById(chrome, 'bilibili_200_watch').length, 1, '桥接页回传的弹幕应触发检测通知');

  // 观众数采样结束：检测连接常驻期间不得关闭桥接页
  await dispatchMessage(chrome, { type: 'BILI_SAMPLE_DONE' });
  assert.equal(chrome.__tabCalls.remove.length, 0, '盯守期间采样完成不关闭桥接页');

  // 下播：释放桥接页
  online.online = false;
  await fireAlarm(chrome);
  assert.equal(chrome.__tabCalls.remove.length, 1, '下播后关闭桥接页');
});
