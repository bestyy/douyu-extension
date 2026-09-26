// test/room-store.test.cjs — 房间库（lib/room-store.js）行为测试
//
// 运行：npm test（node --test）
// 覆盖：只读快照与默认值、观众数采样计划、轮询合并（取新/留旧/透传/两轮离线清空/开播边沿）、
// 值到达（门控、未变不写、前后值）、平台门控对齐与清字段、设置与单房配置变更、房间增删与
// 分类内重排、分类增删改与分类间重排、归类落点（追加到目标分组末尾）、初始化迁移，
// 以及串行队列对「读改写交错」的消除（丢更新是本 module 存在的理由）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RoomStore, ROOM_STORE_DEFAULTS } = require('../lib/room-store.js');
const { RoomIdentity } = require('../lib/room-identity.js');
const { RoomCategories } = require('../lib/room-categories.js');

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
  return { store: new RoomStore({ storage, resolveNickname, identity: RoomIdentity, categoryRules: RoomCategories }), storage };
}

const room = (platform, roomId, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
const streamer = (platform, roomId, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, online: false, ...extra });

// === 只读快照 ===

test('snapshot：缺键补默认值，平台观众数开关解算为布尔，旧总开关不出现在快照里', async () => {
  const { store } = createStore({});
  const snap = await store.snapshot();
  assert.deepEqual(snap.rooms, []);
  assert.deepEqual(snap.streamers, []);
  assert.deepEqual(snap.categories, []);
  assert.equal(snap.settings.refreshInterval, 60);
  assert.equal(snap.settings.fetchDouyuViewerCount, true);
  assert.equal(snap.settings.fetchBilibiliViewerCount, true);
  assert.ok(!('fetchViewerCount' in snap.settings), '旧总开关不应出现在快照里');
});

