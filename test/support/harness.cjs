// test/support/harness.cjs — 三条链路测试共享的进程内 harness（不再拼接源码进 vm）
//
// 组装真实 module：RoomStore + BiliBridgeChannel + createOrchestrator + 四个纯规则 module，
// 只把「外部世界」换成内存实现：存储、平台 API、弹幕客户端、通知、alarm、标签页。
// 默认值与形状从生产 module 导入（RoomStore.DEFAULTS），不再手抄。
'use strict';

const { RoomStore } = require('../../lib/room-store.js');
const { BiliBridgeChannel } = require('../../lib/bili-bridge-channel.js');
const { createOrchestrator } = require('../../lib/orchestrator.js');
const { RoomIdentity } = require('../../lib/room-identity.js');
const { RoomCategories } = require('../../lib/room-categories.js');
const { createNotifications } = require('../../lib/notifications.js');
const viewerAlert = require('../../lib/viewer-alert.js');
const danmakuWatch = require('../../lib/danmaku-watch.js');
const danmakuSurge = require('../../lib/danmaku-surge.js');
const highlightAlert = require('../../lib/highlight-alert.js');
const subscriptionAlert = require('../../lib/subscription-alert.js');

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** 可调时钟（弹幕检测的窗口与冷却、弹幕激增的分钟桶都用它） */
function createClock(t = 0) {
  return {
    t,
    now() { return this.t; },
    advance(ms) { this.t += ms; },
    /** 推进 n 分钟（激增的桶宽） */
    advanceMinutes(n) { this.t += n * 60 * 1000; }
  };
}

/**
 * fake tabs（B站桥接页用）：query / create / remove / reload / sendMessage 五方法。
 * - query({url}) 只返回 live.bilibili.com 下的标签页
 * - responders: tabId → (msg) => response；无 responder 时 sendMessage 抛错（模拟 content script 未注入）
 * - autoRespond=true：新建页面自动注册 responder（模拟 content script 就绪）
 */
function createFakeTabs({ autoRespond = true } = {}) {
  const tabs = [];
  const responders = new Map();
  const calls = { create: 0, remove: [], reload: [], sendMessage: [] };
  let nextId = 1;

  return {
    tabs,
    responders,
    calls,
    addTab(url, { respond } = {}) {
      const tab = { id: nextId++, url };
      tabs.push(tab);
      if (respond) responders.set(tab.id, respond);
      return tab;
    },
    async query({ url }) {
      if (!url.startsWith('https://live.bilibili.com/')) {
        throw new Error(`query 只应查 live.bilibili.com 模式: ${url}`);
      }
      return tabs.filter(t => t.url.startsWith('https://live.bilibili.com/'));
    },
    async create({ url, active }) {
      calls.create += 1;
      const tab = { id: nextId++, url, active };
      tabs.push(tab);
      if (autoRespond) responders.set(tab.id, () => ({ ok: true }));
      return tab;
    },
    async remove(id) {
      calls.remove.push(id);
      const index = tabs.findIndex(t => t.id === id);
      if (index !== -1) {
        tabs.splice(index, 1);
        responders.delete(id);
      }
    },
    async reload(id) {
      calls.reload.push(id);
    },
    async sendMessage(id, msg) {
      calls.sendMessage.push({ id, msg: clone(msg) });
      const responder = responders.get(id);
      if (!responder) throw new Error(`no responder for tab ${id}`);
      return responder(msg);
    }
  };
}

/** 弹幕客户端替身：记录采样/盯守下发/断开 */
function createFakeClient() {
  return {
    sampleCalls: [],
    roomCalls: [],
    destroyCount: 0,
    sample(ids) { this.sampleCalls.push(clone(ids)); },
    setRooms(ids) { this.roomCalls.push(clone(ids)); },
    destroy() { this.destroyCount += 1; }
  };
}

