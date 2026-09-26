// lib/room-store.js — 房间库：rooms / streamers / settings / categories 四个键的形状与全部变更
//
// 单写者（见 docs/adr/0003-room-store-single-writer.md）：这四个键的所有写入只发生在房间库内。
// 页面的变更请求经 SW 消息到达这里（PATCH_SETTINGS / PATCH_ROOM_CONFIG / REORDER_ROOMS /
// ADD_ROOM / REMOVE_ROOM，以及分类的 ADD_CATEGORY / RENAME_CATEGORY / REMOVE_CATEGORY /
// REORDER_CATEGORIES / SET_ROOM_CATEGORY），读取走 snapshot() 的只读快照。`notifiedRooms` /
// `_firstRun` / `lastRefresh` / `watchQueued` / `biliPageChannelEnabled` 不归房间库，由编排、
// 盯守与桥接通道各自持有。
//
// 三条纪律：
// - 意图式变更：操作只接受意图（「记录 douyu_100 的贵宾数为 5000」），内部重新读改写；
//   绝不接受调用者把快照传回来当写依据——那会把丢更新原样请回来。
// - 无内存缓存：每次操作在自己的临界区里读改写，原子性由模块内的 FIFO 串行队列保证；
//   队列内禁止 await 网络（值到达约 6 秒一次，不能被一次慢轮询堵住）。
// - 报告转变、不发通知：合并与值到达只回传开播边沿与前后值，通知与阈值判定留在编排
//   与三个纯规则模块（lib/viewer-alert.js、lib/danmaku-watch.js、lib/danmaku-surge.js）。
//
// 注入依赖：storage({ get(keys), set(entries) })、resolveNickname(platform, roomId) -> {ok, nickname}、
// identity（房间标识 module，lib/room-identity.js，见 CONTEXT.md：复合键 / 房间号校验 / 平台事实）、
// categoryRules（分类规则 module，lib/room-categories.js：名称校验 / 「未分类」保留名 / 分组回落）。
// 生产 adapter = chrome.storage.local + 两个平台 API；测试 adapter = 内存对象 + 脚本化假解析。
// UMD 双兼容：SW 经 importScripts 加载，设置页/弹窗作普通 script，node 下可 require。
// 错误模型：入口对畸形输入返回 reason 码而不抛（调用方是消息通道与弹幕推送），只有构造时缺少
// storage port、identity port 或 categoryRules port 才抛。

// 四个键的默认值：本文件是它们形状的唯一来源（lib/storage.js 只留 chrome 适配）
const ROOM_STORE_DEFAULTS = {
  // rooms[].watch 为可选的弹幕检测配置 { enabled, keywords[], threshold, windowMinutes, cooldownMinutes }，
  // rooms[].viewerAlert 为可选的观众数提醒配置 { enabled, threshold }，
  // rooms[].surgeAlert 为可选的弹幕激增提醒开关（纯布尔，无 per-room 参数），
  // rooms[].highlightAlert 为可选的看点通知开关（纯布尔，无 per-room 参数，默认关），
  // rooms[].categoryId 为可选的分类归属（缺字段或为空即「未分类」）；缺字段视为未配置
  rooms: [],   // { roomId, nickname, platform, notify?: boolean, watch?: object, viewerAlert?: object, surgeAlert?: boolean, highlightAlert?: boolean, categoryId?: string }
  streamers: [],
  // categories 是分类一等实体：{ id, name } 列表，数组顺序即分类顺序（见 ADR-0008）。
  // id 由房间库生成、不暴露给用户，「空值」专门表示未分类；分类名唯一、trim 后非空、不得等于「未分类」
  categories: [],
  settings: {
    refreshInterval: 60,
    notificationsEnabled: true,
    viewerAlertEnabled: true,
    // 弹幕激增的四个判定参数是全局的（per-room 只有一个布尔开关）
    surgeAlertEnabled: true,
    surgeMultiple: 3,
    surgeMinBaseline: 3,
    surgeCooldownMinutes: 30,
    surgeMinBuckets: 10,
    highlightAlertEnabled: true,
    // 今日统计（第三方数据站 doseeing 的当日累计，只读展示不通知，见 ADR-0007）
    todayStatsEnabled: true,
    openInCurrentTab: false,
    // 观众数开关按平台拆分：新字段优先，未写入时回退旧总开关 fetchViewerCount 语义
    fetchDouyuViewerCount: true,
    fetchBilibiliViewerCount: true,
    fetchViewerCount: true   // 旧总开关（读取兼容回退，写入任一新字段时删除）
  }
};