test('snapshot：快照带上分类列表且深冻结（老安装缺 categories 键时回退空数组）', async () => {
  const legacy = await createStore({ rooms: [], streamers: [], settings: {} }).store.snapshot();
  assert.deepEqual(legacy.categories, [], '老安装缺键走读侧回退，不重写用户数据');

  const { store } = createStore({ categories: [{ id: 'c1', name: '游戏' }] });
  const snap = await store.snapshot();
  assert.deepEqual(snap.categories, [{ id: 'c1', name: '游戏' }]);
  assert.ok(Object.isFrozen(snap.categories));
  assert.ok(Object.isFrozen(snap.categories[0]));
  assert.throws(() => { snap.categories.push({ id: 'c2', name: '音乐' }); }, TypeError);
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

// === 房间重排（分类内；见 ADR-0008 第四条）===

test('reorderRooms：只置换该分类成员所占的槽位，其余房间位置不动，主播快照同步且缺条目补占位', async () => {
  const { store, storage } = createStore({
    categories: [{ id: 'c1', name: '游戏' }],
    rooms: [room('douyu', '100', { categoryId: 'c1' }), room('douyu', '101'), room('bilibili', '200', { categoryId: 'c1' })],
    streamers: [streamer('douyu', '100'), streamer('bilibili', '200')]
  });
  const result = await store.reorderRooms({ categoryId: 'c1', order: [{ platform: 'bilibili', roomId: '200' }] });
  assert.equal(result.ok, true);
  const raw = storage.raw();
  assert.deepEqual(raw.rooms.map(r => `${r.platform}_${r.roomId}`), ['bilibili_200', 'douyu_101', 'douyu_100'], '分类成员只换槽位，未分类房间留在原槽位');
  assert.deepEqual(raw.streamers.map(s => `${s.platform}_${s.roomId}`), ['bilibili_200', 'douyu_101', 'douyu_100']);
  assert.equal(raw.streamers[1].online, false, '缺主播快照的房间补占位等下一轮填充');
  assert.equal(raw.streamers[1].nickname, undefined, '占位没有昵称，等轮询填充');
});

test('reorderRooms：未列出的成员按原相对顺序接尾，未知引用与别分类的引用忽略，重复折叠', async () => {
  const { store, storage } = createStore({
    categories: [{ id: 'c1', name: '游戏' }],
    rooms: [
      room('douyu', '1', { categoryId: 'c1' }),
      room('douyu', '2'),
      room('douyu', '3', { categoryId: 'c1' }),
      room('douyu', '4', { categoryId: 'c1' })
    ]
  });
  await store.reorderRooms({
    categoryId: 'c1',
    order: [
      { platform: 'douyu', roomId: '4' },
      { platform: 'douyu', roomId: '4' },      // 重复折叠
      { platform: 'douyu', roomId: '2' },      // 属于未分类，忽略
      { platform: 'douyu', roomId: '999' }     // 未知引用，忽略
    ]
  });
  assert.deepEqual(storage.raw().rooms.map(r => r.roomId), ['4', '2', '1', '3'], '未列出的成员按原相对顺序接尾');
});

test('reorderRooms：顺序没变不写盘；分类查不到时按未分类段重排', async () => {
  const { store, storage } = createStore({
    categories: [{ id: 'c1', name: '游戏' }],
    rooms: [room('douyu', '1', { categoryId: 'c1' }), room('douyu', '2')]
  });
  const same = await store.reorderRooms({ categoryId: 'c1', order: [{ platform: 'douyu', roomId: '1' }] });
  assert.equal(same.changed, false);
  assert.equal(storage.writes.length, 0, '顺序没变不写盘');

  await store.reorderRooms({ categoryId: 'g不在分类列表里', order: [{ platform: 'douyu', roomId: '2' }] });
  assert.deepEqual(storage.raw().rooms.map(r => r.roomId), ['1', '2'], '未知分类 id 回落未分类段重排');

  assert.deepEqual(await store.reorderRooms({ categoryId: 'c1', order: 'not-an-array' }), { ok: false, reason: 'invalid-order' });
});

// === 分类（一等实体：单独一份列表，房间只记 categoryId；见 ADR-0008）===

test('addCategory：名称 trim 后落盘、id 由房间库生成，追加到分类列表末尾', async () => {
  const { store, storage } = createStore({ categories: [{ id: 'c1', name: '游戏' }] });
  const created = await store.addCategory('  音乐  ');
  assert.equal(created.ok, true);
  assert.deepEqual(created.category, { id: 'c2', name: '音乐' }, '前后空格被去掉');
  assert.deepEqual(storage.raw().categories, [{ id: 'c1', name: '游戏' }, { id: 'c2', name: '音乐' }]);
});

test('addCategory：空名 / 超长 / 重名 / 保留名「未分类」都被拒，不写盘', async () => {
  const { store, storage } = createStore({ categories: [{ id: 'c1', name: '游戏' }] });
  assert.equal((await store.addCategory('   ')).error, '分类名不能为空');
  assert.equal((await store.addCategory('x'.repeat(RoomCategories.NAME_MAX_LENGTH + 1))).error, `分类名最多 ${RoomCategories.NAME_MAX_LENGTH} 个字`);
  assert.equal((await store.addCategory('游戏')).error, '已有同名分类');
  assert.equal((await store.addCategory(' 游戏 ')).error, '已有同名分类', 'trim 后再判重名');
  assert.equal((await store.addCategory('未分类')).error, '「未分类」是保留名，不能作为分类名');
  assert.equal(storage.writes.length, 0);
});

test('renameCategory：一次生效、改同名不算变更不写盘，重名（排除自身）与保留名被拒', async () => {
  const { store, storage } = createStore({ categories: [{ id: 'c1', name: '游戏' }, { id: 'c2', name: '音乐' }] });
  const renamed = await store.renameCategory('c1', ' 单机游戏 ');
  assert.equal(renamed.ok, true);
  assert.equal(storage.raw().categories[0].name, '单机游戏');

  const same = await store.renameCategory('c2', '音乐');
  assert.equal(same.changed, false, '改同名不算变更');
  assert.equal(storage.writes.length, 1);

  assert.equal((await store.renameCategory('c2', '单机游戏')).error, '已有同名分类');
  assert.equal((await store.renameCategory('c2', '未分类')).error, '「未分类」是保留名，不能作为分类名');
  assert.equal((await store.renameCategory('c1', '单机游戏')).ok, true, '排除自身后改名通过');
  assert.equal((await store.renameCategory('不存在', 'x')).error, '分类不存在');
});

test('removeCategory：分类与其下房间的 categoryId 在同一次写入里落盘，房间回落未分类并接在未分类末尾', async () => {
  const { store, storage } = createStore({
    categories: [{ id: 'c1', name: '游戏' }],
    rooms: [
      room('douyu', '1', { categoryId: 'c1' }),
      room('douyu', '2'),
      room('douyu', '3', { categoryId: 'c1' }),
      room('douyu', '4')
    ]
  });
  const result = await store.removeCategory('c1');
  assert.deepEqual(result, { ok: true, changed: true, affected: 2 });
  assert.equal(storage.writes.length, 1, '分类列表与房间改动在同一次写入里');
  assert.deepEqual(storage.writes[0].sort(), ['categories', 'rooms']);
  assert.deepEqual(storage.raw().categories, []);
  assert.deepEqual(storage.raw().rooms.map(r => r.roomId), ['2', '4', '1', '3'], '回落的房间本身不删，按原相对顺序接在未分类末尾');
  assert.ok(!('categoryId' in storage.raw().rooms[2]));

  const again = await store.removeCategory('c1');
  assert.deepEqual(again, { ok: true, changed: false, affected: 0 }, '重复删除幂等');
  assert.equal(storage.writes.length, 1);
});

test('removeCategory：分类下没有房间时只写分类列表', async () => {
  const { store, storage } = createStore({ categories: [{ id: 'c1', name: '空分类' }], rooms: [room('douyu', '1')] });
  const result = await store.removeCategory('c1');
  assert.equal(result.affected, 0);
  assert.deepEqual(storage.writes, [['categories']]);
});

test('reorderCategories：按目标顺序重排，未列出的接尾，未知引用忽略，顺序没变不写盘', async () => {
  const { store, storage } = createStore({
    categories: [{ id: 'c1', name: '一' }, { id: 'c2', name: '二' }, { id: 'c3', name: '三' }]
  });
  await store.reorderCategories(['c3', 'c3', '未知', 'c1']);
  assert.deepEqual(storage.raw().categories.map(c => c.id), ['c3', 'c1', 'c2'], '未列出的 c2 按原相对顺序接尾');

  const same = await store.reorderCategories(['c3', 'c1', 'c2']);
  assert.equal(same.changed, false);
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(await store.reorderCategories('not-an-array'), { ok: false, reason: 'invalid-order' });
});

test('setRoomCategory：换分类后追加到目标分类末尾，同组不算变更，未知分类 id 回落未分类', async () => {
  const { store, storage } = createStore({
    categories: [{ id: 'c1', name: '游戏' }],
    rooms: [room('douyu', '1', { categoryId: 'c1' }), room('douyu', '2'), room('douyu', '3', { categoryId: 'c1' })]
  });
  await store.setRoomCategory({ platform: 'douyu', roomId: '2' }, 'c1');
  assert.deepEqual(storage.raw().rooms.map(r => r.roomId), ['1', '3', '2'], '新来的排到目标分类末尾');
  assert.equal(storage.raw().rooms[2].categoryId, 'c1');

  const same = await store.setRoomCategory({ platform: 'douyu', roomId: '2' }, 'c1');
  assert.equal(same.changed, false, '已经在该分组里，不借机重排');
  assert.equal(storage.writes.length, 1);

  const fallback = await store.setRoomCategory({ platform: 'douyu', roomId: '1' }, '不存在的分类');
  assert.equal(fallback.ok, true);
  assert.ok(!('categoryId' in storage.raw().rooms.find(r => r.roomId === '1')), '查不到分类 id 回落未分类');
  assert.deepEqual(await store.setRoomCategory({ platform: 'douyu', roomId: '9999' }, 'c1'), { ok: false, reason: 'not-found' });
});

test('addRoom：新房间落到所选分类末尾；未知分类 id 回落未分类（不因此拒绝添加）', async () => {
  const resolveNickname = async () => ({ ok: true, nickname: '主播' });
  const { store, storage } = createStore({ categories: [{ id: 'c1', name: '游戏' }] }, { resolveNickname });

  const added = await store.addRoom({ roomId: '100', platform: 'douyu', categoryId: 'c1' });
  assert.equal(added.ok, true);
  assert.equal(added.room.categoryId, 'c1');

  const unknown = await store.addRoom({ roomId: '101', platform: 'douyu', categoryId: '早就删了' });
  assert.equal(unknown.ok, true);
  assert.ok(!('categoryId' in unknown.room), '未知分类 id 回落未分类，房间本体照常加入');
  assert.deepEqual(storage.raw().rooms.map(r => r.roomId), ['100', '101'], '新房间追加在末尾（即所属分组末尾）');
});

// === 初始化 ===

test('init：首启写入默认值，之后幂等不再写', async () => {
  const { store, storage } = createStore({});
  const first = await store.init();
  assert.deepEqual(first, { migrated: false, seeded: true });
  assert.deepEqual(storage.raw().settings, ROOM_STORE_DEFAULTS.settings);
  assert.deepEqual(storage.raw().rooms, []);
  assert.deepEqual(storage.raw().categories, [], '四个键俱缺才写默认值（含分类列表）');
  assert.equal(storage.writes.length, 1);

  const second = await store.init();
  assert.deepEqual(second, { migrated: false, seeded: false });
  assert.equal(storage.writes.length, 1);
});

test('init：老安装有前三个键但缺 categories 时不 seed（升级路径走读侧回退，不重写用户数据）', async () => {
  const { store, storage } = createStore({
    rooms: [room('douyu', '100')],
    streamers: [streamer('douyu', '100')],
    settings: { refreshInterval: 60 }
  });
  const result = await store.init();
  assert.deepEqual(result, { migrated: false, seeded: false });
  const raw = storage.raw();
  assert.ok(!('categories' in raw), '不因缺这个键而整份重写默认值');
  assert.equal(raw.rooms.length, 1, '存量房间原样保留');
  assert.deepEqual((await store.snapshot()).categories, [], '读侧回退空数组');
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
