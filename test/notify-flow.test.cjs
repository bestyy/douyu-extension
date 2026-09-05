// test/notify-flow.test.cjs — 开播通知链路（background.js refreshRooms → checkNewLiveStreams）行为测试
//
// 运行：npm test（node --test test/）
// fake 设施：内存 chrome（storage/alarms/notifications/action/cookies/tabs）+ 可编程 fetch 路由。
// lib/* 与 background.js 通过 vm context 拼接加载（剥离 importScripts，每用例独立 context）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// === chrome stub ===

function createChromeStub() {
  const store = {};
  const created = [];
  const alarmListeners = [];
  const createdAlarms = [];

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === null) return { ...store };
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
      async get() { return null; }
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
      onMessage: { addListener() {} }
    },
    __store: store,
    __created: created,
    __alarmListeners: alarmListeners,
    __createdAlarms: createdAlarms
  };
  return chrome;
}

// === 可编程 fetch 路由 ===
// handlers: [{ match: (url) => bool, respond: (url) => ({ ok, text, json }) }]
function createFetchStub(handlers) {
  return async function fetch(url) {
    for (const h of handlers) {
      if (h.match(String(url))) return h.respond(String(url));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

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

function biliInfoPayload({ online, roomId, nickname = 'B站主播' }) {
  // 注意：调用方走 resp.json()，这里必须返回对象而非 JSON 字符串
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

const BILI_CARD_OK = {
  match: u => u.includes('web-interface/card'),
  respond: () => ({ ok: true, text: async () => '', json: async () => ({ code: 0, data: { card: { name: 'B站主播', face: '' } } }) })
};

// === 加载 background.js（剥离 importScripts，拼接 lib 源码）===
// 每个用例独立 vm context，避免全局词法作用域里 const 声明跨用例冲突

function loadBackground(chrome, fetchStub) {
  const libs = [
    'lib/storage.js',
    'lib/douyu-api.js',
    'lib/bilibili-api.js',
    'lib/douyu-barrage.js',
    'lib/bilibili-barrage.js',
    'lib/bili-bridge-channel.js'
  ];
  let src = libs
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n;\n');
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
    URLSearchParams
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background-harness.js' });
  return sandbox;
}

// 触发一次 refreshRooms（走真实的 onAlarm 监听器，验证接线）
async function fireAlarm(chrome, name = 'refreshRooms') {
  assert.ok(chrome.__alarmListeners.length > 0, 'onAlarm 监听器应已注册');
  for (const cb of chrome.__alarmListeners) {
    await cb({ name, scheduledTime: Date.now() });
  }
}

const DEFAULT_SETTINGS = {
  refreshInterval: 60,
  notificationsEnabled: true,
  openInCurrentTab: false
};

async function seedStorage(chrome, data) {
  await chrome.storage.local.set(data);
}

// === 用例 ===

test('斗鱼房间下播→开播：应创建一条开播通知', async () => {
  const chrome = createChromeStub();
  const biliOnline = { online: false };
  const sandbox = loadBackground(chrome, createFetchStub([
    {
      match: u => u.includes('www.douyu.com/betard/100'),
      respond: () => ({ ok: true, text: async () => douyuRoomPayload({ online: false, roomId: '100' }) })
    },
    { match: () => true, respond: () => ({ ok: true, text: async () => '', json: async () => ({ code: -1 }) }) }
  ]));
  await seedStorage(chrome, {
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: true }],
    streamers: [],
    notifiedRooms: []
  });

  // 第一轮：主播未开播 → 无通知
  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 0, '未开播不应通知');

  // 主播开播，第二轮轮询 → 应通知
  sandbox.fetch = createFetchStub([
    {
      match: u => u.includes('www.douyu.com/betard/100'),
      respond: () => ({ ok: true, text: async () => douyuRoomPayload({ online: true, roomId: '100' }) })
    },
    { match: () => true, respond: () => ({ ok: true, text: async () => '', json: async () => ({ code: -1 }) }) }
  ]);
  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 1, '开播应通知一次');
  assert.match(chrome.__created[0].opts.title, /开播了/);
  assert.equal(chrome.__created[0].id, 'douyu_100');

  // 同一场直播继续轮询 → 不重复通知
  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 1, '同场直播不应重复通知');
});