/**
 * 组装一个编排实例。
 * @param {object} [seed] rooms / streamers / settings / 其他键（notifiedRooms、_firstRun、watchQueued、highlightWatermarks…）
 * @param {object} [options] apiResults（平台 → {success,data} 或 (ids)=>结果）、highlightResults（平台 → {success,data:{highlights}} 或 (roomId)=>结果）、
 *                           resolve（平台 → 昵称解析结果）、clock、isLoggedIn
 */
function createHarness(seed = {}, options = {}) {
  const { apiResults = {}, highlightResults = {}, resolve = {}, clock, isLoggedIn = async () => false } = options;
  // 所有键共用一个内存对象：房间库走多键 port，编排走单键 port
  const data = clone(seed);

  const storage = {
    async get(keys) {
      const out = {};
      for (const key of keys) {
        if (key in data) out[key] = clone(data[key]);
      }
      return out;
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) data[key] = clone(value);
    }
  };
  const keyValue = {
    async get(key) { return clone(data[key]); },
    async set(key, value) { data[key] = clone(value); }
  };

  const apiCalls = [];
  const highlightCalls = [];
  const apis = {};
  for (const platform of ['douyu', 'bilibili']) {
    apis[platform] = {
      async batchFetchRoomInfo(ids) {
        apiCalls.push({ platform, ids: clone(ids) });
        const result = apiResults[platform];
        if (result === undefined) return { success: true, data: [] };
        return clone(typeof result === 'function' ? result(ids) : result);
      },
      // 看点取数（生产里只有斗鱼有这个方法，平台门由编排把关：没通过就不该有调用）
      async fetchHighlights(roomId) {
        highlightCalls.push({ platform, roomId });
        const result = highlightResults[platform];
        if (result === undefined) return { success: true, data: { highlights: [] } };
        return clone(typeof result === 'function' ? result(roomId) : result);
      },
      async resolveNickname(roomId) {
        const result = resolve[platform];
        if (result === undefined) return { success: false };
        return clone(typeof result === 'function' ? result(roomId) : result);
      }
    };
  }

  const store = new RoomStore({
    storage,
    identity: RoomIdentity,
    categoryRules: RoomCategories,
    // 订阅的「只接受未来时刻」校验与编排的到点裁决共用同一个时刻源：给了 clock 就用它（可控时钟）
    now: clock ? () => clock.now() : undefined,
    resolveNickname: async (platform, roomId) => {
      const result = await apis[platform].resolveNickname(roomId);
      return result && result.success ? { ok: true, nickname: result.nickname } : { ok: false };
    }
  });

  const tabApi = createFakeTabs();
  const bridge = new BiliBridgeChannel({
    storage: keyValue,
    tabs: tabApi,
    isLoggedIn,
    waitReadyAttempts: 3,
    waitReadyInterval: 5
  });

  const clients = {
    douyuSample: createFakeClient(),
    douyuWatch: createFakeClient(),
    bilibiliSample: createFakeClient(),
    bilibiliWatch: createFakeClient()
  };
  const notifications = [];
  const badge = [];
  const notifier = {
    async create(notificationId, content) {
      notifications.push({ id: notificationId, content: clone(content) });
      return true;
    },
    setBadge(count) { badge.push(count); }
  };
  const alarms = [];                 // create 日志（断言用）
  const alarmMap = new Map();        // 现存 alarm 的活状态：alarms.get 查它，与真实 chrome.alarms 同语义
  const clearedAlarms = [];
  const openedTabs = [];

  // 弹幕检测计数与激增计量都用假时钟（编排内部无参构造两个规则对象，测试用子类注入时钟）
  const Counter = clock
    ? class extends danmakuWatch.DanmakuWatchCounter {
      constructor() { super({ now: () => clock.now() }); }
    }
    : danmakuWatch.DanmakuWatchCounter;
  const Surge = clock
    ? class extends danmakuSurge.SurgeMeter {
      constructor() { super({ now: () => clock.now() }); }
    }
    : danmakuSurge.SurgeMeter;

  // 每次调用都造一份全新的编排（内存态归零），但存储与 alarm 注册表是外部世界的、跨实例保留：
  // restart() 据此模拟 MV3 的 SW 回收重启——alarms.get 查到的仍是重启前那份真值。
  function buildOrchestrator() {
    return createOrchestrator({
      store,
      keyValue,
      apis,
      clients,
      bridge,
      notifier,
      rules: { ...viewerAlert, ...danmakuWatch, ...danmakuSurge, ...highlightAlert, ...subscriptionAlert, DanmakuWatchCounter: Counter, SurgeMeter: Surge },
      identity: RoomIdentity,
      notifications: createNotifications({ identity: RoomIdentity }),
      now: clock ? () => clock.now() : undefined,
      alarms: {
        create: (name, info) => {
          alarms.push({ name, info: clone(info) });
          // 活状态按真实 chrome.alarms.Alarm 的形状存：periodInMinutes 在顶层（get 的消费方读它）
          alarmMap.set(name, { name, ...clone(info) });
        },
        clear: name => {
          clearedAlarms.push(name);
          alarmMap.delete(name);
        },
        get: async name => alarmMap.get(name)
      },
      tabs: { create: props => openedTabs.push(clone(props)) }
    });
  }

  const harness = {
    orchestrator: buildOrchestrator(),
    store,
    bridge,
    clients,
    notifier,
    tabApi,
    data,
    storage,
    keyValue,
    notifications,
    badge,
    alarms,
    clearedAlarms,
    openedTabs,
    apiCalls,
    highlightCalls,
    /**
     * 模拟 SW 被回收后重启：换一个全新的编排实例（内存态归零、alarms.get 的假查仍指向同一份真值），
     * 存储、客户端、通知与 alarm 注册表都原样保留。用来钉住「重启不会重置已在跑的周期 alarm」。
     */
    restart() { harness.orchestrator = buildOrchestrator(); },
    /** 让某平台的下一轮轮询返回这些数据 */
    setApiResult(platform, result) { apiResults[platform] = result; },
    /** 让某平台的下一轮看点取数返回这些数据 */
    setHighlightResult(platform, result) { highlightResults[platform] = result; }
  };
  return harness;
}

