// lib/doseeing-api.js — 第三方数据站 doseeing（在看直播排行榜）的今日统计取数
//
// 术语（见 CONTEXT.md「今日统计」）：某房「当天 0 点起累计」的弹幕数 / 弹幕人数 / 礼物金额 / 礼物人数。
// 斗鱼官方的公开接口只给房间快照与当前指标，不给当天区间的聚合成品；这个区间聚合只有 doseeing 给
// （`GET /api/room_stat?room=<斗鱼房间号>&hours=today`，匿名可访问、无签名无 token）。
// 因此这是本项目唯一的非斗鱼 / 非 B站第三方接口依赖，取舍与后果见 ADR-0007。
//
// 一个模块对一个接口提供方，所以不与 lib/douyu-api.js 合并：混进去会让「这个数从哪来」在代码里消失。
// 字段收敛在本层完成（编排与弹窗不关心原始命名与单位）：
// - `gift.paid.price` 单位是**分**，在此换成元并保留两位小数（站点前端自己也 /100 才显示成元），
//   展示层不再关心单位——这一处换算错了只会静默显示错金额，因此有单测钉住。
// - `room` 为 null 表示站方没有这个房间（统计字段全 0，据此不可信）→ 判失败，不把 0 当数据。
// - 只取付费礼物（`gift.paid.*`，不含免费）：含免费会把「礼物人数」抬到接近观众数、失去区分度。
// 超时与错误模型沿用 lib/douyu-api.js（10 秒 AbortController / success+error 收敛形状）。

const DOSEEING_BASE = 'https://www.doseeing.com';
const DOSEEING_TIMEOUT_MS = 10000;

/** 数值字段容错：站点给的是稀疏对象，缺字段 / 非数字都按 0（缺字段不该判失败） */
function doseeingNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/** 分 → 元：金额只保留两位小数（站点给的是整数分） */
function doseeingYuan(cents) {
  return Math.round(doseeingNumber(cents)) / 100;
}

/**
 * 取某斗鱼房间当天的四项累计。
 * 调用方的平台门与在线门在 lib/today-stats.js（selectTodayStatsTargets）：本层只管一个房间号。
 * @param {string} roomId 斗鱼房间号
 * @returns {Promise<{success: true, data: {chatPv: number, chatUv: number, giftAmount: number,
 *                    giftUv: number, ts: number}}
 *                  | {success: false, error: 'room_not_found'|'no_stats'|'parse_error'|'timeout'|'network_error',
 *                     message?: string}>}
 *          giftAmount 单位是元；ts 是取数完成时刻（编排据此盖记录的 fetchedAt）
 */
async function fetchTodayStats(roomId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOSEEING_TIMEOUT_MS);

  try {
    const response = await fetch(`${DOSEEING_BASE}/api/room_stat?room=${roomId}&hours=today`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: `${DOSEEING_BASE}/room/${roomId}`,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01'
      }
    });
    clearTimeout(timeout);

    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return { success: false, error: 'parse_error' }; // 站点返回 HTML 页（如被重定向到登录页）
    }

    if (!result.room) {
      return { success: false, error: 'room_not_found' }; // 房间不存在或无数据，统计字段全 0
    }
    const stats = Array.isArray(result.stats) ? result.stats[0] : null;
    if (!stats || typeof stats !== 'object') {
      return { success: false, error: 'no_stats' };
    }

    return {
      success: true,
      data: {
        chatPv: doseeingNumber(stats['chat.pv']),
        chatUv: doseeingNumber(stats['chat.uv']),
        giftAmount: doseeingYuan(stats['gift.paid.price']),
        giftUv: doseeingNumber(stats['gift.paid.uv']),
        ts: Date.now()
      }
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { success: false, error: 'timeout' };
    }
    return { success: false, error: 'network_error', message: err.message };
  }
}

const DoseeingAPI = { fetchTodayStats };

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DoseeingAPI, fetchTodayStats };
}
