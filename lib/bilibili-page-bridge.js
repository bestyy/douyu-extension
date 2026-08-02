// lib/bilibili-page-bridge.js — B站弹幕页面通道（content script，登录态主通道）
//
// 登录态（SESSDATA Cookie）下 SW 直连的弹幕 WS 握手携带登录 Cookie，实测必被 1006
// 风控（spi 配对正确仍被拒）；而页面上下文（live.bilibili.com）的连接 Origin 与
// Cookie 均合法，且**长连接**模式实测稳定（采样短连在登录态下同样被风控）。
// 因此登录时 B站采样统一走本桥：在桥接标签页的页面上下文中复用 BilibiliBarrageClient
// 的**长连接模式**（setRooms：心跳保活 + 指数退避重连），高能榜在线数持续经消息
// 回传给 Service Worker。
// 仅「桥接标签页」激活（URL 带 ?dyext=1 标记，由 Service Worker 自动创建），
// 避免与用户自己打开的 B站页面重复建连。bilibili-barrage.js 需在 manifest 中先行加载。

(() => {
  // 仅桥接标签页激活，用户自己打开的 B站页面跳过
  if (!location.search.includes('dyext=1')) {
    return;
  }

  const bridgeClient = new BilibiliBarrageClient({
    onRankCount: ({ roomId, rankCount }) => {
      try {
        chrome.runtime.sendMessage({ type: 'BILI_RANK_COUNT', roomId, rankCount });
      } catch (e) {
        // 扩展重载等场景下消息发送失败，忽略
      }
    }
  });

  // Service Worker 增量同步房间（增删房间时），长连接持续上报高能榜在线数
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'BILI_SET_ROOMS') {
      bridgeClient.setRooms(msg.roomIds);
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'BILI_PING') {
      // 存活检测：扩展重载后 SW 用此消息确认桥接页 content script 仍有效
      sendResponse({ ok: true });
    }
    return false;
  });

  // 页面加载时从 storage 自动同步房间列表（SW 侧消息可能早于注入到达）
  chrome.storage.local.get('rooms').then(({ rooms }) => {
    const ids = (rooms || [])
      .filter(r => r.platform === 'bilibili')
      .map(r => String(r.roomId));
    bridgeClient.setRooms(ids);
  }).catch(() => {
    // 忽略读取失败
  });
})();
