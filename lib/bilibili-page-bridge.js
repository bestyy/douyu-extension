// lib/bilibili-page-bridge.js — B站弹幕页面通道（content script，登录态采样通道）
//
// 登录态（SESSDATA Cookie）下 SW 直连的弹幕 WS 握手携带登录 Cookie，实测必被 1006
// 风控（spi 配对正确仍被拒）；而页面上下文（live.bilibili.com）的连接 Origin 与
// Cookie 均合法，且**长连接**模式实测稳定（采样短连在登录态下同样被风控）。
// 因此登录时 B站采样统一走本桥，节奏与斗鱼一致：每 10 分钟由 SW 临时打开本页，
// 收到 BILI_SAMPLE_ROOMS 后对每个房间建立长连接，拿到各房间高能榜在线数（或
// 总超时兜底）即断开全部 WS 并发 BILI_SAMPLE_DONE，SW 随即关闭本页——
// 平时不保留任何连接与页面。
// 弹幕检测（BILI_WATCH_ROOMS）复用同一页面但用独立客户端：盯守期间长连接常驻、
// 不随采样收尾断开（见 ADR-0001），DANMU_MSG 文本经 BILI_DANMU 消息回传 SW，
// 由 SW 侧计数触发检测通知。
// 仅「桥接标签页」激活（URL 带 ?dyext=1 标记，由 Service Worker 自动创建），
// 避免与用户自己打开的 B站页面重复建连。bilibili-barrage.js 需在 manifest 中先行加载。

(() => {
  // 仅桥接标签页激活，用户自己打开的 B站页面跳过
  if (!location.search.includes('dyext=1')) {
    return;
  }

  const SAMPLE_TIMEOUT_MS = 60000;     // 本轮采样总超时：未开播/无推送的房间到时强制收尾
  let sampleTimer = null;              // 本轮采样总超时定时器
  let sampleTarget = 0;                // 本轮目标房间数
  const sampleDoneRooms = new Set();   // 已拿到数据的房间（长连接持续推送，每房间只计一次）

  const bridgeClient = new BilibiliBarrageClient({
    onRankCount: ({ roomId, rankCount }) => {
      try {
        chrome.runtime.sendMessage({ type: 'BILI_RANK_COUNT', roomId, rankCount });
      } catch (e) {
        // 扩展重载等场景下消息发送失败，忽略
      }
      // 长连接每 4-6 秒推送一次，全部房间拿到数据即提前收尾，无需等总超时
      if (!sampleDoneRooms.has(roomId)) {
        sampleDoneRooms.add(roomId);
        if (sampleDoneRooms.size >= sampleTarget) {
          finishSampling();
        }
      }
    }
  });

  // 检测长连接客户端：与采样客户端分开（采样收尾 destroy 不得断开盯守连接，见 ADR-0001）
  const watchClient = new BilibiliBarrageClient({
    onDanmu: ({ roomId, text, user }) => {
      try {
        chrome.runtime.sendMessage({ type: 'BILI_DANMU', roomId, text, user });
      } catch (e) {
        // 扩展重载等场景下消息发送失败，忽略
      }
    }
  });

  // 本轮采样收尾：断开全部 WS（含心跳/重连定时器）并通知 SW 关闭本页
  function finishSampling() {
    clearTimeout(sampleTimer);
    sampleTimer = null;
    bridgeClient.destroy();
    try {
      chrome.runtime.sendMessage({ type: 'BILI_SAMPLE_DONE' });
    } catch (e) {
      // 扩展重载等场景下消息发送失败，忽略
    }
  }

  // 开始一轮采样：对每个房间建立长连接（登录态下短连会被风控，长连接实测稳定），
  // 收到高能榜在线数即上报；未开播/无推送的房间靠总超时兜底
  function startSampling(roomIds) {
    clearTimeout(sampleTimer);
    sampleDoneRooms.clear();
    sampleTarget = roomIds.length;
    if (sampleTarget === 0) {
      finishSampling();
      return;
    }
    sampleTimer = setTimeout(finishSampling, SAMPLE_TIMEOUT_MS);
    bridgeClient.setRooms(roomIds);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'BILI_SAMPLE_ROOMS') {
      startSampling(msg.roomIds);
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'BILI_WATCH_ROOMS') {
      // 弹幕检测盯守列表（幂等：SW 每轮轮询重新下发，页面按最新列表收敛连接）
      watchClient.setRooms(msg.roomIds || []);
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'BILI_PING') {
      // 存活检测：扩展重载后 SW 用此消息确认桥接页 content script 仍有效
      sendResponse({ ok: true });
    }
    return false;
  });
})();
