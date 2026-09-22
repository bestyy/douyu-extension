// test/room-store.test.cjs — 房间库（lib/room-store.js）行为测试
//
// 运行：npm test（node --test）
// 覆盖：只读快照与默认值、观众数采样计划、轮询合并（取新/留旧/透传/两轮离线清空/开播边沿）、
// 值到达（门控、未变不写、前后值）、平台门控对齐与清字段、设置与单房配置变更、房间增删与重排、
// 初始化迁移，以及串行队列对「读改写交错」的消除（丢更新是本 module 存在的理由）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RoomStore, ROOM_STORE_DEFAULTS } = require('../lib/room-store.js');
const { RoomIdentity } = require('../lib/room-identity.js');

// === 测试替身：内存存储 port（get/set 深拷贝，可选每次操作让出一个宏任务以放大交错）===

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createMemoryStorage(initial = {}, { asyncTick = false } = {}) {
  let data = clone(initial);
  const writes = [];
  const tick = asyncTick ? () => new Promise(resolve => setTimeout(resolve, 0)) : () => Promise.resolve();
  return {
    async get(keys) {
      await tick();
      const out = {};
      for (const key of keys) {
        if (key in data) out[key] = clone(data[key]);
      }
      return out;
    },
    async set(entries) {
      await tick();
      writes.push(Object.keys(entries));
      for (const [key, value] of Object.entries(entries)) data[key] = clone(value);
    },
    raw: () => clone(data),
    writes
  };
}

function createStore(initial = {}, options = {}) {
  const storage = createMemoryStorage(initial, options);
  const resolveNickname = options.resolveNickname || (async () => ({ ok: false }));
  return { store: new RoomStore({ storage, resolveNickname, identity: RoomIdentity }), storage };
}

const room = (platform, roomId, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
const streamer = (platform, roomId, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, online: false, ...extra });

// === 只读快照 ===

test('snapshot：缺键补默认值，平台观众数开关解算为布尔，旧总开关不出现在快照里', async () => {
  const { store } = createStore({});
  const snap = await store.snapshot();
  assert.deepEqual(snap.rooms, []);
  assert.deepEqual(snap.streamers, []);
  assert.equal(snap.settings.refreshInterval, 60);
  assert.equal(snap.settings.fetchDouyuViewerCount, true);
  assert.equal(snap.settings.fetchBilibiliViewerCount, true);
  assert.ok(!('fetchViewerCount' in snap.settings), '旧总开关不应出现在快照里');
});

test('snapshot：旧总开关 false 回退到两个平台开关；新字段一旦写入即以新字段为准', async () => {
  const legacy = await createStore({ settings: { fetchViewerCount: false } }).store.snapshot();
  assert.equal(legacy.settings.fetchDouyuViewerCount, false);
  assert.equal(legacy.settings.fetchBilibiliViewerCount, false);

  const partial = await createStore({
    settings: { fetchViewerCount: false, fetchBilibiliViewerCount: true }
  }).store.snapshot();
  assert.equal(partial.settings.fetchDouyuViewerCount, false, '斗鱼仍回退旧总开关');
  assert.equal(partial.settings.fetchBilibiliViewerCount, true, '新字段优先');
});

test('snapshot：rooms 每项附在线态（无主播快照时为 undefined），platform 缺失读时兜底 douyu', async () => {
  const { store } = createStore({
    rooms: [{ roomId: '1', nickname: '甲' }, room('bilibili', '2')],
    streamers: [streamer('douyu', '1', { online: true })]
  });
  const snap = await store.snapshot();
  assert.equal(snap.rooms[0].platform, 'douyu');
  assert.equal(snap.rooms[0].online, true);
  assert.equal(snap.rooms[1].online, undefined);
});

test('snapshot：快照深冻结，调用方改不动', async () => {
  const { store } = createStore({ rooms: [room('douyu', '1', { watch: { enabled: true, keywords: ['上车'] } })] });
  const snap = await store.snapshot();
  assert.ok(Object.isFrozen(snap.rooms));
  assert.ok(Object.isFrozen(snap.rooms[0]));
  assert.ok(Object.isFrozen(snap.settings));
  assert.throws(() => { snap.rooms[0].nickname = '改掉'; }, TypeError);
  assert.throws(() => { snap.rooms[0].watch.keywords.push('下车'); }, TypeError);
  assert.throws(() => { snap.settings.notificationsEnabled = false; }, TypeError);
});

