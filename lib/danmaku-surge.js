// lib/danmaku-surge.js — 弹幕激增提醒的纯逻辑：参数归一化 / 分钟桶计量 / 相对自身基线的激增裁决
//
// 术语（见 CONTEXT.md）：
// - 弹幕激增提醒 (danmaku surge alert)：某房弹幕条数相对自身本场基线突然异常变多时发通知的 per-room 功能
// - 激增通知 (surge notification)：激增裁决的产物，正文报上一分钟条数与平时水位，并附一条样本弹幕
// - 样本弹幕 (surge sample)：随激增通知一起发出的那条弹幕，取自被裁决的那一分钟里最有内容的一条
//
// 判定数据源是弹幕检测的长连接（见 ADR-0004）：房间进盯守集合就逐条计入分钟桶，不额外建连，
// 也不要求该房配检测词；条数统计与检测词匹配互不影响。
//
// 度量口径：分钟桶按绝对分钟索引对齐，安静的一分钟归档为 0（与弹幕是否到达无关）；
// 每房保留最近 30 个完整桶；评估对象是上一个完整桶（正在积累的桶天然偏小，拿它比必然误报）；
// 基线取归档桶中不含待评估那一桶的中位数；冷启动攒够 minBuckets 个完整桶（默认 10）才开始裁决；
// 触发后进冷却。桶与冷却都是内存态，与盯守连接同生命周期（SW 被回收即丢，下播 reset）。
//
// 本模块只做纯计算，不引用 chrome / WebSocket / fetch，可在 node 下直接测试。
// 通知发送与结算节拍（alarm）留在编排。
//
// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试；
// 设置页作为普通 script 加载时可直接用 normalizeSurgeSettings 归一化用户输入。

// 参数缺省值：涨到 3 倍算激增 / 基线门槛 3 条每分钟 / 冷却 30 分钟 / 冷启动攒够 10 个完整桶
const SURGE_DEFAULTS = { multiple: 3, minBaseline: 3, cooldownMinutes: 30, minBuckets: 10 };

const SURGE_MAX_BUCKETS = 30;  // 每房保留的完整分钟桶数，也是冷启动桶数的上限
const SURGE_BUCKET_MS = 60 * 1000; // 桶宽 = 1 分钟（桶数即分钟数）

// 参数取值范围：倍数 1.1–10（一位小数，房间体量大时半个身位也值得知道）、
// 门槛 1–999 条/分钟、冷却 1–180 分钟、冷启动 2–30 个完整桶。都不支持 0：冷却 0 会引入「本场锁定」语义，
// 倍数 1 是退化值——上桶 ≥ 中位数在约一半的分钟里都成立，等于按冷却时长定时打扰；
// 冷启动下限 2 是结构下限——评估对象是上桶，基线另取样本，只剩 1 个桶时基线恒为 0（空数组中位数）永不触发。
const SURGE_LIMITS = {
  multiple: [1.1, 10],
  minBaseline: [1, 999],
  cooldownMinutes: [1, 180],
  minBuckets: [2, SURGE_MAX_BUCKETS]
};

// 倍数保留一位小数；门槛、冷却与冷启动桶数是整数值
const SURGE_MULTIPLE_DECIMALS = 1;

/**
 * 解析数值、按 decimals 位小数截断、再钳制到 [min, max]（decimals 为 0 即取整），非法值取缺省。
 * 本模块自带，不依赖其他 lib 的加载顺序。
 * 截断在钳制之前：1.04 截成 1.0 后仍会被抬到下限，不会落进区间外。
 */
function clampSurgeNumber(value, [min, max], fallback, decimals = 0) {
  const num = typeof value === 'string' ? parseFloat(value.trim()) : value;
  if (typeof num !== 'number' || !isFinite(num) || isNaN(num)) {
    return fallback;
  }
  const factor = 10 ** decimals;
  return Math.min(max, Math.max(min, Math.trunc(num * factor) / factor));
}

/**
 * 归一化四个全局判定参数：钳制到取值范围、缺失或非法取缺省值。
 * 设置页读写与编排裁决共用同一套口径（用户填的值即判定用的值）。
 * @param {{surgeMultiple?: number, surgeMinBaseline?: number, surgeCooldownMinutes?: number, surgeMinBuckets?: number}} [settings] 存储中的 settings
 * @returns {{multiple: number, minBaseline: number, cooldownMinutes: number, minBuckets: number}}
 */