test('B站房间下播→开播：应创建一条开播通知', async () => {
  const chrome = createChromeStub();
  const sandbox = loadBackground(chrome, createFetchStub([
    {
      match: u => u.includes('room/v1/Room/get_info'),
      respond: () => ({ ok: true, text: async () => '', json: async () => biliInfoPayload({ online: false, roomId: '200' }) })
    },
    BILI_CARD_OK
  ]));
  await seedStorage(chrome, {
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '200', nickname: 'B站主播', platform: 'bilibili', notify: true }],
    streamers: [],
    notifiedRooms: []
  });

  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 0, '未开播不应通知');

  sandbox.fetch = createFetchStub([
    {
      match: u => u.includes('room/v1/Room/get_info'),
      respond: () => ({ ok: true, text: async () => '', json: async () => biliInfoPayload({ online: true, roomId: '200' }) })
    },
    BILI_CARD_OK
  ]);
  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 1, '开播应通知一次');
  assert.match(chrome.__created[0].opts.title, /\[B站\]/);
});

test('房间 notify 标记为 false：开播也不通知（当前设计行为）', async () => {
  const chrome = createChromeStub();
  loadBackground(chrome, createFetchStub([
    {
      match: u => u.includes('www.douyu.com/betard/100'),
      respond: () => ({ ok: true, text: async () => douyuRoomPayload({ online: true, roomId: '100' }) })
    }
  ]));
  await seedStorage(chrome, {
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: false }],
    streamers: [],
    notifiedRooms: []
  });

  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 0, 'notify=false 不应通知');
});

test('房间缺失 notify 字段（旧版本数据）：开播不通知（静默）', async () => {
  const chrome = createChromeStub();
  loadBackground(chrome, createFetchStub([
    {
      match: u => u.includes('www.douyu.com/betard/100'),
      respond: () => ({ ok: true, text: async () => douyuRoomPayload({ online: true, roomId: '100' }) })
    }
  ]));
  await seedStorage(chrome, {
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu' }], // 无 notify 字段
    streamers: [],
    notifiedRooms: []
  });

  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 0, '缺 notify 字段时当前实现不通知');
});

test('API 全部失败：保留旧状态，开播也永远不通知（静默失效）', async () => {
  const chrome = createChromeStub();
  const sandbox = loadBackground(chrome, createFetchStub([
    {
      match: u => u.includes('www.douyu.com/betard/100'),
      respond: () => ({ ok: true, text: async () => douyuRoomPayload({ online: false, roomId: '100' }) })
    }
  ]));
  await seedStorage(chrome, {
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: true }],
    streamers: [],
    notifiedRooms: []
  });
  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 0);

  // 之后 API 被风控/改版，返回 HTML（现实中斗鱼 /betard 反爬的典型表现）
  sandbox.fetch = createFetchStub([
    {
      match: u => u.includes('www.douyu.com/betard/100'),
      respond: () => ({ ok: true, text: async () => '<html>请开启 JavaScript</html>' })
    }
  ]);
  await fireAlarm(chrome);
  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 0, 'API 失败期间不应通知');
  const streamers = chrome.__store.streamers;
  assert.equal(streamers[0].online, false, 'API 失败应保留旧的离线状态（主播实际已开播也感知不到）');
});

test('notificationsEnabled 关闭：开播不通知', async () => {
  const chrome = createChromeStub();
  loadBackground(chrome, createFetchStub([
    {
      match: u => u.includes('www.douyu.com/betard/100'),
      respond: () => ({ ok: true, text: async () => douyuRoomPayload({ online: true, roomId: '100' }) })
    }
  ]));
  await seedStorage(chrome, {
    settings: { ...DEFAULT_SETTINGS, notificationsEnabled: false },
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: true }],
    streamers: [],
    notifiedRooms: []
  });

  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 0, '总开关关闭不应通知');
});

test('首次运行：已在线房间只记录不通知', async () => {
  const chrome = createChromeStub();
  loadBackground(chrome, createFetchStub([
    {
      match: u => u.includes('www.douyu.com/betard/100'),
      respond: () => ({ ok: true, text: async () => douyuRoomPayload({ online: true, roomId: '100' }) })
    }
  ]));
  await seedStorage(chrome, {
    settings: { ...DEFAULT_SETTINGS },
    rooms: [{ roomId: '100', nickname: '测试主播', platform: 'douyu', notify: true }],
    streamers: [],
    notifiedRooms: [],
    _firstRun: true
  });

  await fireAlarm(chrome);
  assert.equal(chrome.__created.length, 0, '首次运行不通知');
  assert.equal(chrome.__store._firstRun, null, '首跑标记应清除');
  assert.ok(chrome.__store.notifiedRooms.some(n => n.roomId === '100'), '在线房间应记入 notifiedRooms');
});