// === 观众数采样计划 ===

test('viewerSamplePlan：按平台分组房间号并带上该平台的观众数开关', async () => {
  const { store } = createStore({
    rooms: [room('douyu', '100'), room('douyu', '101'), room('bilibili', '200')],
    settings: { fetchDouyuViewerCount: false }
  });
  const plan = await store.viewerSamplePlan();
  assert.deepEqual(plan.douyu, { enabled: false, roomIds: ['100', '101'] });
  assert.deepEqual(plan.bilibili, { enabled: true, roomIds: ['200'] });
});

// === 轮询合并 ===

test('mergePollResults：成功的平台取新数据，未返回的房间与失败的平台保留旧数据', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100'), room('bilibili', '200'), room('bilibili', '201')],
    streamers: [
      streamer('douyu', '100', { online: false, title: '旧标题' }),
      streamer('bilibili', '200', { online: true, title: '旧标题' }),
      streamer('bilibili', '201', { online: true, title: '旧标题' })
    ]
  });
  const result = await store.mergePollResults({
    results: {
      douyu: { success: true, data: [{ roomId: '100', online: true, title: '新标题', category: '游戏' }] },
      bilibili: { success: false, data: [] }
    }
  });
  const byRoom = key => storage.raw().streamers.find(s => `${s.platform}_${s.roomId}` === key);
  assert.equal(result.changed, true);
  assert.equal(byRoom('douyu_100').title, '新标题');
  assert.equal(byRoom('douyu_100').online, true);
  assert.equal(byRoom('douyu_100').platform, 'douyu', '平台字段由房间库补上');
  assert.equal(byRoom('bilibili_200').title, '旧标题', '整平台失败保留旧数据');
  assert.equal(result.onlineCount, 3);
});

test('mergePollResults：notify 以 rooms 为准镜像到主播快照', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100', { notify: true }), room('douyu', '101')],
    streamers: [streamer('douyu', '100'), streamer('douyu', '101', { notify: true })]
  });
  await store.mergePollResults({
    results: { douyu: { success: true, data: [{ roomId: '100', online: false }, { roomId: '101', online: false }] } }
  });
  const byRoom = id => storage.raw().streamers.find(s => s.roomId === id);
  assert.equal(byRoom('100').notify, true);
  assert.equal(byRoom('101').notify, false, '旧标记被 rooms 覆盖');
});

test('mergePollResults：观众数据透传，不被平台返回的数据覆盖', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100'), room('bilibili', '200')],
    streamers: [
      streamer('douyu', '100', { online: true, vipCount: 5000 }),
      streamer('bilibili', '200', { online: true, rankCount: 900 })
    ]
  });
  await store.mergePollResults({
    results: {
      douyu: { success: true, data: [{ roomId: '100', online: true, vipCount: 1 }] },
      bilibili: { success: true, data: [{ roomId: '200', online: true }] }
    }
  });
  const byRoom = id => storage.raw().streamers.find(s => s.roomId === id);
  assert.equal(byRoom('100').vipCount, 5000);
  assert.equal(byRoom('200').rankCount, 900);
});

test('mergePollResults：连续两轮确认离线才清空观众数据（单轮抖动不清）', async () => {
  const first = createStore({
    rooms: [room('bilibili', '200'), room('douyu', '100')],
    streamers: [streamer('bilibili', '200', { online: true, rankCount: 900 }), streamer('douyu', '100', { online: false, vipCount: 800 })]
  });
  await first.store.mergePollResults({
    results: {
      bilibili: { success: true, data: [{ roomId: '200', online: false }] },
      douyu: { success: true, data: [{ roomId: '100', online: false }] }
    }
  });
  const afterOne = first.storage.raw().streamers;
  assert.equal(afterOne.find(s => s.roomId === '200').rankCount, 900, '第一轮离线只记录，不清存量');

  const second = createStore(first.storage.raw());
  await second.store.mergePollResults({
    results: {
      bilibili: { success: true, data: [{ roomId: '200', online: false }] },
      douyu: { success: true, data: [{ roomId: '100', online: false }] }
    }
  });
  const afterTwo = second.storage.raw().streamers;
  assert.ok(!('rankCount' in afterTwo.find(s => s.roomId === '200')), '第二轮确认离线清空高能榜，提醒重新武装');
  assert.ok(!('vipCount' in afterTwo.find(s => s.roomId === '100')), '斗鱼同样清空');
});

