// test/viewer-alert-flow.test.cjs — 观众数提醒链路（采样值到达 → 上升边沿判定 → 通知）行为测试
//
// 运行：npm test（node --test test/）
// fake 设施：内存 chrome（storage/alarms/notifications/action/cookies/tabs + 消息监听捕获）
//           + 可编程 fetch 路由 + fake WebSocket（斗鱼 oni 帧由测试显式驱动）。
// lib/* 与 background.js 通过 vm context 拼接加载（剥离 importScripts，每用例独立 context）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// === fake WebSocket（斗鱼采样短连：测试显式驱动 open/message）===
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
    douyu: () => sockets.filter(s => s.url.startsWith('wss://danmuproxy')),
    lastDouyu: () => sockets.filter(s => s.url.startsWith('wss://danmuproxy')).pop()
  };
}

// === chrome stub ===
function createChromeStub() {
  const store = {};
  const created = [];
  const alarmListeners = [];
  const messageListeners = [];
  const createdAlarms = [];

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
      async get() { return null; },
      async set() {}
    },
    tabs: {
      async query() { return []; },
      async create() { return { id: 1 }; },
      async remove() {},
      async reload() {},
      async sendMessage() { throw new Error('no responder'); }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(cb) { messageListeners.push(cb); } }
    },
    __store: store,
    __created: created,
    __alarmListeners: alarmListeners,
    __messageListeners: messageListeners,
    __createdAlarms: createdAlarms
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

// 斗鱼轮询（betard）；B站轮询（get_info）+ 弹幕连接所需路由
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