/** 轮询一次（走编排的 alarm 入口，与生产同一条路） */
async function poll(harness) {
  await harness.orchestrator.onAlarm('refreshRooms');
}

/** 采样一次（走编排的 alarm 入口） */
async function sample(harness) {
  await harness.orchestrator.onAlarm('sampleViewerCounts');
}

/** 弹幕激增结算一次（走编排的 alarm 入口，与 poll / sample 同形） */
async function settleSurge(harness) {
  await harness.orchestrator.onAlarm('danmakuSurgeTick');
}

/** 看点取数一次（走编排的 alarm 入口，与 poll / sample / settleSurge 同形） */
async function pollHighlights(harness) {
  await harness.orchestrator.onAlarm('highlightPoll');
}

/** 订阅到点一次（走编排的 alarm 入口，与 poll / sample / settleSurge / pollHighlights 同形） */
async function remindSubscriptions(harness) {
  await harness.orchestrator.onAlarm('subscriptionReminder');
}

/** SW 唤醒：重建内存态（通道状态 + 盯守配置），生产里由入口在加载时调用 */
async function boot(harness) {
  await harness.orchestrator.start();
}

/** 斗鱼在线主播的房间信息（房间库吃平台 API 的原始返回） */
const douyuResult = data => ({ success: true, data });
const bilibiliResult = data => ({ success: true, data });

module.exports = {
  createHarness,
  createClock,
  createFakeTabs,
  poll,
  sample,
  settleSurge,
  pollHighlights,
  remindSubscriptions,
  boot,
  douyuResult,
  bilibiliResult,
  clone
};