test('mergePollResults：回传开播边沿（上一轮非在线 → 本轮在线），持续在线不重复', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100', { notify: true }), room('douyu', '101')],
    streamers: [streamer('douyu', '100', { online: false }), streamer('douyu', '101', { online: true })]
  });
  const first = await store.mergePollResults({
    results: {
      douyu: { success: true, data: [{ roomId: '100', online: true }, { roomId: '101', online: true }] }
    }
  });
  assert.deepEqual(first.wentLive.map(s => s.roomId), ['100']);
  assert.equal(first.wentLive[0].notify, true);
  assert.equal(first.onlineCount, 2);

  const second = await store.mergePollResults({
    results: {
      douyu: { success: true, data: [{ roomId: '100', online: true }, { roomId: '101', online: true }] }
    }
  });
  assert.deepEqual(second.wentLive, [], '持续在线不再产生边沿');
  assert.equal(storage.raw().streamers.filter(s => s.online).length, 2);
});

test('mergePollResults：没有房间时不写盘', async () => {
  const { store, storage } = createStore({ rooms: [], streamers: [] });
  const result = await store.mergePollResults({ results: { douyu: { success: true, data: [{ roomId: '100', online: true }] } } });
  assert.equal(result.changed, false);
  assert.equal(storage.writes.length, 0);
});

// === 值到达 ===

test('recordViewerCount：写入并回传前后值、房间快照与设置（提醒判定零额外读盘）', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100', { viewerAlert: { enabled: true, threshold: 3000 } })],
    streamers: [streamer('douyu', '100', { online: true, title: '在播' })]
  });
  const result = await store.recordViewerCount({ platform: 'douyu', roomId: '100', value: 5000 });
  assert.equal(result.changed, true);
  assert.equal(result.matched, true);
  assert.equal(result.prevValue, undefined);
  assert.equal(result.nextValue, 5000);
  assert.deepEqual(result.room.viewerAlert, { enabled: true, threshold: 3000 });
  assert.equal(result.streamer.vipCount, 5000);
  assert.equal(result.settings.viewerAlertEnabled, true);
  assert.equal(storage.raw().streamers[0].vipCount, 5000);
});

test('recordViewerCount：值未变化不写盘（两个平台一致）', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100'), room('bilibili', '200')],
    streamers: [streamer('douyu', '100', { vipCount: 5000 }), streamer('bilibili', '200', { rankCount: 900 })]
  });
  const douyu = await store.recordViewerCount({ platform: 'douyu', roomId: '100', value: 5000 });
  const bilibili = await store.recordViewerCount({ platform: 'bilibili', roomId: '200', value: 900 });
  assert.equal(douyu.changed, false);
  assert.equal(douyu.reason, 'unchanged');
  assert.equal(bilibili.changed, false);
  assert.equal(storage.writes.length, 0);
});

test('recordViewerCount：平台观众数开关关闭时不写，房间无主播快照时 matched=false', async () => {
  const gated = createStore({
    rooms: [room('douyu', '100')],
    streamers: [streamer('douyu', '100')],
    settings: { fetchDouyuViewerCount: false }
  });
  const off = await gated.store.recordViewerCount({ platform: 'douyu', roomId: '100', value: 5000 });
  assert.deepEqual(off, { changed: false, matched: false, reason: 'gate-off' });
  assert.equal(gated.storage.writes.length, 0);

  const missing = createStore({ rooms: [room('douyu', '100')], streamers: [] });
  const none = await missing.store.recordViewerCount({ platform: 'douyu', roomId: '100', value: 5000 });
  assert.deepEqual(none, { changed: false, matched: false, reason: 'no-streamer' });
});

test('recordViewerCount：畸形输入返回 reason 码而不抛（未知平台、非数字值）', async () => {
  const { store } = createStore({});
  assert.equal((await store.recordViewerCount({ platform: 'kuaishou', roomId: '1', value: 1 })).reason, 'unknown-platform');
  assert.equal((await store.recordViewerCount({ platform: 'douyu', roomId: '1', value: NaN })).reason, 'invalid-value');
});

// === 平台门控对齐与字段清理 ===