function biliHandlers(onlineState) {
  return [
    {
      match: u => u.includes('room/v1/Room/get_info'),
      respond: () => ({ ok: true, json: async () => biliInfoPayload({ online: onlineState.online }) })
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
function loadBackground(chrome, fetchStub, wsStub) {
  const libs = [
    'lib/storage.js',
    'lib/danmaku-watch.js',
    'lib/viewer-alert.js',
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
    navigator: { userAgent: 'node-test' },
    WebSocket: wsStub.FakeWebSocket
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background-harness.js' });
  return sandbox;
}

const DEFAULT_SETTINGS = {
  refreshInterval: 60,
  notificationsEnabled: true,
  viewerAlertEnabled: true,
  openInCurrentTab: false,
  fetchDouyuViewerCount: true,
  fetchBilibiliViewerCount: true
};

function flush(rounds = 5) {
  return new Promise(resolve => {
    let n = 0;
    const step = () => {
      if (++n >= rounds) return resolve();
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

async function fireAlarm(chrome, name = 'refreshRooms') {
  assert.ok(chrome.__alarmListeners.length > 0, 'onAlarm 监听器应已注册');
  for (const cb of chrome.__alarmListeners) {
    await cb({ name, scheduledTime: Date.now() });
  }
  await flush();
}

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

function viewerNotes(chrome) {
  return chrome.__created.filter(n => n.id.endsWith('_viewer'));
}

async function setup(t, { rooms, streamers = [], onlineState, fetchHandlers, settings }) {
  const chrome = createChromeStub();
  const wsStub = createWebSocketStub();
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
    rooms,
    streamers,
    notifiedRooms: []
  });
  const sandbox = loadBackground(chrome, createFetchStub(fetchHandlers || douyuHandlers(onlineState || { online: true })), wsStub);
  t.after(() => {
    vm.runInContext(
      'douyuWatchClient.destroy(); bilibiliWatchClient.destroy(); barrageClient.destroy(); bilibiliBarrageClient.destroy();',
      sandbox
    );
  });
  return { chrome, sandbox, ws: wsStub };
}

function alertConfig(overrides = {}) {
  return { enabled: true, threshold: 1000, ...overrides };
}

/** 驱动一轮斗鱼观众数采样：轮询保证 streamers 有条目 → 采样短连上报 oni 值 */
async function sampleDouyu(chrome, ws, vipCount, roomId = '100') {
  await fireAlarm(chrome, 'sampleViewerCounts');
  const sock = ws.lastDouyu();
  assert.ok(sock, '应建立斗鱼采样短连');
  sock.serverOpen();
  await sock.serverMessage(`type@=oni/rid@=${roomId}/vn@=${vipCount}/`);
  await flush();
}

// === 用例 ===

test('斗鱼：贵宾数越过阈值发提醒；持续高位不复报；回落后再越过再报', async (t) => {
  const { chrome, ws } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false, viewerAlert: alertConfig() }],
    fetchHandlers: douyuHandlers({ online: true })
  });

  await fireAlarm(chrome); // 轮询建 streamers 条目（贵宾数尚未采到）

  // 第一轮采样：低于阈值 → 不提醒（同时完成重新武装的起点）
  await sampleDouyu(chrome, ws, 500);
  assert.equal(viewerNotes(chrome).length, 0, '未越过阈值不应提醒');

  // 第二轮：越过阈值 → 一条提醒
  await sampleDouyu(chrome, ws, 5000);
  const notes = viewerNotes(chrome);
  assert.equal(notes.length, 1, '越过阈值应发一条观众数提醒');
  assert.equal(notes[0].id, 'douyu_100_viewer', '提醒用派生 ID（不覆盖开播通知与检测通知）');
  assert.match(notes[0].opts.title, /测试主播/);
  assert.match(notes[0].opts.title, /贵宾数超过 1000/);
  assert.match(notes[0].opts.contextMessage, /当前 5000 贵宾/);

  // 第三轮：仍高于阈值（无上升边沿）→ 不复报
  await sampleDouyu(chrome, ws, 6000);
  assert.equal(viewerNotes(chrome).length, 1, '持续高位不重复提醒');

  // 第四轮：回落到阈值以下 → 重新武装（回落本身不提醒）
  await sampleDouyu(chrome, ws, 300);
  assert.equal(viewerNotes(chrome).length, 1, '回落不提醒');

  // 第五轮：再次越过 → 再提醒（同一通知 ID 覆盖而非堆积）
  await sampleDouyu(chrome, ws, 2000);
  const after = viewerNotes(chrome);
  assert.equal(after.length, 2, '回落后再次越过应再提醒一次');
  assert.ok(after.every(n => n.id === 'douyu_100_viewer'), '同一房间重复触发复用同一通知 ID');
});

test('未配置 / 未启用观众数提醒的房间不提醒（配置保留）', async (t) => {
  const { chrome, ws } = await setup(t, {
    rooms: [
      { roomId: '100', nickname: 'A', platform: 'douyu', notify: false },
      { roomId: '101', nickname: 'B', platform: 'douyu', notify: false, viewerAlert: { enabled: false, threshold: 1000 } }
    ],
    fetchHandlers: douyuHandlers({ online: true })
  });

  await fireAlarm(chrome);
  await sampleDouyu(chrome, ws, 99999, '100');
  await sampleDouyu(chrome, ws, 99999, '101');
  assert.equal(viewerNotes(chrome).length, 0, '未配置或未启用的房间不提醒');
});

test('总开关关闭：不提醒但配置保留；重新打开后按边沿恢复判定', async (t) => {
  const { chrome, ws } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false, viewerAlert: alertConfig() }],
    settings: { viewerAlertEnabled: false },
    fetchHandlers: douyuHandlers({ online: true })
  });

  await fireAlarm(chrome);
  await sampleDouyu(chrome, ws, 5000); // 数值照常采集入库
  assert.equal(viewerNotes(chrome).length, 0, '总开关关闭：越过阈值也不提醒');
  const { streamers } = await chrome.storage.local.get('streamers');
  assert.equal(streamers[0].vipCount, 5000, '数值照常采集（只是不判定）');

  // 设置页打开总开关（写设置 + 发 SETTINGS_UPDATED 即时生效）
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, viewerAlertEnabled: true } });
  await dispatchMessage(chrome, { type: 'SETTINGS_UPDATED' });

  await sampleDouyu(chrome, ws, 400);  // 回落到阈值以下，重新武装
  await sampleDouyu(chrome, ws, 3000); // 再次越过
  assert.equal(viewerNotes(chrome).length, 1, '重新打开后配置仍在、按边沿恢复判定');
});

