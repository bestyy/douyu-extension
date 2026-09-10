// lib/danmaku-watch.js — 弹幕检测的纯逻辑：配置归一化 / 命中匹配 / 盯守计划 / 窗口计数与冷却
//
// 术语（见 CONTEXT.md）：
// - 检测词 (keyword)：某房间启用的弹幕命中词，子串包含、不区分大小写，一房多词共用一个计数器
// - 弹幕检测 (danmaku watch)：开播期间保持长连接、滑动窗口计数、触发后进冷却的 per-room 功能
// - 检测通知 (detection notification)：窗口内命中数达到阈值时发的桌面通知，按房间覆盖
//
// 本模块只做纯计算，不引用 chrome / WebSocket / fetch，可在 node 下直接测试。
// 连接编排（开播门控、通道决策、通知发送）留在 background 的轮询收敛点。
//
// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试；
// 设置页作为普通 script 加载时可直接用 normalizeWatch 归一化用户输入。

const WATCH_MAX_CONCURRENT = 5;       // 同时盯守的开播房间上限，超出按房间列表顺序排队
const WATCH_MAX_KEYWORDS = 20;        // 每房最多检测词数
const WATCH_MAX_KEYWORD_LENGTH = 10;  // 单个检测词最大字数（超出截断）
const WATCH_PLATFORMS = ['douyu', 'bilibili']; // 抖音无弹幕通道，检测不支持

// 检测缺省值：阈值 5 次 / 窗口 5 分钟 / 冷却 10 分钟
const WATCH_DEFAULTS = { threshold: 5, windowMinutes: 5, cooldownMinutes: 10 };

// 检测取值范围：阈值 1–99、窗口 1–60 分钟、冷却 0–120 分钟（0 = 本场锁定）
const WATCH_LIMITS = {
  threshold: [1, 99],
  windowMinutes: [1, 60],
  cooldownMinutes: [0, 120]
};

