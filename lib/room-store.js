// lib/room-store.js — 房间库：rooms / streamers / settings 三个键的形状与全部变更
//
// 单写者（见 docs/adr/0003-room-store-single-writer.md）：这三个键的所有写入只发生在房间库内。
// 页面的变更请求经 SW 消息到达这里（PATCH_SETTINGS / PATCH_ROOM_CONFIG / REORDER_ROOMS），
// 读取走 snapshot() 的只读快照。`notifiedRooms` / `_firstRun` / `lastRefresh` / `watchQueued` /
// `biliPageChannelEnabled` 不归房间库，由编排、盯守与桥接通道各自持有。
//
// 三条纪律：
// - 意图式变更：操作只接受意图（「记录 douyu_100 的贵宾数为 5000」），内部重新读改写；
//   绝不接受调用者把快照传回来当写依据——那会把丢更新原样请回来。
// - 无内存缓存：每次操作在自己的临界区里读改写，原子性由模块内的 FIFO 串行队列保证；
//   队列内禁止 await 网络（值到达约 6 秒一次，不能被一次慢轮询堵住）。
// - 报告转变、不发通知：合并与值到达只回传开播边沿与前后值，通知与阈值判定留在编排
//   与两个纯规则模块（lib/viewer-alert.js、lib/danmaku-watch.js）。
//
// 注入依赖：storage({ get(keys), set(entries) })、resolveNickname(platform, roomId) -> {ok, nickname}。
// 生产 adapter = chrome.storage.local + 两个平台 API；测试 adapter = 内存对象 + 脚本化假解析。
// UMD 双兼容：SW 经 importScripts 加载，设置页/弹窗作普通 script，node 下可 require。
// 错误模型：入口对畸形输入返回 reason 码而不抛（调用方是消息通道与弹幕推送），只有构造时缺少
// storage port 才抛。

// 三个键的默认值：本文件是它们形状的唯一来源（lib/storage.js 只留 chrome 适配）
const ROOM_STORE_DEFAULTS = {
  // rooms[].watch 为可选的弹幕检测配置 { enabled, keywords[], threshold, windowMinutes, cooldownMinutes }，
  // rooms[].viewerAlert 为可选的观众数提醒配置 { enabled, threshold }；缺字段视为未配置
  rooms: [],   // { roomId, nickname, platform, notify?: boolean, watch?: object, viewerAlert?: object }
  streamers: [],
  settings: {
    refreshInterval: 60,
    notificationsEnabled: true,
    viewerAlertEnabled: true,
    openInCurrentTab: false,
    // 观众数开关按平台拆分：新字段优先，未写入时回退旧总开关 fetchViewerCount 语义
    fetchDouyuViewerCount: true,
    fetchBilibiliViewerCount: true,
    fetchViewerCount: true   // 旧总开关（读取兼容回退，写入任一新字段时删除）
  }
};

// 平台 → 观众数字段 / 观众数开关键。字段映射内置（仓库只有两个平台，不是扩展点）；
// 加平台要先在 CONTEXT.md 里有这个概念，再回来加一行。
const ROOM_STORE_VIEWER_FIELD = { douyu: 'vipCount', bilibili: 'rankCount' };
const ROOM_STORE_VIEWER_TOGGLE = { douyu: 'fetchDouyuViewerCount', bilibili: 'fetchBilibiliViewerCount' };
const ROOM_STORE_VIEWER_TOGGLE_KEYS = Object.values(ROOM_STORE_VIEWER_TOGGLE);
const ROOM_STORE_PLATFORMS = ['douyu', 'bilibili'];

// settings 允许写入的键（房间库拥有形状：未知键忽略，避免错字悄悄落盘）
const ROOM_STORE_SETTINGS_KEYS = [
  'refreshInterval',
  'notificationsEnabled',
  'danmakuWatchEnabled',
  'viewerAlertEnabled',
  'openInCurrentTab',
  'fetchDouyuViewerCount',
  'fetchBilibiliViewerCount'
];