test('联动：关闭该平台观众数开关后拿不到数值也不判定；重新打开即恢复', async (t) => {
  const { chrome, ws, sandbox } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false, viewerAlert: alertConfig() }],
    streamers: [{ roomId: '100', platform: 'douyu', nickname: '测试主播', online: true, title: 'T' }],
    settings: { fetchDouyuViewerCount: false },
    fetchHandlers: douyuHandlers({ online: true })
  });

  await fireAlarm(chrome, 'sampleViewerCounts');
  assert.equal(ws.douyu().length, 0, '开关关闭：不建立采样连接');

  // 即使有数值到达（例如关开关前已建立的连接），判定入口也短路
  await vm.runInContext('updateVipCount({ roomId: "100", vipCount: 5000 })', sandbox);
  await flush();
  let { streamers } = await chrome.storage.local.get('streamers');
  // 注：开关关闭时 SW 启动的 syncViewerSettings 也会清掉存量旧值（pruneStaleViewerCounts），
  // 这里断言的是 updateVipCount 本身不写入、更不判定
  assert.equal(streamers[0].vipCount, undefined, '开关关闭：数值不写入 storage（更不判定）');
  assert.equal(viewerNotes(chrome).length, 0);

  // 重新打开开关 → 采样恢复，越过阈值正常提醒（无存量，视为 0 → 有上升边沿）
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, fetchDouyuViewerCount: true } });
  await dispatchMessage(chrome, { type: 'SETTINGS_UPDATED' });
  await sampleDouyu(chrome, ws, 5000);
  ({ streamers } = await chrome.storage.local.get('streamers'));
  assert.equal(streamers[0].vipCount, 5000, '重新打开后恢复采样');
  assert.equal(viewerNotes(chrome).length, 1, '重新打开后恢复判定');
});

test('B站：高能榜越过阈值发提醒（页面通道回传的数值同样判定）', async (t) => {
  const { chrome } = await setup(t, {
    rooms: [{ roomId: '200', nickname: 'B站主播', platform: 'bilibili', notify: false, viewerAlert: alertConfig({ threshold: 500 }) }],
    streamers: [{ roomId: '200', platform: 'bilibili', nickname: 'B站主播', online: true, title: 'B站标题' }],
    fetchHandlers: biliHandlers({ online: true })
  });

  await dispatchMessage(chrome, { type: 'BILI_RANK_COUNT', roomId: '200', rankCount: 300 });
  assert.equal(viewerNotes(chrome).length, 0, '未越过阈值不提醒');

  await dispatchMessage(chrome, { type: 'BILI_RANK_COUNT', roomId: '200', rankCount: 800 });
  const notes = viewerNotes(chrome);
  assert.equal(notes.length, 1, '越过阈值应发提醒');
  assert.equal(notes[0].id, 'bilibili_200_viewer');
  assert.match(notes[0].opts.title, /高能榜在线数超过 500/);
  assert.match(notes[0].opts.contextMessage, /当前 800 高能榜/);

  // 数值未变化的重复推送（长连接每 4-6 秒推送一次）不判定
  await dispatchMessage(chrome, { type: 'BILI_RANK_COUNT', roomId: '200', rankCount: 800 });
  assert.equal(viewerNotes(chrome).length, 1, '数值未变化不重复提醒');
});

