// lib/viewer-alert.js — 观众数提醒的纯逻辑：配置归一化 / 阈值钳制 / 上升边沿判定
//
// 术语（见 CONTEXT.md）：
// - 观众数 (viewer count)：各平台特有观众指标的统称（斗鱼贵宾数 vipCount / B站高能榜在线数 rankCount）
// - 观众数提醒 (viewer alert)：某房间的观众数从阈值以下升到阈值以上时发一条桌面通知，per-room 功能
//
// 判定数据源是观众数采样（每 10 分钟一次短连）写下的 streamers[].vipCount / rankCount，
// 不新增任何连接；判定时机是「值到达时」（background 的 updateVipCount / updateRankCount）。
//
// 双重门控（配置保留、停止判定，见 CONTEXT.md「观众数提醒」）：
// - 全局总开关 settings.viewerAlertEnabled（默认开启）
// - 该平台观众数开关 settings.fetchDouyuViewerCount / fetchBilibiliViewerCount（关闭即拿不到数值）
//
// 本模块只做纯计算，不引用 chrome / WebSocket / fetch，可在 node 下直接测试。
// 通知发送、下播清空与开关同步留在 background 的值入口与轮询收敛点。

// 平台 → 观众数指标文案（贵宾数 / 高能榜在线数为平台特有指标，通知与设置页文案随之变化）。
// 指标对应的存储字段由值入口决定（斗鱼 updateVipCount / B站 updateRankCount），不在此映射
const VIEWER_METRICS = {
  douyu: { label: '贵宾数', shortLabel: '贵宾' },
  bilibili: { label: '高能榜在线数', shortLabel: '高能榜' }
};

// 阈值缺省 1000、范围 1–999999（钳制后的值回写到表单，用户看得见实际生效值）
const VIEWER_ALERT_DEFAULT_THRESHOLD = 1000;
const VIEWER_ALERT_LIMITS = [1, 999999];

/** 阈值解析并钳制（本模块自带，不依赖其他 lib 的加载顺序） */
function clampViewerThreshold(value) {
  const num = typeof value === 'string' ? parseInt(value.trim(), 10) : value;
  if (typeof num !== 'number' || !isFinite(num) || isNaN(num)) {
    return VIEWER_ALERT_DEFAULT_THRESHOLD;
  }
  return Math.min(VIEWER_ALERT_LIMITS[1], Math.max(VIEWER_ALERT_LIMITS[0], Math.trunc(num)));
}

/** 只取阈值（设置页面板在该房未启用时也要显示当前填的值） */
function viewerAlertThreshold(raw) {
  return clampViewerThreshold(raw?.threshold);
}

/**
 * 归一化房间的观众数提醒配置，未启用时返回 null（不判定不报错）
 * @param {{enabled?: boolean, threshold?: number}} raw rooms[].viewerAlert
 * @returns {{enabled: true, threshold: number}|null}
 */
function normalizeViewerAlert(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) {
    return null;
  }
  return { enabled: true, threshold: clampViewerThreshold(raw.threshold) };
}

/**
 * 观众数提醒总开关（settings.viewerAlertEnabled，默认开启；旧版本无该字段视为开启）。
 * 关闭时全局停止判定：不发任何提醒，各房已配的阈值保留，重新打开即恢复。
 * @param {{viewerAlertEnabled?: boolean}} [settings] 存储中的 settings
 * @returns {boolean}
 */
function isViewerAlertEnabled(settings) {
  return settings?.viewerAlertEnabled !== false;
}

/**
 * 上升边沿判定：上次值 < 阈值 且 本次值 ≥ 阈值 → 触发一次。
 *
 * 无历史值（新加入的房间、下播清空后）视为 0，因此首次采到 ≥ 阈值即提醒；
 * 数值回落到阈值以下自动重新武装，再次越过再提醒（回落本身不触发）。
 * 这是「超过一定数量时提醒」的字面语义：越过时提醒，而不是持续高位时反复打扰。
 *
 * @param {number|undefined} prevValue 上一次的观众数（缺省/非法视为 0）
 * @param {number} nextValue 本次观众数
 * @param {number} threshold 阈值
 * @returns {boolean}
 */
function isViewerAlertCrossed(prevValue, nextValue, threshold) {
  const prev = typeof prevValue === 'number' && isFinite(prevValue) ? prevValue : 0;
  const next = typeof nextValue === 'number' && isFinite(nextValue) ? nextValue : 0;
  return prev < threshold && next >= threshold;
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试；
// 设置页作为普通 script 加载时可直接用归一化函数与 VIEWER_METRICS。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VIEWER_ALERT_DEFAULT_THRESHOLD,
    VIEWER_ALERT_LIMITS,
    VIEWER_METRICS,
    clampViewerThreshold,
    viewerAlertThreshold,
    normalizeViewerAlert,
    isViewerAlertEnabled,
    isViewerAlertCrossed
  };
}