// 平台 → 观众数字段 / 观众数开关键 / 平台列表都不在此：那是房间标识 module 的事实
// （lib/room-identity.js），本文件经注入的 identity 查询，见 CONTEXT.md「房间标识」。
// 加平台要在那张表里加一行，不在本文件里。

// settings 允许写入的键（房间库拥有形状：未知键忽略，避免错字悄悄落盘）
const ROOM_STORE_SETTINGS_KEYS = [
  'refreshInterval',
  'notificationsEnabled',
  'danmakuWatchEnabled',
  'viewerAlertEnabled',
  'surgeAlertEnabled',
  'surgeMultiple',
  'surgeMinBaseline',
  'surgeCooldownMinutes',
  'surgeMinBuckets',
  'highlightAlertEnabled',
  'todayStatsEnabled',
  'openInCurrentTab',
  'fetchDouyuViewerCount',
  'fetchBilibiliViewerCount'
];

// 轮询间隔下限（分钟）：小于 1 分钟的轮询会撞平台限流
const ROOM_STORE_MIN_REFRESH_INTERVAL = 60;

// 四个激增数值参数的范围与小数位（倍数支持一位小数）。与 lib/danmaku-surge.js 的 SURGE_LIMITS 一致：
// 判定侧还会再归一化一次，这里钳制是为了让落盘的值与用户看到的值一致（与 refreshInterval 同一套做法）。
// 本文件不依赖其他 lib 的加载顺序，故范围在此各自持有。冷启动桶数的上限即每房保留的桶数（30）：
// 设得比窗口还大就永远攒不够，等于把功能关掉。
const ROOM_STORE_SURGE_LIMITS = {
  surgeMultiple: { range: [1.1, 10], decimals: 1 },
  surgeMinBaseline: { range: [1, 999], decimals: 0 },
  surgeCooldownMinutes: { range: [1, 180], decimals: 0 },
  surgeMinBuckets: { range: [2, 30], decimals: 0 }
};

/**
 * 解析数值并按 decimals 位小数截断后钳制到 range（decimals 为 0 即取整）。
 * 非法值返回 null——调用方忽略这次写入，不把无效输入变成一次重置。
 */
function roomStoreClampNumber(value, { range: [min, max], decimals }) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.min(max, Math.max(min, Math.trunc(num * factor) / factor));
}

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

