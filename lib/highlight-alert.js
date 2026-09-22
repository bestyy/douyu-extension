// lib/highlight-alert.js — 看点通知的纯逻辑：平台门 / 总开关 / 按每房看点水位挑出新看点
//
// 术语（见 CONTEXT.md）：
// - 看点 (highlight)：斗鱼为直播中的房间自动切出的精彩片段（标题、起止时间、热度都由平台给）
// - 看点通知 (highlight notification)：某房出现新看点时发的桌面通知（ID 为房间复合键 + _highlight 后缀）
// - 看点水位 (highlight watermark)：某房「已经就看点通知到哪一条」的记账，判据是平台给的递增编号
//
// 判定口径（唯一实现，见 ADR-0006）：
// - 看点列表是整场的全量列表，所以「什么算新的」只能靠水位：记住已经通知过的最大编号，
//   编号严格大于它的才算新；首次观测（刚打开开关、刚加入房间、水位丢失）只记水位、不发通知。
// - 列表顺序不可信（不依赖「最新在前」）：最新的一条是编号最大的那条，不是数组最后一条。
// - 一次发现多条只报最新那一条，其余在水位里一并消化（同房通知 ID 覆盖，逐条发只会多响几声）。
// - 编号缺失或非数字的条目不参与判定、也不进水位（宁可不报，也不重报）。
// - 水位只增不减：接口回退、换场残留都不会把水位拉回去；列表为空时水位原地不动。
//
// 平台门 HIGHLIGHT_PLATFORMS 留在本模块：只有斗鱼有这个形态的信息，判定由本模块读它
// （常量归属判据见 ADR-0005）。取数与字段收敛在平台 API 层，水位落盘与通知发送在编排。
//
// 本模块只做纯计算，不引用 chrome / fetch / storage，可在 node 下直接测试。
// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试；
// 设置页作为普通 script 加载时可直接读平台门与总开关。

// 具备看点这个形态的平台（目前只有斗鱼）：其余平台即使打开了该房开关也不请求、不判定
const HIGHLIGHT_PLATFORMS = ['douyu'];

/**
 * 看点通知总开关（settings.highlightAlertEnabled，默认开启；旧版本无该字段视为开启）。
 * 关闭时全局停止取数与判定：不请求看点接口、不发通知，各房已打开的开关保留，重新打开即恢复。
 * @param {{highlightAlertEnabled?: boolean}} [settings] 存储中的 settings
 * @returns {boolean}
 */
function isHighlightAlertEnabled(settings) {
  return settings?.highlightAlertEnabled !== false;
}

/** 编号是否可用：平台给的是数字，其余形态（缺字段、字符串、NaN）一律不参与判定 */
function isHighlightId(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 水位是否可用：有限数字才算「有水位」，缺省与非有限值都按首次观测处理 */
function hasWatermark(watermark) {
  return isHighlightId(watermark);
}

/**
 * 按水位挑出本轮的新看点，并给出该写入的新水位。
 * 不修改入参，也不依赖列表顺序（一次遍历同时算最大编号与最新那条）。
 * @param {Array<{highlightId: number, title: string}>} list API 层收敛过的看点条目（整场全量，顺序不可信）
 * @param {number|undefined} watermark 该房已经通知过的最大编号；缺省或非有限数字 = 没有水位（首次观测）
 * @returns {{newest: object|null, count: number, watermark: number|undefined}}
 *          - 首次观测：newest 为 null、count 为 0、watermark 为本轮最大编号（只记不发）
 *          - 有水位：newest 是编号大于水位的条目里编号最大的那条；没有这样的条目时 newest 为 null、count 为 0
 *          - 没有有效条目（空列表、编号全不可用）：水位原地不动
 */
function selectNewHighlights(list, watermark) {
  const entries = Array.isArray(list) ? list : [];
  const prev = hasWatermark(watermark) ? watermark : null;
  let maxId = null;
  let newest = null;
  let count = 0;

  for (const entry of entries) {
    if (!entry || !isHighlightId(entry.highlightId)) {
      continue; // 编号缺失或非数字：不参与判定，也不进水位
    }
    if (maxId === null || entry.highlightId > maxId) {
      maxId = entry.highlightId;
    }
    if (prev === null || entry.highlightId > prev) {
      count += 1;
      if (newest === null || entry.highlightId > newest.highlightId) {
        newest = entry;
      }
    }
  }

  if (maxId === null) {
    return { newest: null, count: 0, watermark: prev === null ? undefined : prev };
  }
  if (prev === null) {
    return { newest: null, count: 0, watermark: maxId }; // 首次观测：只记水位、不发通知
  }
  return { newest, count, watermark: Math.max(prev, maxId) };
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    HIGHLIGHT_PLATFORMS,
    isHighlightAlertEnabled,
    selectNewHighlights
  };
}