// 轮询间隔下限（分钟）：小于 1 分钟的轮询会撞平台限流
const ROOM_STORE_MIN_REFRESH_INTERVAL = 60;

/** 深拷贝（数据都是 JSON 安全的普通对象/数组/原始值，不用 structuredClone 以兼容老环境） */
function roomStoreClone(value) {
  if (Array.isArray(value)) {
    return value.map(roomStoreClone);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = roomStoreClone(v);
    }
    return out;
  }
  return value;
}

/** 深冻结：快照是只读视图，变更只能经房间库的操作 */
function roomStoreFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(roomStoreFreeze);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) roomStoreFreeze(v);
    return Object.freeze(value);
  }
  return value;
}

/** 只读快照：深拷贝后深冻结，不与存储或内部状态共享引用 */
function roomStoreView(value) {
  return roomStoreFreeze(roomStoreClone(value));
}

/** 复用同一套比较口径的值相等（watch / viewerAlert 是对象，不能用引用比较） */
function roomStoreSameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

class RoomStore {
  /**
   * @param {object} options
   * @param {{ get(keys: string[]): Promise<object>, set(entries: object): Promise<void> }} options.storage 存储 port
   * @param {(platform: string, roomId: string) => Promise<{ok: boolean, nickname?: string}>} [options.resolveNickname]
   *        昵称解析（仅 addRoom 用；生产 adapter 指向两个平台 API，测试注入脚本化假实现）
   */
  constructor({ storage, resolveNickname } = {}) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new TypeError('RoomStore 需要 storage port：{ get(keys), set(entries) }');
    }
    this._storage = storage;
    this._resolveNickname = typeof resolveNickname === 'function' ? resolveNickname : async () => ({ ok: false });
    this._queue = Promise.resolve(); // FIFO 串行队列：同一时刻只有一个操作在临界区
  }

  /** 默认值（装配线首启写入用；测试直接导入，不再手抄） */
  static get DEFAULTS() {
    return ROOM_STORE_DEFAULTS;
  }

  // === 读 ===

  /**
   * 只读快照：一次存储往返拿到三个键，缺键补默认值。
   * - rooms 每项附加 online（true/false；无对应主播快照时为 undefined），platform 缺失读时兜底 douyu（不写）
   * - settings 已解算平台观众数开关（恒为布尔），旧总开关 fetchViewerCount 不出现在快照里
   * @returns {Promise<{rooms: Array, streamers: Array, settings: object}>} 深冻结
   */
  async snapshot() {
    const { rooms, streamers, settings } = await this._readRaw();
    const onlineByKey = new Map();
    for (const s of streamers) {
      onlineByKey.set(RoomStore._key(s.platform || 'douyu', s.roomId), s.online === true);
    }
    const roomViews = rooms.map(room => {
      const platform = room.platform || 'douyu';
      const view = { ...room, platform };
      const online = onlineByKey.get(RoomStore._key(platform, room.roomId));
      if (online !== undefined) view.online = online;
      return view;
    });
    return roomStoreView({ rooms: roomViews, streamers, settings: RoomStore._resolvedSettings(settings) });
  }

  /**
   * 观众数采样计划：按平台分组的房间号 + 该平台的观众数开关（采样分支据此选择是否派发）。
   * @returns {Promise<{douyu: {enabled: boolean, roomIds: string[]}, bilibili: {enabled: boolean, roomIds: string[]}}>}
   */
  async viewerSamplePlan() {
    const { rooms, settings } = await this._readRaw();
    const plan = {};
    for (const platform of ROOM_STORE_PLATFORMS) {
      plan[platform] = {
        enabled: RoomStore._isViewerFetchEnabled(settings, platform),
        roomIds: rooms
          .filter(room => (room.platform || 'douyu') === platform)
          .map(room => String(room.roomId))
      };
    }
    return roomStoreView(plan);
  }

  // === 变更 ===

  /**
   * 轮询收敛点的合并：平台返回的房间取新数据，未返回的（含整平台失败）保留旧数据。
   * 内部完成 notify 镜像、观众数透传、连续两轮离线后清空观众数字段。
   * @param {{results: {douyu?: {success: boolean, data: Array}, bilibili?: {success: boolean, data: Array}}}} params
   *        平台 API 的原始返回；缺平台或 success !== true 视为该平台本轮失败
   * @returns {Promise<{changed: boolean, streamers: Array, onlineCount: number, wentLive: Array}>}
   *          wentLive = 上一轮非在线、本轮在线的主播快照（开播边沿，一次）
   */
  async mergePollResults({ results = {} } = {}) {
    return this._enqueue(async () => {
      const { rooms, streamers } = await this._readRaw();
      if (rooms.length === 0) {
        return roomStoreView({ changed: false, streamers, onlineCount: RoomStore._onlineCount(streamers), wentLive: [] });
      }

      const prevByKey = new Map();
      const prevOnline = new Set();
      for (const streamer of streamers) {
        const key = RoomStore._key(streamer.platform || 'douyu', streamer.roomId);
        prevByKey.set(key, streamer);
        if (streamer.online) prevOnline.add(key);
      }

      // 平台返回的房间按复合键索引（只有本轮成功的平台才进表）
      const fresh = new Map();
      for (const platform of ROOM_STORE_PLATFORMS) {
        const result = results[platform];
        if (!result || result.success !== true || !Array.isArray(result.data)) continue;
        for (const item of result.data) {
          fresh.set(RoomStore._key(platform, item.roomId), { ...item, platform });
        }
      }

      const merged = [];
      const wentLive = [];
      for (const room of rooms) {
        const platform = room.platform || 'douyu';
        const key = RoomStore._key(platform, room.roomId);
        const prev = prevByKey.get(key);
        const freshItem = fresh.get(key);
        const item = freshItem ? { ...freshItem } : (prev ? { ...prev } : null);
        if (!item) continue; // 既无新数据也无旧数据：跳过（该房从未成功取过数据）

        item.notify = room.notify === true; // per-room 通知标记以 rooms 为准
        // 透传弹幕采样写入的观众数（平台 API 不返回该字段，避免被轮询覆盖）
        if (prev && typeof prev.vipCount === 'number') item.vipCount = prev.vipCount;
        if (prev && typeof prev.rankCount === 'number') item.rankCount = prev.rankCount;
        // 连续两轮确认离线 → 清空上一场存量：popup 不再显示旧值，观众数提醒重新武装（见 ADR-0002）。
        // 两轮而非一轮：防单次 API 抖动把在播房间误判为离线后同场重复提醒。
        if (item.online === false && prev && prev.online === false) {
          delete item.vipCount;
          delete item.rankCount;
        }
        if (item.online === true && !prevOnline.has(key)) wentLive.push(item);
        merged.push(item);
      }

      if (merged.length === 0) {
        return roomStoreView({ changed: false, streamers, onlineCount: RoomStore._onlineCount(streamers), wentLive: [] });
      }
      await this._storage.set({ streamers: merged });
      return roomStoreView({
        changed: true,
        streamers: merged,
        onlineCount: RoomStore._onlineCount(merged),
        wentLive
      });
    });
  }

  /**
   * 值到达入口（斗鱼 oni 的贵宾数 / B站 ONLINE_RANK_COUNT 的高能榜在线数）。
   * 平台观众数开关关闭、房间无主播快照、数值未变化都不写；写成功时回传前后值与房间快照，
   * 供编排在「值到达处」判观众数提醒（见 ADR-0002）。
   * @param {{platform: string, roomId: string, value: number}} params
   * @returns {Promise<{changed: boolean, matched: boolean, reason?: string, prevValue?: number,
   *                    nextValue?: number, room?: object, streamer?: object, settings?: object}>}
   */
  async recordViewerCount({ platform, roomId, value } = {}) {
    const field = ROOM_STORE_VIEWER_FIELD[platform];
    if (!field) return { changed: false, matched: false, reason: 'unknown-platform' };
    if (!Number.isFinite(value)) return { changed: false, matched: false, reason: 'invalid-value' };

    return this._enqueue(async () => {
      const { rooms, streamers, settings } = await this._readRaw();
      if (!RoomStore._isViewerFetchEnabled(settings, platform)) {
        return { changed: false, matched: false, reason: 'gate-off' };
      }
      const index = streamers.findIndex(s => (s.platform || 'douyu') === platform && RoomStore._sameRoomId(s.roomId, roomId));
      if (index === -1) {
        return { changed: false, matched: false, reason: 'no-streamer' }; // 编排自行决定是否记日志
      }
      const prevValue = streamers[index][field];
      if (prevValue === value) {
        return { changed: false, matched: true, reason: 'unchanged' }; // 值未变不写（也不再判定）
      }

      const nextStreamer = { ...streamers[index], [field]: value };
      const nextStreamers = streamers.slice();
      nextStreamers[index] = nextStreamer;
      await this._storage.set({ streamers: nextStreamers });

      const room = rooms.find(r => (r.platform || 'douyu') === platform && RoomStore._sameRoomId(r.roomId, roomId));
      return {
        changed: true,
        matched: true,
        platform,
        roomId: String(roomId),
        prevValue,
        nextValue: value,
        room: room ? roomStoreView(room) : undefined,
        streamer: roomStoreView(nextStreamer),
        settings: roomStoreView(RoomStore._resolvedSettings(settings))
      };
    });
  }

  /**
   * 平台观众数开关与实际存储对齐：按开关清理已关闭平台的观众数字段（幂等），
   * 并回传「该平台有没有房间」「该平台观众数开关开没开」两个事实（桥接通道的通道决策要用）。
   * 收编了原 background 的 pruneStaleViewerCounts 与桥接通道的 _stripRankCounts。
   * @returns {Promise<{changed: boolean, viewerFetch: object, hasPlatform: object, cleared: string[]}>}
   */
  async reconcileViewerGates() {
    return this._enqueue(async () => {
      const { rooms, streamers, settings } = await this._readRaw();
      const viewerFetch = {};
      const hasPlatform = {};
      for (const platform of ROOM_STORE_PLATFORMS) {
        viewerFetch[platform] = RoomStore._isViewerFetchEnabled(settings, platform);
        hasPlatform[platform] = rooms.some(room => (room.platform || 'douyu') === platform);
      }
      const offFields = ROOM_STORE_PLATFORMS
        .filter(platform => !viewerFetch[platform])
        .map(platform => ROOM_STORE_VIEWER_FIELD[platform]);

      const cleared = [];
      let changed = false;
      const nextStreamers = streamers.map(streamer => {
        if (!offFields.some(field => field in streamer)) return streamer;
        changed = true;
        const copy = { ...streamer };
        for (const field of offFields) delete copy[field];
        cleared.push(RoomStore._key(streamer.platform || 'douyu', streamer.roomId));
        return copy;
      });
      if (changed) await this._storage.set({ streamers: nextStreamers });

      return {
        changed,
        viewerFetch,
        hasPlatform,
        cleared
      };
    });
  }

  /**
   * 设置变更（页面经 PATCH_SETTINGS 发来）：只认识的键落盘，布尔键只收布尔，
   * refreshInterval 钳到下限；写入任一平台观众数开关即删旧总开关 fetchViewerCount；
   * 关闭某平台的观众数开关时，同一次写入里清掉该平台的观众数字段。
   * @param {object} patch 只改给出的键
   * @returns {Promise<{changed: boolean, settings: object, pruned: string[]}>}
   */
  async patchSettings(patch = {}) {
    return this._enqueue(async () => {
      const { streamers, settings } = await this._readRaw();
      const next = { ...settings };
      let changed = false;
      let wroteViewerToggle = false;

      for (const [key, value] of Object.entries(patch || {})) {
        if (!ROOM_STORE_SETTINGS_KEYS.includes(key)) continue; // 未知键忽略
        if (key === 'refreshInterval') {
          const parsed = Math.trunc(Number(value));
          if (!Number.isFinite(parsed)) continue; // 非法值忽略，不把无效输入变成一次重置
          const interval = Math.max(ROOM_STORE_MIN_REFRESH_INTERVAL, parsed);
          if (interval === next[key]) continue;
          next[key] = interval;
          changed = true;
          continue;
        }
        if (typeof value !== 'boolean') continue;
        if (ROOM_STORE_VIEWER_TOGGLE_KEYS.includes(key)) wroteViewerToggle = true;
        if (next[key] === value) continue;
        next[key] = value;
        changed = true;
      }
      if (wroteViewerToggle && 'fetchViewerCount' in next) {
        delete next.fetchViewerCount; // 新字段已写入，旧总开关作废
        changed = true;
      }

      // 关闭平台观众数开关 → 同一次写入里清掉该平台字段（避免 popup 显示关闭前的残留）
      const offFields = ROOM_STORE_PLATFORMS
        .filter(platform => !RoomStore._isViewerFetchEnabled(next, platform))
        .map(platform => ROOM_STORE_VIEWER_FIELD[platform]);
      const pruned = [];
      let nextStreamers = streamers;
      if (offFields.length > 0) {
        nextStreamers = streamers.map(streamer => {
          if (!offFields.some(field => field in streamer)) return streamer;
          const copy = { ...streamer };
          for (const field of offFields) delete copy[field];
          pruned.push(RoomStore._key(streamer.platform || 'douyu', streamer.roomId));
          return copy;
        });
        if (pruned.length > 0) changed = true;
      }
      if (!changed) {
        return { changed: false, settings: roomStoreView(RoomStore._resolvedSettings(settings)), pruned: [] };
      }
      await this._storage.set({ settings: next, streamers: nextStreamers });
      return { changed: true, settings: roomStoreView(RoomStore._resolvedSettings(next)), pruned };
    });
  }

  /**
   * 单房配置变更（页面行内面板）：浅合并该房条目。
   * undefined 不改、null 删字段、未给出的字段保留（含尚未认识的 per-room 字段）。
   * 检测词/阈值的归一化不在此（留在 lib/danmaku-watch.js、lib/viewer-alert.js 两个纯模块）。
   * @param {{platform: string, roomId: string}} ref
   * @param {object} patch
   * @returns {Promise<{ok: true, changed: boolean, room: object} | {ok: false, reason: string}>}
   */
  async patchRoomConfig({ platform, roomId } = {}, patch = {}) {
    if (!roomId || !platform) return { ok: false, reason: 'invalid-ref' };
    if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid-patch' };

    return this._enqueue(async () => {
      const { rooms } = await this._readRaw();
      const index = rooms.findIndex(r => (r.platform || 'douyu') === platform && RoomStore._sameRoomId(r.roomId, roomId));
      if (index === -1) return { ok: false, reason: 'not-found' };

      const next = { ...rooms[index] };
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value === null) {
          if (key in next) {
            delete next[key];
            changed = true;
          }
          continue;
        }
        if (roomStoreSameValue(next[key], value)) continue;
        next[key] = value;
        changed = true;
      }
      if (!changed) return { ok: true, changed: false, room: roomStoreView(next) };

      const nextRooms = rooms.slice();
      nextRooms[index] = next;
      await this._storage.set({ rooms: nextRooms });
      return { ok: true, changed: true, room: roomStoreView(next) };
    });
  }

  /**
   * 新增房间：纯数字校验 → 昵称解析（临界区外，唯一触网的一步）→ 所选平台解析失败自动换另一平台
   * 兜底 → 临界区内重查重复后写入。
   * @param {{roomId: string, platform: string}} params
   * @returns {Promise<{ok: true, room: object} | {ok: false, error: string}>}
   */
  async addRoom({ roomId, platform } = {}) {
    const id = String(roomId ?? '').trim();
    if (!/^\d+$/.test(id)) return { ok: false, error: '房间号格式无效' };

    const first = ROOM_STORE_PLATFORMS.includes(platform) ? platform : 'douyu';

    // 预检重复：明显的重复不必白跑一次平台解析（临界区内还会再查一次，那次才是权威）
    const existing = await this._readRaw();
    if (existing.rooms.some(room => (room.platform || 'douyu') === first && RoomStore._sameRoomId(room.roomId, id))) {
      return { ok: false, error: '该房间已在监控列表中' };
    }

    let target = first;
    let resolved = await this._resolveNickname(first, id);
    if (!resolved || resolved.ok !== true) {
      const other = ROOM_STORE_PLATFORMS.find(p => p !== first);
      const fallback = await this._resolveNickname(other, id);
      if (fallback && fallback.ok === true) {
        target = other;
        resolved = fallback;
      }
    }
    if (!resolved || resolved.ok !== true) return { ok: false, error: '房间号不存在或无法访问' };

    return this._enqueue(async () => {
      const { rooms } = await this._readRaw();
      if (rooms.some(room => (room.platform || 'douyu') === target && RoomStore._sameRoomId(room.roomId, id))) {
        return { ok: false, error: '该房间已在监控列表中' };
      }
      const room = { roomId: id, nickname: resolved.nickname, platform: target, notify: false };
      await this._storage.set({ rooms: rooms.concat([room]) });
      return { ok: true, room: roomStoreView(room) };
    });
  }

  /**
   * 移除房间：rooms 与主播快照在同一次写入里删净（不留孤儿）。
   * @param {{platform: string, roomId: string}} ref
   * @returns {Promise<{removed: boolean}>}
   */
  async removeRoom({ platform, roomId } = {}) {
    if (!roomId || !platform) return { removed: false };
    return this._enqueue(async () => {
      const { rooms, streamers } = await this._readRaw();
      const hit = room => (room.platform || 'douyu') === platform && RoomStore._sameRoomId(room.roomId, roomId);
      const nextRooms = rooms.filter(room => !hit(room));
      const nextStreamers = streamers.filter(streamer => !hit(streamer));
      if (nextRooms.length === rooms.length && nextStreamers.length === streamers.length) {
        return { removed: false };
      }
      await this._storage.set({ rooms: nextRooms, streamers: nextStreamers });
      return { removed: true };
    });
  }

  /**
   * 房间重排（拖拽排序）：order 是目标顺序的房间引用列表（只发身份，不发数据）。
   * 未列出的房间按原相对顺序接尾（不丢房间）、未知引用忽略、重复折叠；主播快照同步重排，
   * 缺条目的房间补 { online: false } 等下一轮填充，多出的条目随 rooms 消失。
   * @param {Array<{platform: string, roomId: string}>} order
   * @returns {Promise<{ok: boolean, changed?: boolean, rooms?: Array, reason?: string}>}
   */
  async reorderRooms(order) {
    if (!Array.isArray(order)) return { ok: false, reason: 'invalid-order' };
    return this._enqueue(async () => {
      const { rooms, streamers } = await this._readRaw();
      if (rooms.length === 0) return { ok: true, changed: false, rooms: [] };

      const byKey = new Map(rooms.map(room => [RoomStore._key(room.platform || 'douyu', room.roomId), room]));
      const ordered = [];
      const seen = new Set();
      for (const ref of order) {
        if (!ref || !ROOM_STORE_PLATFORMS.includes(ref.platform)) continue;
        const key = RoomStore._key(ref.platform, ref.roomId);
        if (!byKey.has(key) || seen.has(key)) continue;
        seen.add(key);
        ordered.push(byKey.get(key));
      }
      for (const room of rooms) {
        const key = RoomStore._key(room.platform || 'douyu', room.roomId);
        if (seen.has(key)) continue;
        seen.add(key);
        ordered.push(room);
      }
      const changed = ordered.some((room, i) => room !== rooms[i]);
      if (!changed) return { ok: true, changed: false, rooms: roomStoreView(rooms) };

      const streamerByKey = new Map(streamers.map(s => [RoomStore._key(s.platform || 'douyu', s.roomId), s]));
      const nextStreamers = ordered.map(room => {
        const platform = room.platform || 'douyu';
        return streamerByKey.get(RoomStore._key(platform, room.roomId)) ||
          { roomId: String(room.roomId), platform, online: false };
      });
      await this._storage.set({ rooms: ordered, streamers: nextStreamers });
      return { ok: true, changed: true, rooms: roomStoreView(ordered) };
    });
  }

  /**
   * 初始化（onInstalled 时调用一次，幂等）：三个键俱缺时写入默认值；旧格式（无 platform 字段）
   * 的 rooms / streamers 迁移为 douyu。`notifiedRooms` 的旧 string[] 格式不归房间库，由编排迁移。
   * @returns {Promise<{migrated: boolean, seeded: boolean}>}
   */
  async init() {
    return this._enqueue(async () => {
      const raw = (await this._storage.get(['rooms', 'streamers', 'settings'])) || {};
      const seeded = raw.rooms === undefined && raw.streamers === undefined && raw.settings === undefined;
      const patch = {};
      let migrated = false;

      // 旧格式（无 platform 字段）迁移为 douyu：只有真的改了才落盘（幂等）
      const migrateList = list => {
        if (!Array.isArray(list)) return null;
        let changed = false;
        const next = list.map(item => {
          if (item && typeof item === 'object' && item.roomId && !item.platform) {
            changed = true;
            return { ...item, platform: 'douyu' };
          }
          return item;
        });
        return changed ? next : null;
      };
      const rooms = migrateList(raw.rooms);
      const streamers = migrateList(raw.streamers);
      if (rooms) {
        patch.rooms = rooms;
        migrated = true;
      }
      if (streamers) {
        patch.streamers = streamers;
        migrated = true;
      }

      if (seeded) Object.assign(patch, roomStoreClone(ROOM_STORE_DEFAULTS));
      if (Object.keys(patch).length > 0) await this._storage.set(patch);
      return { migrated, seeded };
    });
  }

  // === 内部 ===

  /** 一次取出三个键（缺键按空值处理，读侧兜底不写） */
  async _readRaw() {
    const raw = (await this._storage.get(['rooms', 'streamers', 'settings'])) || {};
    return {
      rooms: Array.isArray(raw.rooms) ? raw.rooms : [],
      streamers: Array.isArray(raw.streamers) ? raw.streamers : [],
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
    };
  }

  /** FIFO 串行队列：前一次操作失败不毒化队列 */
  _enqueue(task) {
    const run = this._queue.then(task, task);
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  static _key(platform, roomId) {
    return `${platform}_${roomId}`;
  }

  static _sameRoomId(a, b) {
    return String(a) === String(b);
  }

  static _onlineCount(streamers) {
    return streamers.filter(s => s.online).length;
  }

  /** 平台观众数开关：新字段优先，未写入时回退旧总开关语义（字段不存在视为开启） */
  static _isViewerFetchEnabled(settings, platform) {
    const toggle = ROOM_STORE_VIEWER_TOGGLE[platform];
    if (!toggle) return true;
    if (settings && settings[toggle] !== undefined) return settings[toggle] !== false;
    return !settings || settings.fetchViewerCount !== false;
  }

  /** 快照里的 settings：补默认值、解算平台开关为布尔、去掉旧总开关（页面拿到即用） */
  static _resolvedSettings(settings) {
    const resolved = { ...ROOM_STORE_DEFAULTS.settings, ...(settings || {}) };
    for (const platform of ROOM_STORE_PLATFORMS) {
      resolved[ROOM_STORE_VIEWER_TOGGLE[platform]] = RoomStore._isViewerFetchEnabled(settings, platform);
    }
    delete resolved.fetchViewerCount;
    return resolved;
  }
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RoomStore, ROOM_STORE_DEFAULTS };
}