test('下播两轮确认后清空观众数存量：B站第二场重新越过阈值能再提醒', async (t) => {
  const online = { online: true };
  const { chrome } = await setup(t, {
    rooms: [{ roomId: '200', nickname: 'B站主播', platform: 'bilibili', notify: false, viewerAlert: alertConfig({ threshold: 500 }) }],
    // 上一场留下 5000（已 ≥ 阈值）：不清空则下一场没有上升边沿，永远不再提醒
    streamers: [{ roomId: '200', platform: 'bilibili', nickname: 'B站主播', online: true, title: 'T', rankCount: 5000 }],
    fetchHandlers: biliHandlers(online)
  });

  // 第一轮离线：仅记录，不清空（防 API 抖动误清）
  online.online = false;
  await fireAlarm(chrome);
  let { streamers } = await chrome.storage.local.get('streamers');
  assert.equal(streamers[0].rankCount, 5000, '第一轮离线只记录状态，不清空');

  // 第二轮离线：确认下播 → 清空存量（同时重新武装）
  await fireAlarm(chrome);
  ({ streamers } = await chrome.storage.local.get('streamers'));
  assert.ok(!('rankCount' in streamers[0]), '第二轮离线清空观众数存量');
  assert.equal(viewerNotes(chrome).length, 0, '清空本身不提醒');

  // 第二场开播：新高的数值越过阈值 → 提醒
  online.online = true;
  await fireAlarm(chrome);
  await dispatchMessage(chrome, { type: 'BILI_RANK_COUNT', roomId: '200', rankCount: 900 });
  assert.equal(viewerNotes(chrome).length, 1, '重新武装后第二场能再提醒');
});

test('单次 API 抖动（一轮误报离线）不清空存量，避免同场重复提醒', async (t) => {
  const online = { online: true };
  const { chrome } = await setup(t, {
    rooms: [{ roomId: '200', nickname: 'B站主播', platform: 'bilibili', notify: false, viewerAlert: alertConfig({ threshold: 500 }) }],
    streamers: [{ roomId: '200', platform: 'bilibili', nickname: 'B站主播', online: true, title: 'T', rankCount: 5000 }],
    fetchHandlers: biliHandlers(online)
  });

  online.online = false;
  await fireAlarm(chrome);
  online.online = true;
  await fireAlarm(chrome);

  const { streamers } = await chrome.storage.local.get('streamers');
  assert.equal(streamers[0].rankCount, 5000, '抖动一轮不清空存量');

  await dispatchMessage(chrome, { type: 'BILI_RANK_COUNT', roomId: '200', rankCount: 5000 });
  await dispatchMessage(chrome, { type: 'BILI_RANK_COUNT', roomId: '200', rankCount: 7000 });
  assert.equal(viewerNotes(chrome).length, 0, '存量保留 → 没有上升边沿 → 同场不重复提醒');
});

test('新加入的房间无历史值：首次采到 ≥ 阈值即提醒', async (t) => {
  const { chrome, ws } = await setup(t, {
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false, viewerAlert: alertConfig() }],
    fetchHandlers: douyuHandlers({ online: true })
  });

  await fireAlarm(chrome);
  await sampleDouyu(chrome, ws, 5000); // 无历史值（视为 0）→ 首次越过
  assert.equal(viewerNotes(chrome).length, 1, '新房间首次越过阈值即提醒');
});

test('观众数提醒 ID 后缀解析与阈值钳制（设置页写入的值与判定侧同一套规则）', async (t) => {
  const { sandbox } = await setup(t, {
    rooms: [],
    fetchHandlers: douyuHandlers({ online: false })
  });

  const url = id => vm.runInContext(`getLiveUrlFromNotificationId(${JSON.stringify(id)})`, sandbox);
  assert.equal(url('douyu_100_viewer'), 'https://www.douyu.com/100', '观众数提醒派生 ID');
  assert.equal(url('bilibili_200_viewer'), 'https://live.bilibili.com/200');
  assert.equal(url('douyu_100_watch'), 'https://www.douyu.com/100', '检测通知后缀不受影响');

  const threshold = v => vm.runInContext(`viewerAlertThreshold({ threshold: ${JSON.stringify(v)} })`, sandbox);
  assert.equal(threshold('5000'), 5000, '字符串数值解析');
  assert.equal(threshold(''), 1000, '空值取缺省');
  assert.equal(threshold('abc'), 1000, '非法值取缺省');
  assert.equal(threshold(0), 1, '小于下界钳制到 1');
  assert.equal(threshold(99999999), 999999, '超过上界钳制到 999999');
});