function normalizeSurgeSettings(settings) {
  return {
    multiple: clampSurgeNumber(
      settings?.surgeMultiple,
      SURGE_LIMITS.multiple,
      SURGE_DEFAULTS.multiple,
      SURGE_MULTIPLE_DECIMALS
    ),
    minBaseline: clampSurgeNumber(settings?.surgeMinBaseline, SURGE_LIMITS.minBaseline, SURGE_DEFAULTS.minBaseline),
    cooldownMinutes: clampSurgeNumber(
      settings?.surgeCooldownMinutes,
      SURGE_LIMITS.cooldownMinutes,
      SURGE_DEFAULTS.cooldownMinutes
    ),
    minBuckets: clampSurgeNumber(settings?.surgeMinBuckets, SURGE_LIMITS.minBuckets, SURGE_DEFAULTS.minBuckets)
  };
}

/**
 * 弹幕激增总开关（settings.surgeAlertEnabled，默认开启；旧版本无该字段视为开启）。
 * 关闭时全局停止裁决：不盯守、不发激增通知，各房已打开的开关与参数保留，重新打开即恢复。
 * @param {{surgeAlertEnabled?: boolean}} [settings] 存储中的 settings
 * @returns {boolean}
 */
function isSurgeAlertEnabled(settings) {
  return settings?.surgeAlertEnabled !== false;
}

/** 中位数（偶数个取中间两数的平均；空数组为 0） */
function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// === 样本弹幕 ===
//
// 条数说明「多」，样本弹幕说明「在聊什么」：两者一起才让人判断得出这场直播现在是什么内容。
// 取被裁决那一分钟里最长的一条——长度是「信息量」最容易计算也最容易解释的代理；
// 但复读刷屏（666666…、哈哈哈哈）与两三个字的短句在激增时刻最密集，长度上占优却什么都不说明，
// 所以要求至少 4 个字符、且不同字符不少于 3 个（复读只有一个字符在重复）。
// 一分钟里没有合格候选就不发这一行：宁可只说条数，也不拿「666」冒充内容。
const SURGE_SAMPLE_MIN_LENGTH = 4;
const SURGE_SAMPLE_MIN_DISTINCT = 3;

/** 折叠空白并去首尾：弹幕里的多余空白不该算进长度，也避免换行破坏通知的两行版式 */
function normalizeDanmuText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 是否够格当样本（长度与字符多样性两个门槛，见上文） */
function isSampleWorthy(text) {
  return text.length >= SURGE_SAMPLE_MIN_LENGTH && new Set(text).size >= SURGE_SAMPLE_MIN_DISTINCT;
}

/**
 * 在已有样本与候选弹幕之间挑更适合当样本的那条：更长者胜，同长保留先到的那条。
 * 候选不合格（见 isSampleWorthy）时原样返回已有样本。
 * @param {string|null} prev 当前样本
 * @param {string} candidate 新到的弹幕文本
 * @returns {string|null}
 */
function betterDanmuSample(prev, candidate) {
  const text = normalizeDanmuText(candidate);
  if (!isSampleWorthy(text)) {
    return prev || null;
  }
  return !prev || text.length > prev.length ? text : prev;
}

/**
 * 分钟桶计量与激增裁决（内存态，与盯守连接同生命周期：SW 重启即清空，下播 / 停用 reset）
 *
 * 用法：该房每来一条弹幕调 recordDanmu 计入当前桶（并带上文本参与样本评选）；结算节拍（1 分钟的 alarm，
 * 轮询收敛点兜底）调 tick 裁决刚归档的那个完整桶，触发时发出激增通知。
 *
 * 归档由先跨桶的那一方完成（热闹房间通常是 recordDanmu，安静房间则是 tick），
 * 所以结算的判据是「有已归档但还没裁决过的桶」，而不是「本次调用自己跨了桶」——
 * 否则弹幕先到的房间会每次都错过裁决，功能在最该生效的房间里反而永不触发。
 */