test('reconcileViewerGates：关闭的平台清对应字段，并回传有无房间与开关两个事实', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100'), room('bilibili', '200')],
    streamers: [streamer('douyu', '100', { vipCount: 1 }), streamer('bilibili', '200', { rankCount: 2 })],
    settings: { fetchBilibiliViewerCount: false }
  });
  const result = await store.reconcileViewerGates();
  assert.deepEqual(result.viewerFetch, { douyu: true, bilibili: false });
  assert.deepEqual(result.hasPlatform, { douyu: true, bilibili: true });
  assert.equal(result.changed, true);
  const raw = storage.raw().streamers;
  assert.equal(raw.find(s => s.platform === 'douyu').vipCount, 1, '斗鱼字段不动');
  assert.ok(!('rankCount' in raw.find(s => s.platform === 'bilibili')));
});

test('reconcileViewerGates：没有残留时不写盘（幂等）', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100')],
    streamers: [streamer('douyu', '100')]
  });
  const result = await store.reconcileViewerGates();
  assert.equal(result.changed, false);
  assert.deepEqual(result.cleared, []);
  assert.equal(storage.writes.length, 0);
});

// === 设置变更 ===

test('patchSettings：写入平台开关时删旧总开关，并在同一次写入里清掉被关闭平台的字段', async () => {
  const { store, storage } = createStore({
    rooms: [],
    streamers: [streamer('douyu', '100', { vipCount: 1 }), streamer('bilibili', '200', { rankCount: 2 })],
    settings: { fetchViewerCount: true, refreshInterval: 60 }
  });
  const result = await store.patchSettings({ fetchDouyuViewerCount: false });
  assert.equal(result.changed, true);
  assert.deepEqual(result.pruned, ['douyu_100']);
  const raw = storage.raw();
  assert.ok(!('fetchViewerCount' in raw.settings), '旧总开关随新字段写入作废');
  assert.equal(raw.settings.fetchDouyuViewerCount, false);
  assert.equal(raw.settings.refreshInterval, 60, '未给出的键不动');
  assert.ok(!('vipCount' in raw.streamers[0]));
  assert.equal(raw.streamers[1].rankCount, 2);
  assert.equal(storage.writes.length, 1, '设置与字段清理在同一次写入里完成');
});

test('patchSettings：refreshInterval 钳到下限，未知键与非法类型忽略', async () => {
  const { store, storage } = createStore({ settings: { refreshInterval: 300, notificationsEnabled: true } });
  await store.patchSettings({ refreshInterval: 5, notificationsEnabled: 'yes', 未知键: 1, watchQueued: [] });
  assert.equal(storage.raw().settings.refreshInterval, 60);
  assert.equal(storage.raw().settings.notificationsEnabled, true, '非布尔值忽略');
  assert.ok(!('未知键' in storage.raw().settings));
  assert.ok(!('watchQueued' in storage.raw().settings), '不是自己的键不写');
});

test('patchSettings：四个激增数值参数各自钳到范围，非法值忽略', async () => {
  const { store, storage } = createStore({ settings: {} });
  await store.patchSettings({
    surgeMultiple: 99,        // 上限 10
    surgeMinBaseline: 0,      // 下限 1
    surgeCooldownMinutes: -5, // 下限 1
    surgeMinBuckets: 999,     // 上限 30（即每房保留的桶数）
    surgeAlertEnabled: 'yes'  // 非布尔值忽略
  });
  assert.equal(storage.raw().settings.surgeMultiple, 10);
  assert.equal(storage.raw().settings.surgeMinBaseline, 1);
  assert.equal(storage.raw().settings.surgeCooldownMinutes, 1);
  assert.equal(storage.raw().settings.surgeMinBuckets, 30);

  await store.patchSettings({ surgeMultiple: 'abc', surgeMinBaseline: null, surgeMinBuckets: 1 });
  assert.equal(storage.raw().settings.surgeMultiple, 10, '非法值忽略，不把无效输入变成一次重置');
  assert.equal(storage.raw().settings.surgeMinBaseline, 1);
  assert.equal(storage.raw().settings.surgeMinBuckets, 2, '低于下限钳到下限');
  assert.ok(!('surgeAlertEnabled' in storage.raw().settings), '非布尔值不落盘');
});

test('patchSettings：倍数支持一位小数，落盘的值与用户填的一致', async () => {
  const { store, storage } = createStore({ settings: {} });

  await store.patchSettings({ surgeMultiple: 1.5 });
  assert.equal(storage.raw().settings.surgeMultiple, 1.5, '1.5 不被取整成 1');

  await store.patchSettings({ surgeMultiple: 1.57 });
  assert.equal(storage.raw().settings.surgeMultiple, 1.5, '第二位小数截断');

  await store.patchSettings({ surgeMultiple: 1 });
  assert.equal(storage.raw().settings.surgeMultiple, 1.1, '低于下限钳到 1.1（倍数 1 是退化值）');
});

