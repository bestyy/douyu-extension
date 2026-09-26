// lib/today-stats.js — 今日统计的纯逻辑：平台门 / 总开关 / 取数目标 / 跨零点保鲜 / 整条显示判定
//
// 术语（见 CONTEXT.md）：
// - 今日统计 (today stats)：某房「当天 0 点起累计」的四项数字——弹幕数 / 弹幕人数 / 礼物金额 / 礼物人数
// - 数据来源是第三方数据站 doseeing 的区间聚合（我们只是消费方，不自己统计），取数与字段收敛在
//   lib/doseeing-api.js，取数节拍与落盘在编排
//
// 判定口径（唯一实现，见 ADR-0007）：
// - 平台门 STATS_PLATFORMS：只有斗鱼有这个形态的数据，且拿 B站房间号去查会错标成同号的斗鱼房间
//   （两个平台的房间号是独立命名空间），所以这是正确性问题，不是省请求的优化。
// - 取数目标 = 平台门 + 在线门：下播房间的卡片本就不显示，查了也没有出口。
// - 保鲜 = 记录的 date 等于今天。跨过本地零点后旧值判废（避免把昨天的「today」当今天），
//   因此盖戳（statsDateKey）与判废（isStatsFresh）必须同源：两者都用本地日期口径。
// - 整条显示判定（shouldShowTodayStats：总开关 → 保鲜）只有这一个实现，弹窗只调它——
//   判定链散在两处就无法纯单测驱动、改它要改两处（与 decideViewerAlert 那次整理同理，见 ADR-0002）。
//
// 本模块只做纯计算，不引用 chrome / fetch / storage，可在 node 下直接测试。
// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试；
// 弹窗与设置页作为普通 script 加载时可直接读平台门与判定。

// 有这个形态的数据的平台（目前只有斗鱼）：其余平台即使有房间也不请求、不展示
const STATS_PLATFORMS = ['douyu'];

/**
 * 今日统计总开关（settings.todayStatsEnabled，默认开启；旧版本无该字段视为开启）。
 * 关闭时不请求第三方站点、不展示，已落盘的数字保留，重新打开即恢复（与既有 *Enabled 同一口径）。
 * @param {{todayStatsEnabled?: boolean}} [settings] 存储中的 settings
 * @returns {boolean}
 */
function isTodayStatsEnabled(settings) {
  return settings?.todayStatsEnabled !== false;
}

/**
 * 本轮的取数目标：开播中的斗鱼房间。
 * @param {Array<{platform: string, roomId: string, online?: boolean}>} rooms 房间库快照的房间列表
 * @returns {Array} 目标房间（与入参同引用，不修改也不复制）
 */
function selectTodayStatsTargets(rooms) {
  const list = Array.isArray(rooms) ? rooms : [];
  return list.filter(room => room && STATS_PLATFORMS.includes(room.platform) && room.online === true);
}

/**
 * 保鲜：记录的 date 是否就是今天。缺 date、非对象记录、没有今天的日期口径都不新鲜——
 * 宁可不显示，也不把昨天的数字当今天（跨本地零点后旧值判废）。
 * @param {object} record 落盘的今日统计记录 { ..., date }
 * @param {string} today 本地日期口径（statsDateKey 的结论）
 * @returns {boolean}
 */
function isStatsFresh(record, today) {
  if (!record || typeof record !== 'object') {
    return false;
  }
  return record.date === today;
}

/**
 * 本地日期口径 'YYYY-MM-DD'（盖戳与判废共用同一处，见文件头）。
 * @param {number|Date} [now] 时刻；缺省取当前时间
 * @returns {string}
 */
function statsDateKey(now) {
  const date = now === undefined ? new Date() : new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 弹窗该不该显示某房这一行：总开关 → 保鲜，整条判定只此一处（弹窗只调它，不自己拼条件）。
 * @param {{settings?: object, record?: object, today?: string}} params
 * @returns {boolean}
 */
function shouldShowTodayStats({ settings, record, today } = {}) {
  return isTodayStatsEnabled(settings) && isStatsFresh(record, today);
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STATS_PLATFORMS,
    isTodayStatsEnabled,
    selectTodayStatsTargets,
    isStatsFresh,
    statsDateKey,
    shouldShowTodayStats
  };
}