/** 旧格式（条目缺 platform）的读侧兜底：只此一处，下游直接读条目上的 platform */
function roomStoreWithPlatform(list, fallback) {
  return list.map(item => (item && typeof item === 'object' && !item.platform ? { ...item, platform: fallback } : item));
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
   * @param {object} options.identity 房间标识 module（lib/room-identity.js）：复合键 / 房间号校验 / 平台事实
   * @param {object} options.categoryRules 分类规则 module（lib/room-categories.js）：名称校验 / 分组回落
   */
  constructor({ storage, resolveNickname, identity, categoryRules } = {}) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new TypeError('RoomStore 需要 storage port：{ get(keys), set(entries) }');
    }
    if (!identity) {
      throw new TypeError('RoomStore 需要 identity port：房间标识 module（lib/room-identity.js）');
    }
    if (!categoryRules) {
      throw new TypeError('RoomStore 需要 categoryRules port：分类规则 module（lib/room-categories.js）');
    }
    this._storage = storage;
    this._identity = identity;
    this._categoryRules = categoryRules;
    this._resolveNickname = typeof resolveNickname === 'function' ? resolveNickname : async () => ({ ok: false });
    this._queue = Promise.resolve(); // FIFO 串行队列：同一时刻只有一个操作在临界区
  }

  /** 默认值（装配线首启写入用；测试直接导入，不再手抄） */
  static get DEFAULTS() {
    return ROOM_STORE_DEFAULTS;
  }

  // === 读 ===

  /**
   * 只读快照：一次存储往返拿到四个键，缺键补默认值。
   * - rooms 每项附加 online（true/false；无对应主播快照时为 undefined）；platform 由读取入口补齐（见 _readRaw）
   * - categories 是分类列表（数组顺序即分类顺序）；老安装没有这个键时回退空数组（读侧回退，不重写用户数据）
   * - settings 已解算平台观众数开关（恒为布尔），旧总开关 fetchViewerCount 不出现在快照里
   * @returns {Promise<{rooms: Array, streamers: Array, categories: Array, settings: object}>} 深冻结
   */
  async snapshot() {
    const { rooms, streamers, categories, settings } = await this._readRaw();
    const onlineByKey = new Map();
    for (const s of streamers) {
      onlineByKey.set(this._key(s.platform, s.roomId), s.online === true);
    }
    const roomViews = rooms.map(room => {
      const view = { ...room };
      const online = onlineByKey.get(this._key(room.platform, room.roomId));
      if (online !== undefined) view.online = online;
      return view;
    });
    return roomStoreView({ rooms: roomViews, streamers, categories, settings: this._resolvedSettings(settings) });
  }

  /**
   * 观众数采样计划：按平台分组的房间号 + 该平台的观众数开关（采样分支据此选择是否派发）。
   * @returns {Promise<{douyu: {enabled: boolean, roomIds: string[]}, bilibili: {enabled: boolean, roomIds: string[]}}>}
   */
  async viewerSamplePlan() {
    const { rooms, settings } = await this._readRaw();
    const plan = {};
    for (const platform of this._identity.PLATFORM_IDS) {
      plan[platform] = {
        enabled: this._isViewerFetchEnabled(settings, platform),
        roomIds: rooms
          .filter(room => room.platform === platform)
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
        const key = this._key(streamer.platform, streamer.roomId);
        prevByKey.set(key, streamer);
        if (streamer.online) prevOnline.add(key);
      }

      // 平台返回的房间按复合键索引（只有本轮成功的平台才进表）
      const fresh = new Map();
      for (const platform of this._identity.PLATFORM_IDS) {
        const result = results[platform];
        if (!result || result.success !== true || !Array.isArray(result.data)) continue;
        for (const item of result.data) {
          fresh.set(this._key(platform, item.roomId), { ...item, platform });
        }
      }

      const merged = [];
      const wentLive = [];
      for (const room of rooms) {
        const key = this._key(room.platform, room.roomId);
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
    const field = this._identity.viewerField(platform);
    if (!field) return { changed: false, matched: false, reason: 'unknown-platform' };
    if (!Number.isFinite(value)) return { changed: false, matched: false, reason: 'invalid-value' };

    return this._enqueue(async () => {
      const { rooms, streamers, settings } = await this._readRaw();
      if (!this._isViewerFetchEnabled(settings, platform)) {
        return { changed: false, matched: false, reason: 'gate-off' };
      }
      const index = streamers.findIndex(s => s.platform === platform && this._sameRoomId(s.roomId, roomId));
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

      const room = rooms.find(r => r.platform === platform && this._sameRoomId(r.roomId, roomId));
      return {
        changed: true,
        matched: true,
        platform,
        roomId: String(roomId),
        prevValue,
        nextValue: value,
        room: room ? roomStoreView(room) : undefined,
        streamer: roomStoreView(nextStreamer),
        settings: roomStoreView(this._resolvedSettings(settings))
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
      for (const platform of this._identity.PLATFORM_IDS) {
        viewerFetch[platform] = this._isViewerFetchEnabled(settings, platform);
        hasPlatform[platform] = rooms.some(room => room.platform === platform);
      }
      const offFields = this._offViewerFields(settings);

      const cleared = [];
      let changed = false;
      const nextStreamers = streamers.map(streamer => {
        if (!offFields.some(field => field in streamer)) return streamer;
        changed = true;
        const copy = { ...streamer };
        for (const field of offFields) delete copy[field];
        cleared.push(this._key(streamer.platform, streamer.roomId));
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
   * refreshInterval 与四个激增数值参数钳到各自范围；写入任一平台观众数开关即删旧总开关
   * fetchViewerCount；关闭某平台的观众数开关时，同一次写入里清掉该平台的观众数字段。
   * @param {object} patch 只改给出的键
   * @returns {Promise<{changed: boolean, settings: object, pruned: string[]}>}
   */
  async patchSettings(patch = {}) {
    return this._enqueue(async () => {
      const { streamers, settings } = await this._readRaw();
      const next = { ...settings };
      let changed = false;
      let wroteViewerToggle = false;
      const viewerToggleKeys = this._identity.PLATFORM_IDS.map(platform => this._identity.viewerToggle(platform));

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
        const surgeLimit = ROOM_STORE_SURGE_LIMITS[key];
        if (surgeLimit) {
          const clamped = roomStoreClampNumber(value, surgeLimit);
          if (clamped === null || clamped === next[key]) continue;
          next[key] = clamped;
          changed = true;
          continue;
        }
        if (typeof value !== 'boolean') continue;
        if (viewerToggleKeys.includes(key)) wroteViewerToggle = true;
        if (next[key] === value) continue;
        next[key] = value;
        changed = true;
      }
      if (wroteViewerToggle && 'fetchViewerCount' in next) {
        delete next.fetchViewerCount; // 新字段已写入，旧总开关作废
        changed = true;
      }

      // 关闭平台观众数开关 → 同一次写入里清掉该平台字段（避免 popup 显示关闭前的残留）
      const offFields = this._offViewerFields(next);
      const pruned = [];
      let nextStreamers = streamers;
      if (offFields.length > 0) {
        nextStreamers = streamers.map(streamer => {
          if (!offFields.some(field => field in streamer)) return streamer;
          const copy = { ...streamer };
          for (const field of offFields) delete copy[field];
          pruned.push(this._key(streamer.platform, streamer.roomId));
          return copy;
        });
        if (pruned.length > 0) changed = true;
      }
      if (!changed) {
        return { changed: false, settings: roomStoreView(this._resolvedSettings(settings)), pruned: [] };
      }
      await this._storage.set({ settings: next, streamers: nextStreamers });
      return { changed: true, settings: roomStoreView(this._resolvedSettings(next)), pruned };
    });
  }

  /**
   * 单房配置变更（页面行内面板）：浅合并该房条目。
   * undefined 不改、null 删字段、未给出的字段保留（含尚未认识的 per-room 字段）。
   * 检测词/阈值/激增开关的归一化不在此（检测与激增留在 lib/danmaku-watch.js、
   * lib/viewer-alert.js、lib/danmaku-surge.js 三个纯模块；rooms[].surgeAlert 是纯布尔，无需归一化）。
   * @param {{platform: string, roomId: string}} ref
   * @param {object} patch
   * @returns {Promise<{ok: true, changed: boolean, room: object} | {ok: false, reason: string}>}
   */
  async patchRoomConfig({ platform, roomId } = {}, patch = {}) {
    if (!roomId || !platform) return { ok: false, reason: 'invalid-ref' };
    if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid-patch' };

    return this._enqueue(async () => {
      const { rooms } = await this._readRaw();
      const index = rooms.findIndex(r => r.platform === platform && this._sameRoomId(r.roomId, roomId));
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
   * 新增房间：房间号校验与平台校验 → 昵称解析（临界区外，唯一触网的一步）→ 所选平台解析失败自动
   * 换另一平台兜底 → 临界区内重查重复后写入。
   * 未知平台显式拒绝（不静默当成斗鱼），与「房间号格式无效」同一处、同样在解析昵称之前。
   * 新房间追加到 rooms 末尾（即所属分组末尾）；分类 id 查不到时回落未分类（绝不因此拒绝添加）。
   * @param {{roomId: string, platform: string, categoryId?: string}} params
   * @returns {Promise<{ok: true, room: object} | {ok: false, error: string}>}
   */
  async addRoom({ roomId, platform, categoryId } = {}) {
    const id = String(roomId ?? '').trim();
    if (!this._identity.isRoomId(id)) return { ok: false, error: '房间号格式无效' };
    if (!this._identity.isPlatform(platform)) return { ok: false, error: '不支持的平台' };

    const first = platform;

    // 预检重复：明显的重复不必白跑一次平台解析（临界区内还会再查一次，那次才是权威）
    const existing = await this._readRaw();
    if (existing.rooms.some(room => room.platform === first && this._sameRoomId(room.roomId, id))) {
      return { ok: false, error: '该房间已在监控列表中' };
    }

    let target = first;
    let resolved = await this._resolveNickname(first, id);
    if (!resolved || resolved.ok !== true) {
      const other = this._identity.PLATFORM_IDS.find(p => p !== first);
      const fallback = await this._resolveNickname(other, id);
      if (fallback && fallback.ok === true) {
        target = other;
        resolved = fallback;
      }
    }
    if (!resolved || resolved.ok !== true) return { ok: false, error: '房间号不存在或无法访问' };

    return this._enqueue(async () => {
      const { rooms, categories } = await this._readRaw();
      if (rooms.some(room => room.platform === target && this._sameRoomId(room.roomId, id))) {
        return { ok: false, error: '该房间已在监控列表中' };
      }
      const room = { roomId: id, nickname: resolved.nickname, platform: target, notify: false };
      const group = this._categoryRules.groupOf(categoryId, categories);
      if (group) room.categoryId = group;
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
      const hit = room => room.platform === platform && this._sameRoomId(room.roomId, roomId);
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
   * 房间重排（拖拽排序）：order 是目标顺序的房间引用列表（只发身份，不发数据），categoryId 指
   * 这次重排发生在哪个分组内（空值即未分类）。分类内各自一份顺序，因此只置换该分类成员所占的槽位，
   * 其余分类的相对顺序不动（见 ADR-0008 第四条）。
   *
   * 语义照旧：未列出的房间按原相对顺序接尾（不丢房间）、未知引用忽略（含属于别的分类的引用）、
   * 重复折叠；主播快照同步重排，缺条目的房间补 { online: false } 等下一轮填充，多出的条目随 rooms 消失。
   * 目标分组在分类列表里查不到时回落未分类——绝不让一次拖拽丢掉或错排房间。
   * @param {{categoryId?: string, order: Array<{platform: string, roomId: string}>}} params
   * @returns {Promise<{ok: boolean, changed?: boolean, rooms?: Array, reason?: string}>}
   */
  async reorderRooms({ categoryId, order } = {}) {
    if (!Array.isArray(order)) return { ok: false, reason: 'invalid-order' };
    return this._enqueue(async () => {
      const { rooms, streamers, categories } = await this._readRaw();
      if (rooms.length === 0) return { ok: true, changed: false, rooms: [] };

      const target = this._categoryRules.groupOf(categoryId, categories);
      const slots = [];
      for (let i = 0; i < rooms.length; i++) {
        if (this._categoryRules.groupOf(rooms[i].categoryId, categories) === target) slots.push(i);
      }
      if (slots.length === 0) return { ok: true, changed: false, rooms: roomStoreView(rooms) };

      const byKey = new Map(slots.map(i => [this._key(rooms[i].platform, rooms[i].roomId), rooms[i]]));
      const ordered = [];
      const seen = new Set();
      for (const ref of order) {
        if (!ref || !this._identity.isPlatform(ref.platform)) continue;
        const key = this._key(ref.platform, ref.roomId);
        if (!byKey.has(key) || seen.has(key)) continue;
        seen.add(key);
        ordered.push(byKey.get(key));
      }
      for (const i of slots) {
        const room = rooms[i];
        const key = this._key(room.platform, room.roomId);
        if (seen.has(key)) continue;
        seen.add(key);
        ordered.push(room);
      }

      const nextRooms = rooms.slice();
      slots.forEach((slot, i) => { nextRooms[slot] = ordered[i]; });
      const changed = nextRooms.some((room, i) => room !== rooms[i]);
      if (!changed) return { ok: true, changed: false, rooms: roomStoreView(rooms) };

      const streamerByKey = new Map(streamers.map(s => [this._key(s.platform, s.roomId), s]));
      const nextStreamers = nextRooms.map(room => {
        return streamerByKey.get(this._key(room.platform, room.roomId)) ||
          { roomId: String(room.roomId), platform: room.platform, online: false };
      });
      await this._storage.set({ rooms: nextRooms, streamers: nextStreamers });
      return { ok: true, changed: true, rooms: roomStoreView(nextRooms) };
    });
  }

  // === 分类（一等实体：单独一份列表，房间只记 categoryId；见 ADR-0008）===

  /**
   * 新建分类：名称校验（trim / 非空 / 上限 / 唯一 / 不等于保留名「未分类」）后追加到分类列表末尾
   * （分类顺序 = 列表顺序）。分类 id 由房间库生成、不暴露给用户——保留空值专门表示未分类。
   * @param {string} name 用户输入的分类名
   * @returns {Promise<{ok: true, changed: true, category: {id: string, name: string}} | {ok: false, error: string}>}
   */
  async addCategory(name) {
    return this._enqueue(async () => {
      const { categories } = await this._readRaw();
      const validated = this._categoryRules.validateName(name, categories);
      if (!validated.ok) return { ok: false, error: validated.error };
      const category = { id: this._nextCategoryId(categories), name: validated.name };
      await this._storage.set({ categories: categories.concat([category]) });
      return { ok: true, changed: true, category: roomStoreView(category) };
    });
  }

  /**
   * 分类改名：一次生效（房间只存 id，不必批量扫房间）。重名校验排除自身；改成同名不算变更、不写盘。
   * @param {string} id 分类 id
   * @param {string} name 新名字
   * @returns {Promise<{ok: true, changed: boolean, category: object} | {ok: false, error: string}>}
   */
  async renameCategory(id, name) {
    const target = String(id ?? '');
    return this._enqueue(async () => {
      const { categories } = await this._readRaw();
      const index = categories.findIndex(c => c && String(c.id) === target);
      if (index === -1) return { ok: false, error: '分类不存在' };
      const validated = this._categoryRules.validateName(name, categories, { excludeId: target });
      if (!validated.ok) return { ok: false, error: validated.error };
      if (categories[index].name === validated.name) {
        return { ok: true, changed: false, category: roomStoreView(categories[index]) };
      }
      const next = categories.slice();
      next[index] = { ...categories[index], name: validated.name };
      await this._storage.set({ categories: next });
      return { ok: true, changed: true, category: roomStoreView(next[index]) };
    });
  }

  /**
   * 删除分类：分类列表去掉它，同一次写入里清掉其下房间的 categoryId（房间本体不删，回落未分类）。
   * 回落未分类的房间按原相对顺序接在未分类分组末尾（落点规则统一：追加到目标分组末尾）。
   * 分类不存在时幂等成功、不写盘、affected 为 0。
   * @param {string} id 分类 id
   * @returns {Promise<{ok: true, changed: boolean, affected: number}>} affected = 回落到未分类的房间数
   */
  async removeCategory(id) {
    const target = String(id ?? '');
    if (!target) return { ok: true, changed: false, affected: 0 };
    return this._enqueue(async () => {
      const { rooms, categories } = await this._readRaw();
      const index = categories.findIndex(c => c && String(c.id) === target);
      if (index === -1) return { ok: true, changed: false, affected: 0 };

      const nextCategories = categories.slice();
      nextCategories.splice(index, 1);

      const kept = [];
      const moved = [];
      for (const room of rooms) {
        if (room && String(room.categoryId ?? '') === target) {
          const copy = { ...room };
          delete copy.categoryId;
          moved.push(copy);
        } else {
          kept.push(room);
        }
      }

      const patch = { categories: nextCategories };
      if (moved.length > 0) patch.rooms = kept.concat(moved); // 与分类列表同一次写入
      await this._storage.set(patch);
      return { ok: true, changed: true, affected: moved.length };
    });
  }

  /**
   * 分类重排（拖拽分类标题）：order 是目标顺序的分类 id 列表。
   * 未列出的分类按原相对顺序接尾、未知引用忽略、重复折叠（照 reorderRooms 的三条语义）。
   * 「未分类」不在这份列表里，因此拖不动、也不会被排到后面。
   * @param {string[]} order 分类 id 列表
   * @returns {Promise<{ok: boolean, changed?: boolean, reason?: string}>}
   */
  async reorderCategories(order) {
    if (!Array.isArray(order)) return { ok: false, reason: 'invalid-order' };
    return this._enqueue(async () => {
      const { categories } = await this._readRaw();
      if (categories.length === 0) return { ok: true, changed: false };

      const byId = new Map(categories.map(c => [String(c.id), c]));
      const ordered = [];
      const seen = new Set();
      for (const ref of order) {
        const id = String(ref ?? '');
        if (!id || !byId.has(id) || seen.has(id)) continue;
        seen.add(id);
        ordered.push(byId.get(id));
      }
      for (const category of categories) {
        const id = String(category.id);
        if (seen.has(id)) continue;
        seen.add(id);
        ordered.push(category);
      }

      const changed = ordered.some((category, i) => category !== categories[i]);
      if (!changed) return { ok: true, changed: false };
      await this._storage.set({ categories: ordered });
      return { ok: true, changed: true };
    });
  }

  /**
   * 设置某房间的分类（归类）：分类 id 为空或查不到时回落未分类。换分组后追加到目标分组末尾
   * （落点规则统一），已经在该分组里则不算变更、不写盘（不借机重排）。
   * @param {{platform: string, roomId: string}} ref
   * @param {string} categoryId 目标分类 id（空值表示移回未分类）
   * @returns {Promise<{ok: true, changed: boolean, room: object} | {ok: false, reason: string}>}
   */
  async setRoomCategory({ platform, roomId } = {}, categoryId) {
    if (!roomId || !platform) return { ok: false, reason: 'invalid-ref' };
    return this._enqueue(async () => {
      const { rooms, categories } = await this._readRaw();
      const index = rooms.findIndex(r => r.platform === platform && this._sameRoomId(r.roomId, roomId));
      if (index === -1) return { ok: false, reason: 'not-found' };

      const target = this._categoryRules.groupOf(categoryId, categories);
      if (this._categoryRules.groupOf(rooms[index].categoryId, categories) === target) {
        return { ok: true, changed: false, room: roomStoreView(rooms[index]) };
      }

      const next = { ...rooms[index] };
      if (target) next.categoryId = target;
      else delete next.categoryId;
      const rest = rooms.filter((_, i) => i !== index);
      await this._storage.set({ rooms: rest.concat([next]) }); // 追加到目标分组末尾
      return { ok: true, changed: true, room: roomStoreView(next) };
    });
  }

  /**
   * 初始化（onInstalled 时调用一次，幂等）：四个键俱缺时写入默认值；旧格式（无 platform 字段）
   * 的 rooms / streamers 迁移为兜底平台。`notifiedRooms` 的旧 string[] 格式不归房间库，由编排迁移。
   * 老安装有 rooms / streamers / settings 但缺 categories：seeded 为 false（不写默认值、不重写用户
   * 数据），分类列表回退由读侧（_readRaw）负责——升级路径因此零成本（见 ADR-0008）。
   * @returns {Promise<{migrated: boolean, seeded: boolean}>}
   */
  async init() {
    return this._enqueue(async () => {
      const raw = (await this._storage.get(['rooms', 'streamers', 'settings', 'categories'])) || {};
      const seeded = raw.rooms === undefined && raw.streamers === undefined
        && raw.settings === undefined && raw.categories === undefined;
      const patch = {};
      let migrated = false;

      // 旧格式（无 platform 字段）迁移为兜底平台：只有真的改了才落盘（幂等）
      const migrateList = list => {
        if (!Array.isArray(list)) return null;
        let changed = false;
        const next = list.map(item => {
          if (item && typeof item === 'object' && item.roomId && !item.platform) {
            changed = true;
            return { ...item, platform: this._identity.DEFAULT_PLATFORM };
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

  /**
   * 一次取出四个键（缺键按空值处理），并把 rooms / streamers 里缺 platform 的老数据补齐：
   * 旧格式兜底只在这一个入口，下游直接读条目上的 platform（见 CONTEXT.md「房间标识」）。
   * categories 缺键回退空数组（老安装的升级路径，见 ADR-0008）。
   * 补齐只在读侧，不额外落盘；条目随下一次写入带 platform 持久化（init 的迁移是它的幂等版本）。
   */
  async _readRaw() {
    const raw = (await this._storage.get(['rooms', 'streamers', 'settings', 'categories'])) || {};
    const fallback = this._identity.DEFAULT_PLATFORM;
    return {
      rooms: roomStoreWithPlatform(Array.isArray(raw.rooms) ? raw.rooms : [], fallback),
      streamers: roomStoreWithPlatform(Array.isArray(raw.streamers) ? raw.streamers : [], fallback),
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
    };
  }

  /** 下一个分类 id：取现有 `c<n>` 的最大序号 +1（确定性、不暴露给用户、不会撞上任何存量条目） */
  _nextCategoryId(categories) {
    let max = 0;
    for (const category of categories) {
      const match = /^c(\d+)$/.exec(String(category && category.id));
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `c${max + 1}`;
  }

  /** FIFO 串行队列：前一次操作失败不毒化队列 */
  _enqueue(task) {
    const run = this._queue.then(task, task);
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  /** 房间复合键（拼键与拆键在房间标识 module，单一口径） */
  _key(platform, roomId) {
    return this._identity.roomKey({ platform, roomId });
  }

  _sameRoomId(a, b) {
    return this._identity.sameRoomId(a, b);
  }

  static _onlineCount(streamers) {
    return streamers.filter(s => s.online).length;
  }

  /** 平台观众数开关：新字段优先，未写入时回退旧总开关语义（字段不存在视为开启） */
  _isViewerFetchEnabled(settings, platform) {
    const toggle = this._identity.viewerToggle(platform);
    if (!toggle) return true;
    if (settings && settings[toggle] !== undefined) return settings[toggle] !== false;
    return !settings || settings.fetchViewerCount !== false;
  }

  /** 开关被关掉的平台的观众数字段（清残留与快照解算共用同一口径） */
  _offViewerFields(settings) {
    return this._identity.PLATFORM_IDS
      .filter(platform => !this._isViewerFetchEnabled(settings, platform))
      .map(platform => this._identity.viewerField(platform));
  }

  /** 快照里的 settings：补默认值、解算平台开关为布尔、去掉旧总开关（页面拿到即用） */
  _resolvedSettings(settings) {
    const resolved = { ...ROOM_STORE_DEFAULTS.settings, ...(settings || {}) };
    for (const platform of this._identity.PLATFORM_IDS) {
      resolved[this._identity.viewerToggle(platform)] = this._isViewerFetchEnabled(settings, platform);
    }
    delete resolved.fetchViewerCount;
    return resolved;
  }
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RoomStore, ROOM_STORE_DEFAULTS };
}