test('patchSettings：值没有变化时不写盘', async () => {
  const { store, storage } = createStore({ settings: { notificationsEnabled: true } });
  const result = await store.patchSettings({ notificationsEnabled: true });
  assert.equal(result.changed, false);
  assert.equal(storage.writes.length, 0);
});

// === 单房配置变更 ===

test('patchRoomConfig：浅合并该房条目，undefined 不改、null 删字段、未知字段保留', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100', { notify: true, watch: { enabled: true, keywords: ['上车'] }, 未来字段: { a: 1 } })]
  });
  const result = await store.patchRoomConfig(
    { platform: 'douyu', roomId: '100' },
    { notify: false, viewerAlert: { enabled: true, threshold: 2000 }, watch: undefined, 未来字段: { a: 2 } }
  );
  assert.equal(result.ok, true);
  const saved = storage.raw().rooms[0];
  assert.equal(saved.notify, false);
  assert.deepEqual(saved.viewerAlert, { enabled: true, threshold: 2000 });
  assert.deepEqual(saved.watch, { enabled: true, keywords: ['上车'] }, 'undefined 不改');
  assert.deepEqual(saved.未来字段, { a: 2 });

  await store.patchRoomConfig({ platform: 'douyu', roomId: '100' }, { viewerAlert: null });
  assert.ok(!('viewerAlert' in storage.raw().rooms[0]), 'null 删字段');
});

test('patchRoomConfig：房间不存在返回 not-found，不写盘', async () => {
  const { store, storage } = createStore({ rooms: [room('douyu', '100')] });
  const result = await store.patchRoomConfig({ platform: 'bilibili', roomId: '100' }, { notify: true });
  assert.deepEqual(result, { ok: false, reason: 'not-found' });
  assert.equal(storage.writes.length, 0);
});

// === 房间增删 ===

test('addRoom：未知平台显式拒绝，不解析昵称也不写盘（不静默当成斗鱼）', async () => {
  const resolveNickname = async () => ({ ok: true, nickname: '不该被调用' });
  const { store, storage } = createStore({ rooms: [] }, { resolveNickname });
  const rejected = await store.addRoom({ roomId: '100', platform: 'kuaishou' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, '不支持的平台');
  assert.equal(storage.raw().rooms.length, 0, '房间列表不变');
  assert.equal(storage.writes.length, 0, '既不写盘也不解析昵称');

  const missing = await store.addRoom({ roomId: '100' });
  assert.equal(missing.ok, false, '缺 platform 同样拒绝');
  assert.equal(storage.writes.length, 0);
});

test('addRoom：非纯数字拒绝，重复拒绝，不写盘', async () => {
  const { store, storage } = createStore({ rooms: [room('douyu', '100')] });
  assert.equal((await store.addRoom({ roomId: ' 12a ', platform: 'douyu' })).error, '房间号格式无效');
  const dup = await store.addRoom({ roomId: '100', platform: 'douyu' });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, '该房间已在监控列表中');
  assert.equal(storage.writes.length, 0);
});

test('addRoom：所选平台解析失败自动换另一平台兜底，兜底后同样查重', async () => {
  const resolveNickname = async (platform) => platform === 'bilibili'
    ? { ok: true, nickname: 'B站主播' }
    : { ok: false };
  const { store, storage } = createStore({ rooms: [] }, { resolveNickname });
  const added = await store.addRoom({ roomId: '100', platform: 'douyu' });
  assert.equal(added.ok, true);
  assert.equal(added.room.platform, 'bilibili');
  assert.equal(storage.raw().rooms[0].notify, false);

  const dup = await store.addRoom({ roomId: '100', platform: 'douyu' });
  assert.equal(dup.ok, false, '兜底到 bilibili 后撞上已有房间');
  assert.equal(storage.raw().rooms.length, 1);
});

test('removeRoom：rooms 与主播快照在同一次写入里删净，重复移除幂等', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100'), room('douyu', '101')],
    streamers: [streamer('douyu', '100'), streamer('douyu', '101')]
  });
  const removed = await store.removeRoom({ platform: 'douyu', roomId: '100' });
  assert.equal(removed.removed, true);
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.raw().rooms.length, 1);
  assert.equal(storage.raw().streamers.length, 1);

  const again = await store.removeRoom({ platform: 'douyu', roomId: '100' });
  assert.equal(again.removed, false);
  assert.equal(storage.writes.length, 1);
});