/** 解析整数并钳制到 [min, max]，非法值取缺省 */
function clampInt(value, [min, max], fallback) {
  const num = typeof value === 'string' ? parseInt(value.trim(), 10) : value;
  if (typeof num !== 'number' || !isFinite(num) || isNaN(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

/**
 * 归一化检测词：接受数组或换行分隔的文本，去空白、丢空行、去重（不区分大小写，保留首个写法），
 * 最多 20 个、每个最多 10 字（超出截断）
 * @param {string[]|string|undefined} raw
 * @returns {string[]}
 */
function normalizeKeywords(raw) {
  if (raw === undefined || raw === null) {
    return [];
  }
  const lines = Array.isArray(raw) ? raw : String(raw).split('\n');
  const seen = new Set();
  const keywords = [];
  for (const line of lines) {
    const word = String(line === undefined || line === null ? '' : line).trim().slice(0, WATCH_MAX_KEYWORD_LENGTH);
    if (!word) {
      continue;
    }
    const lower = word.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    keywords.push(word);
    if (keywords.length >= WATCH_MAX_KEYWORDS) {
      break;
    }
  }
  return keywords;
}

/**
 * 只归一化三个数值（设置页在检测词为空、检测未启用时也要保存用户填的数值）
 * @param {{threshold?: number, windowMinutes?: number, cooldownMinutes?: number}} raw
 * @returns {{threshold: number, windowMinutes: number, cooldownMinutes: number}}
 */
function normalizeWatchLimits(raw = {}) {
  return {
    threshold: clampInt(raw.threshold, WATCH_LIMITS.threshold, WATCH_DEFAULTS.threshold),
    windowMinutes: clampInt(raw.windowMinutes, WATCH_LIMITS.windowMinutes, WATCH_DEFAULTS.windowMinutes),
    cooldownMinutes: clampInt(raw.cooldownMinutes, WATCH_LIMITS.cooldownMinutes, WATCH_DEFAULTS.cooldownMinutes)
  };
}

/**
 * 归一化房间的检测配置，未配置时返回 null（不建连接不报错）
 * @param {{enabled?: boolean, keywords?: string[]|string, threshold?: number, windowMinutes?: number, cooldownMinutes?: number}} raw rooms[].watch
 * @returns {{enabled: true, keywords: string[], threshold: number, windowMinutes: number, cooldownMinutes: number}|null}
 */
function normalizeWatch(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) {
    return null;
  }
  const keywords = normalizeKeywords(raw.keywords);
  if (keywords.length === 0) {
    return null; // 检测词为空或全是空行 → 该房未配置
  }
  return { enabled: true, keywords, ...normalizeWatchLimits(raw) };
}

/**
 * 弹幕文本命中判定：子串包含且不区分大小写
 * @param {string} text 弹幕文本
 * @param {{keywords: string[]}} config 归一化后的检测配置
 * @returns {string|null} 命中的检测词（配置中的原始写法，多词命中取配置顺序第一个）；未命中返回 null
 */
function matchKeyword(text, config) {
  if (!text || !config || !config.keywords) {
    return null;
  }
  const haystack = String(text).toLowerCase();
  for (const keyword of config.keywords) {
    if (haystack.includes(keyword.toLowerCase())) {
      return keyword;
    }
  }
  return null;
}

/**
 * 盯守计划：按房间列表顺序取前 limit 个「已配置检测且开播」的房间为盯守对象，其余在线房间排队。
 * 纯函数：每轮轮询用最新在线快照重算即可，下播释放名额后由列表顺序靠前的排队房间补位（不抢占在线房间）。
 * @param {Array<{roomId: string, platform: string, nickname?: string, watch?: object}>} rooms 存储中的 rooms 数组（顺序即优先级）
 * @param {Set<string>} onlineKeys 在线房间复合键集合（`platform_roomId`）
 * @param {number} [limit] 同时盯守上限
 * @returns {{active: Array<{key, platform, roomId, nickname, config}>, queued: Array<{key, platform, roomId, nickname}>}}
 */
function selectWatchPlan(rooms, onlineKeys, limit = WATCH_MAX_CONCURRENT) {
  const active = [];
  const queued = [];
  for (const room of rooms || []) {
    if (!WATCH_PLATFORMS.includes(room.platform)) {
      continue; // 抖音等无弹幕通道的平台不支持检测
    }
    const config = normalizeWatch(room.watch);
    if (!config) {
      continue;
    }
    const key = `${room.platform}_${room.roomId}`;
    if (!onlineKeys || !onlineKeys.has(key)) {
      continue; // 未开播不盯
    }
    const entry = { key, platform: room.platform, roomId: String(room.roomId), nickname: room.nickname || '', config };
    if (active.length < limit) {
      active.push(entry);
    } else {
      queued.push({ key, platform: entry.platform, roomId: entry.roomId, nickname: entry.nickname });
    }
  }
  return { active, queued };
}

/**
 * 是否存在已配置检测的 B站房间（B站通道决策的输入：只要有配置就要备好通道，
 * 与该房当前是否开播无关——通道要在开播前就位）
 * @param {Array<{roomId: string, platform: string, watch?: object}>} rooms
 * @returns {boolean}
 */
function hasConfiguredBiliWatch(rooms) {
  return (rooms || []).some(r => r.platform === 'bilibili' && normalizeWatch(r.watch));
}

/**
 * 滑动窗口计数与冷却（内存态，与长连接同生命周期：SW 重启即清空，下播 reset）
 *
 * 语义：命中都发生在窗口内才计数；计数达到阈值触发一次通知并进入冷却；
 * 冷却内命中不计数（不预算不补报）；冷却为 0 表示本场锁定，触发后直到 reset 不再报。
 */
class DanmakuWatchCounter {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] 时钟（注入便于测试）
   */
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._hits = new Map();     // key -> number[] 窗口内的命中时刻
    this._cooldownUntil = new Map(); // key -> 冷却结束时刻
    this._locked = new Set();   // key -> 本场锁定（冷却 0 触发后）
  }

  /**
   * 记录一次命中并按检测配置裁决是否触发通知
   * @param {string} key 房间复合键
   * @param {{threshold: number, windowMinutes: number, cooldownMinutes: number}} config
   * @returns {{triggered: boolean, count: number}} 是否触发 / 本次窗口内命中数
   */
  recordHit(key, config) {
    const now = this._now();
    if (this._locked.has(key)) {
      return { triggered: false, count: 0 };
    }
    const cooldownUntil = this._cooldownUntil.get(key);
    if (cooldownUntil !== undefined && now < cooldownUntil) {
      return { triggered: false, count: 0 }; // 冷却内命中不计数，避免冷却一过立刻补报
    }
    const windowMs = config.windowMinutes * 60 * 1000;
    const hits = (this._hits.get(key) || []).filter(at => now - at < windowMs);
    hits.push(now);
    if (hits.length < config.threshold) {
      this._hits.set(key, hits);
      return { triggered: false, count: hits.length };
    }
    // 达到阈值：触发一次并进入冷却（计数清空，冷却结束后重新从 0 计）
    this._hits.delete(key);
    if (config.cooldownMinutes > 0) {
      this._cooldownUntil.set(key, now + config.cooldownMinutes * 60 * 1000);
    } else {
      this._locked.add(key); // 冷却 0：本场锁定
    }
    return { triggered: true, count: hits.length };
  }

  /** 清空某房间的命中窗口、冷却与锁定（下播 / 停用检测时调用） */
  reset(key) {
    this._hits.delete(key);
    this._cooldownUntil.delete(key);
    this._locked.delete(key);
  }

  /** 清空全部房间状态 */
  resetAll() {
    this._hits.clear();
    this._cooldownUntil.clear();
    this._locked.clear();
  }
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WATCH_DEFAULTS,
    WATCH_LIMITS,
    WATCH_MAX_CONCURRENT,
    WATCH_MAX_KEYWORDS,
    WATCH_MAX_KEYWORD_LENGTH,
    WATCH_PLATFORMS,
    normalizeKeywords,
    normalizeWatch,
    normalizeWatchLimits,
    matchKeyword,
    selectWatchPlan,
    hasConfiguredBiliWatch,
    DanmakuWatchCounter
  };
}
