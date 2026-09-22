// test/service-worker-entry.test.cjs — Service Worker 入口（background.js）装配与事件接线
//
// 运行：npm test（node --test）
// 编排与房间库各自有进程内测试；这里只验证入口这一层：importScripts 的模块都可用、
// 依赖装配无误、chrome 事件把名字/消息交给了编排，且 onInstalled 能建 alarm 与写默认值。
// 用假 chrome 在一个沙箱里加载入口（唯一的拼接点，只此一处，不再是三条链路的脚手架）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
// 与 background.js 的 importScripts 顺序一致（入口只依赖这些全局）
const LIB_FILES = [
  'room-identity',
  'storage',
  'danmaku-watch',
  'viewer-alert',
  'danmaku-surge',
  'highlight-alert',
  'douyu-api',
  'bilibili-api',
  'douyu-barrage',
  'bilibili-barrage',
  'bili-bridge-channel',
  'room-store',
  'orchestrator'
];

function createChromeStub() {
  const data = {};
  const alarms = [];
  const notifications = [];
  const openedTabs = [];
  const listeners = { installed: [], alarm: [], message: [], notifClick: [], notifButton: [] };
  const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const key of [].concat(keys)) {
            if (key in data) out[key] = clone(data[key]);
          }
          return out;
        },
        async set(entries) {
          for (const [key, value] of Object.entries(entries)) data[key] = clone(value);
        }
      }
    },
    runtime: {
      onInstalled: { addListener: fn => listeners.installed.push(fn) },
      onMessage: { addListener: fn => listeners.message.push(fn) }
    },
    alarms: {
      create: (name, info) => alarms.push({ name, info: clone(info) }),
      clear: () => { },
      onAlarm: { addListener: fn => listeners.alarm.push(fn) }
    },
    notifications: {
      create: async (id, content) => { notifications.push({ id, content: clone(content) }); },
      onClicked: { addListener: fn => listeners.notifClick.push(fn) },
      onButtonClicked: { addListener: fn => listeners.notifButton.push(fn) }
    },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    tabs: {
      create: props => { openedTabs.push(clone(props)); return { id: 1 }; },
      query: async () => [],
      remove: async () => {},
      reload: async () => {},
      sendMessage: async () => ({ ok: true })
    },
    cookies: { get: async () => null }
  };

  return { chrome, data, alarms, notifications, openedTabs, listeners };
}

/** 在沙箱里加载入口（剥掉 importScripts，前置 lib 源码） */
function loadEntry(chrome) {
  const libs = LIB_FILES
    .map(name => fs.readFileSync(path.join(ROOT, 'lib', `${name}.js`), 'utf8'))
    .join('\n;\n');
  const entry = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')
    .replace(/^importScripts\([\s\S]*?\);\s*$/m, '');
  const sandbox = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ ok: false }),
    AbortController,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    navigator: { userAgent: 'node-test' },
    WebSocket: class { constructor() {} close() {} send() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${libs}\n;\n${entry}`, sandbox, { filename: 'service-worker-entry.js' });
  return sandbox;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('入口装配：加载即注册五类监听、构建依赖并启动重建（不触网）', async () => {
  const stub = createChromeStub();
  loadEntry(stub.chrome);
  await tick();

  assert.equal(stub.listeners.installed.length, 1);
  assert.equal(stub.listeners.alarm.length, 1);
  assert.equal(stub.listeners.message.length, 1);
  assert.equal(stub.listeners.notifClick.length, 1);
  assert.equal(stub.listeners.notifButton.length, 1);
});

test('onInstalled：房间库写入默认值、置首启标记、建两个 alarm', async () => {
  const stub = createChromeStub();
  loadEntry(stub.chrome);

  await stub.listeners.installed[0]();
  await tick(); // 入口的监听器不 await 编排（Chrome 也不用），等它跑完
  assert.deepEqual(stub.data.rooms, []);
  assert.deepEqual(stub.data.streamers, []);
  assert.equal(stub.data.settings.refreshInterval, 60);
  assert.equal(stub.data._firstRun, true);
  assert.deepEqual(stub.alarms.map(a => a.name).sort(), ['refreshRooms', 'sampleViewerCounts']);
  assert.equal(stub.alarms.find(a => a.name === 'refreshRooms').info.periodInMinutes, 1);
});

test('消息接线：编排应答，未知消息回 ok:false；设置变更按间隔重建 alarm', async () => {
  const stub = createChromeStub();
  loadEntry(stub.chrome);
  const send = message => new Promise(resolve => stub.listeners.message[0](message, {}, resolve));

  assert.equal((await send({ type: 'UNKNOWN' })).ok, false);
  assert.equal((await send({ type: 'MANUAL_REFRESH' })).ok, true);

  stub.alarms.length = 0;
  assert.equal((await send({ type: 'PATCH_SETTINGS', patch: { refreshInterval: 120 } })).ok, true);
  assert.equal(stub.data.settings.refreshInterval, 120, '设置经房间库落盘');
  assert.equal(stub.alarms.find(a => a.name === 'refreshRooms').info.periodInMinutes, 2);
});

test('alarm 接线：名字映射到轮询 / 采样 / 激增结算，失败不抛出', async () => {
  const stub = createChromeStub();
  loadEntry(stub.chrome);
  const fire = name => Promise.all(stub.listeners.alarm.map(fn => fn({ name })));
  await fire('refreshRooms');
  await fire('sampleViewerCounts');
  await fire('danmakuSurgeTick');
  await tick();
});

test('通知点击接线：开播通知与派生 ID 都进直播间', async () => {
  const stub = createChromeStub();
  loadEntry(stub.chrome);

  stub.listeners.notifClick[0]('douyu_100_viewer');
  await tick();
  assert.deepEqual(stub.openedTabs, [{ url: 'https://www.douyu.com/100' }]);

  stub.listeners.notifButton[0]('bilibili_200', 0);
  await tick();
  assert.deepEqual(stub.openedTabs[1], { url: 'https://live.bilibili.com/200' });

  stub.listeners.notifButton[0]('bilibili_200', 1); // 非「进入直播间」按钮不处理
  await tick();
  assert.equal(stub.openedTabs.length, 2);
});
