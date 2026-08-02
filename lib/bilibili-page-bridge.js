// lib/bilibili-page-bridge.js — B站弹幕页面通道（content script）
//
// 部分浏览器（如豆包）在登录 B站后，扩展 Service Worker 直连的 WS 请求携带登录
// Cookie（SESSDATA）但 Origin 为 chrome-extension://，被 B站判定为异常连接，
// 握手成功后即被断开（1006）。而页面上下文（live.bilibili.com）的连接 Origin
// 与 Cookie 均合法，弹幕正常。
//
// 本桥在 live.bilibili.com 页面上下文中复用 BilibiliBarrageClient 建立弹幕 WS，
// 将高能榜在线数通过消息回传给 Service Worker。仅「桥接标签页」激活
// （URL 带 ?dyext=1 标记，由 Service Worker 自动创建），避免与用户自己打开的
// B站页面重复建连。bilibili-barrage.js 需在 manifest 中先行加载。

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

  // Service Worker 增量同步房间（增删房间时）
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'BILI_SET_ROOMS') {
      bridgeClient.setRooms(msg.roomIds);
      sendResponse({ ok: true });
    }
    return false;
  });

  // 页面加载时从 storage 自动同步房间列表
  chrome.storage.local.get('rooms').then(({ rooms }) => {
    const ids = (rooms || [])
      .filter(r => r.platform === 'bilibili')
      .map(r => String(r.roomId));
    bridgeClient.setRooms(ids);
  }).catch(() => {
    // 忽略读取失败
  });
})();