// === 房间重排 ===

test('reorderRooms：按目标顺序重排，未列出的接尾，主播快照同步且缺条目补占位', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100'), room('douyu', '101'), room('bilibili', '200')],
    streamers: [streamer('douyu', '100'), streamer('douyu', '101'), streamer('douyu', '999')]
  });
  const result = await store.reorderRooms([{ platform: 'bilibili', roomId: '200' }]);
  assert.equal(result.ok, true);
  const raw = storage.raw();
  assert.deepEqual(raw.rooms.map(r => `${r.platform}_${r.roomId}`), ['bilibili_200', 'douyu_100', 'douyu_101'], '未列出的按原相对顺序接尾');
  assert.deepEqual(raw.streamers.map(s => `${s.platform}_${s.roomId}`), ['bilibili_200', 'douyu_100', 'douyu_101']);
  assert.equal(raw.streamers[0].online, false, '缺主播快照的房间补占位等下一轮填充');
  assert.equal(raw.streamers[0].nickname, undefined, '占位没有昵称，等轮询填充');

  const same = await store.reorderRooms([{ platform: 'bilibili', roomId: '200' }, { platform: 'douyu', roomId: '100' }, { platform: 'douyu', roomId: '101' }]);
  assert.equal(same.changed, false, '顺序没变不写盘');
  assert.equal(storage.writes.length, 1, '只有第一次重排落盘');
});

// === 初始化 ===

test('init：首启写入默认值，之后幂等不再写', async () => {
  const { store, storage } = createStore({});
  const first = await store.init();
  assert.deepEqual(first, { migrated: false, seeded: true });
  assert.deepEqual(storage.raw().settings, ROOM_STORE_DEFAULTS.settings);
  assert.deepEqual(storage.raw().rooms, []);
  assert.equal(storage.writes.length, 1);

  const second = await store.init();
  assert.deepEqual(second, { migrated: false, seeded: false });
  assert.equal(storage.writes.length, 1);
});

test('init：旧格式（无 platform）的 rooms / streamers 迁移为 douyu', async () => {
  const { store, storage } = createStore({
    rooms: [{ roomId: '100', nickname: '老数据' }],
    streamers: [{ roomId: '100', nickname: '老数据', online: true }],
    settings: { refreshInterval: 60 }
  });
  const result = await store.init();
  assert.equal(result.migrated, true);
  assert.equal(result.seeded, false);
  assert.equal(storage.raw().rooms[0].platform, 'douyu');
  assert.equal(storage.raw().streamers[0].platform, 'douyu');
  assert.equal(storage.raw().settings.refreshInterval, 60, '已有 settings 不动');
});

// === 串行队列：读改写不交错（本 module 存在的理由）===

test('串行队列：并发两次值到达，前值链正确（都在自己的临界区里读到最新值）', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100')],
    streamers: [streamer('douyu', '100', { online: true })]
  }, { asyncTick: true });

  const [first, second] = await Promise.all([
    store.recordViewerCount({ platform: 'douyu', roomId: '100', value: 10 }),
    store.recordViewerCount({ platform: 'douyu', roomId: '100', value: 20 })
  ]);
  assert.equal(first.prevValue, undefined);
  assert.equal(first.nextValue, 10);
  assert.equal(second.prevValue, 10, '第二次读到的前值是第一次写入后的值');
  assert.equal(second.nextValue, 20);
  assert.equal(storage.raw().streamers[0].vipCount, 20);
});

test('串行队列：轮询合并与值到达并发时，采样值不被轮询的旧快照覆盖', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100')],
    streamers: [streamer('douyu', '100', { online: true, title: '旧标题', vipCount: 5 })]
  }, { asyncTick: true });

  const [poll, sample] = await Promise.all([
    store.mergePollResults({ results: { douyu: { success: true, data: [{ roomId: '100', online: true, title: '新标题' }] } } }),
    store.recordViewerCount({ platform: 'douyu', roomId: '100', value: 99 })
  ]);
  assert.equal(poll.changed, true);
  assert.equal(sample.changed, true);
  const saved = storage.raw().streamers[0];
  assert.equal(saved.title, '新标题', '轮询结果落盘');
  assert.equal(saved.vipCount, 99, '采样值没有被轮询合并时的旧快照覆盖');
});