class SurgeMeter {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] 时钟（注入便于测试）；归档与结算共用同一时钟
   */
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    // key -> { buckets, samples, index, count, sample, cooldownUntil, pending }
    // samples 与 buckets 一一对齐：第 i 个桶的样本弹幕就是 samples[i]（该分钟没有合格候选则为 null）
    this._rooms = new Map();
  }

  /** 当前时刻（与注入的时钟同源；结算前读一次并传给同批房间，保证同批共用同一时刻） */
  now() {
    return this._now();
  }

  /**
   * 记录一条弹幕：先把该房时间轴推进到 now（跨过的完整分钟归档、空分钟补 0、超 30 个丢最旧），
   * 再给当前桶 +1，并让 text 参与当前桶的样本弹幕评选
   * @param {string} key 房间复合键
   * @param {object} [options]
   * @param {number} [options.now] 观测时刻（缺省取注入的时钟）
   * @param {string} [options.text] 弹幕文本（缺省则该条不参与样本评选；只影响样本，不影响条数）
   */
  recordDanmu(key, { now = this._now(), text = '' } = {}) {
    const state = this._state(key);
    if (this._advance(state, SurgeMeter._index(now))) {
      state.pending = true; // 归档了一个完整桶，留给下一次结算裁决
    }
    state.count += 1;
    state.sample = betterDanmuSample(state.sample, text);
  }

  /**
   * 裁决刚归档的那个完整桶（正在积累的桶不评估；一次跨过多个桶只结算最近的完整桶，中间的桶不补报）。
   * 没有待裁决的桶（同一桶已经裁决过）、没有状态、冷启动样本不足、冷却中、未达倍数或未达基线门槛
   * 都不触发。
   * @param {string} key 房间复合键
   * @param {number} now 结算时刻
   * @param {{multiple: number, minBaseline: number, cooldownMinutes: number, minBuckets: number}} config 全局判定参数
   * @returns {{triggered: boolean, bucketCount: number, baseline: number, sample: string|null}}
   *          未裁决时计数与基线为 0；sample 是那个桶的样本弹幕（裁决与否都照样返回，没有合格候选则为 null）
   */
  tick(key, now, config) {
    const state = this._rooms.get(key);
    if (!state || state.index === null) {
      return { triggered: false, bucketCount: 0, baseline: 0, sample: null };
    }
    // 结算时也把时间轴推进到 now：安静的房间没有弹幕来触发归档，由这里补上（空分钟补 0）
    const crossed = this._advance(state, SurgeMeter._index(now));
    if (!crossed && !state.pending) {
      return { triggered: false, bucketCount: 0, baseline: 0, sample: null }; // 没有待裁决的完整桶
    }
    state.pending = false;

    const bucketCount = state.buckets[state.buckets.length - 1];
    const baseline = median(state.buckets.slice(0, -1));
    const sample = state.samples[state.samples.length - 1];
    if (state.buckets.length < config.minBuckets) {
      return { triggered: false, bucketCount, baseline, sample }; // 冷启动：样本不足以看出「突然」
    }
    if (now < state.cooldownUntil) {
      return { triggered: false, bucketCount, baseline, sample }; // 冷却中：不再打扰
    }
    if (bucketCount < baseline * config.multiple || baseline < config.minBaseline) {
      return { triggered: false, bucketCount, baseline, sample };
    }
    state.cooldownUntil = now + config.cooldownMinutes * SURGE_BUCKET_MS;
    return { triggered: true, bucketCount, baseline, sample };
  }

  /** 清空某房间的桶、样本与冷却（下播 / 停用激增时调用，下一场重新积累基线） */
  reset(key) {
    this._rooms.delete(key);
  }

  /** 取（或建）房间状态：index 为 null 表示还没有当前桶（从未收到弹幕） */
  _state(key) {
    let state = this._rooms.get(key);
    if (!state) {
      state = {
        buckets: [],
        samples: [],
        index: null,
        count: 0,
        sample: null,
        cooldownUntil: 0,
        pending: false
      };
      this._rooms.set(key, state);
    }
    return state;
  }

  /**
   * 把时间轴推进到 index：跨过的完整分钟归档（空分钟补 0、无样本补 null），只保留最近 30 个，
   * 当前桶清零。index 不前进（同一分钟，或时钟回拨）不动时间轴，弹幕照常计入当前桶。
   * @returns {boolean} 是否真的跨桶归档了（false = 时间轴没动）
   */
  _advance(state, index) {
    if (state.index === null) {
      state.index = index;
      state.count = 0;
      return false;
    }
    if (index <= state.index) {
      return false;
    }
    state.buckets.push(state.count);
    state.samples.push(state.sample);
    // 中间整分钟没有弹幕到达，归档为 0；SW 长时间挂起后恢复时 gap 可能很大，
    // 超出保留窗口的补零反正会被丢掉，最多补满一窗
    const gap = Math.min(index - state.index - 1, SURGE_MAX_BUCKETS);
    for (let i = 0; i < gap; i++) {
      state.buckets.push(0);
      state.samples.push(null);
    }
    if (state.buckets.length > SURGE_MAX_BUCKETS) {
      state.buckets = state.buckets.slice(-SURGE_MAX_BUCKETS);
      state.samples = state.samples.slice(-SURGE_MAX_BUCKETS);
    }
    state.index = index;
    state.count = 0;
    state.sample = null;
    return true;
  }

  /** 绝对分钟索引：桶按它对齐，与弹幕何时到达无关 */
  static _index(now) {
    return Math.floor(now / SURGE_BUCKET_MS);
  }
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SURGE_DEFAULTS,
    SURGE_LIMITS,
    SURGE_MAX_BUCKETS,
    SURGE_SAMPLE_MIN_LENGTH,
    SURGE_SAMPLE_MIN_DISTINCT,
    clampSurgeNumber,
    normalizeSurgeSettings,
    isSurgeAlertEnabled,
    betterDanmuSample,
    SurgeMeter
  };
}
