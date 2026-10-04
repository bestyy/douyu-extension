// lib/subscription-alert.js — 订阅的纯裁决：错过宽限期、此刻该发哪些
//
// 术语（见 CONTEXT.md）：
// - 订阅 (subscription)：用户为某房间排定的一次性绝对时刻提醒，字段 { id, platform, roomId, at }
// - 订阅通知 (subscription notification)：订阅到点时发的桌面通知，ID 按订阅唯一（前缀是房间复合键）
//
// 本模块独占两件事（照 ADR-0005「纯规则模块各自持有常量」）：
// 1. 错过补发的固定宽限期常量 SUBSCRIPTION_GRACE_MS：不暴露给用户、不做成设置项。
// 2. 「此刻该发哪些」的裁决 decideSubscriptions：把 at <= now 的订阅分成「照发」（延迟在宽限期内）
//    与「静默丢弃」（超过宽限期）两组，并给出「下一个待触发时刻」供编排排 alarm。
// 订阅通知的文案构造不在这里——它归「通知 module」（lib/notifications.js），与其余五种同处一地。
// 订阅行的显示名 subscriptionDisplayName 留在本模块：弹窗与设置页用它渲染订阅行，不是通知专有。
//
// 判定口径（见 ADR-0016 第三条）：
// - 到点无条件发，不拿开播状态决定发不发；开播状态只进正文。
// - 到点那一刻扩展可能没在运行，晚不超过宽限期照发，超过则静默丢弃（睡一觉醒来才弹的过时提醒是
//   噪音）。宽限期是闭区间：延迟恰好等于宽限期仍照发（「不超过」含边界）。本设计不依赖「错过的 alarm
//   会不会被 Chrome 补触发」这条外部事实：SW 每次启动都从存储重排 alarm，触发时再按宽限期逐条裁决。
// - nextAt 只取 at 严格大于 now 的订阅（已到期的不是「下一个待触发」）。
//
// 本模块只做纯计算，不引用 chrome / fetch / storage，可在 node 下直接测试。
// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试；
// 设置页与弹窗作为普通 script 加载时可直接读宽限期常量与展示名函数。

// 错过补发的宽限期：到点那一刻扩展可能没在运行，晚不超过它照发，超过就静默丢弃
const SUBSCRIPTION_GRACE_MS = 5 * 60 * 1000;

/** at 是否可用：有限数字才算一个绝对时刻 */
function isSubscriptionAt(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 裁决此刻该发哪些订阅。
 * 不修改入参，也不依赖列表顺序。
 * @param {Array<{id: string, at: number}>} subscriptions 存储中的订阅列表
 * @param {number} now 当前绝对时刻（毫秒）
 * @returns {{notify: Array, dropped: Array, nextAt: number|undefined}}
 *          - notify：at <= now 且延迟不超过宽限期的订阅（照发组）
 *          - dropped：at <= now 且延迟超过宽限期的订阅（静默丢弃组）
 *          - nextAt：at 严格大于 now 的订阅里最早的 at；没有则为 undefined
 */
function decideSubscriptions(subscriptions, now) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  const nowMs = Number.isFinite(now) ? now : 0;
  const notify = [];
  const dropped = [];
  let nextAt;

  for (const subscription of list) {
    if (!subscription || !isSubscriptionAt(subscription.at)) {
      continue; // 畸形条目不参与判定（正常流程存不下这种条目）
    }
    if (subscription.at <= nowMs) {
      (nowMs - subscription.at <= SUBSCRIPTION_GRACE_MS ? notify : dropped).push(subscription);
    } else if (nextAt === undefined || subscription.at < nextAt) {
      nextAt = subscription.at;
    }
  }

  return { notify, dropped, nextAt };
}

/**
 * 订阅的展示名：优先用房间/主播快照里的昵称，解析不到（房间已被移除）时回退为「平台 房间号」。
 * 弹窗与设置页渲染订阅行、以及订阅列表的「下一条」共用这一处口径。
 * @param {{subscription: {platform: string, roomId: string}, streamer?: {nickname?: string}, platformLabel?: string}} params
 * @returns {string}
 */
function subscriptionDisplayName({ subscription, streamer, platformLabel } = {}) {
  const label = platformLabel || (subscription && subscription.platform) || '';
  const nickname = streamer && streamer.nickname;
  return nickname || `${label} ${subscription.roomId}`;
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUBSCRIPTION_GRACE_MS,
    decideSubscriptions,
    subscriptionDisplayName
  };
}
