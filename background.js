// background.js — Service Worker

importScripts('lib/storage.js');
importScripts('lib/douyu-api.js');
importScripts('lib/bilibili-api.js');
importScripts('lib/douyu-barrage.js');
importScripts('lib/bilibili-barrage.js');

// === 贵宾数弹幕客户端 ===
// 通过 danmuproxy WebSocket 订阅 oni 消息（贵宾数），约每 6 秒推送一次
const barrageClient = new BarrageClient({
  onVipCount: updateVipCount
});

// === B站高能榜弹幕客户端 ===
// 订阅 ONLINE_RANK_COUNT 消息（高能榜在线数），约每 4-6 秒推送一次。
// 通道由 syncBarrageRooms 按登录态决策：未登录走 SW 直连（认证参数与直播间页面
// 弹幕连接逐字对齐，见 .pi/test-bili-comet.cjs），登录态走页面桥接（SW 直连握手
// 必被 1006 风控）；两通道均为 10 分钟采样节奏，拿到数据即断开。
// 若未来 SW 直连被风控（本轮全败且快速断开），onFallback 降级到页面通道。
const bilibiliBarrageClient = new BilibiliBarrageClient({
  onRankCount: updateRankCount,
  onFallback: handleBiliChannelFallback
});

// === 观众数采样控制 ===
// 设置页开关 fetchViewerCount 控制是否获取观众数（斗鱼贵宾数/B站高能榜在线数）；
// 采样模式：每 10 分钟由 chrome.alarms 驱动一次短连，拿到数据立即断开，
// 平时不保持任何 WS 连接（连接数不再随房间数增长）
const VIEWER_SAMPLE_INTERVAL = 10; // 观众数采样间隔（分钟），与 sampleViewerCounts alarm 周期一致

// 读取观众数获取开关（settings.fetchViewerCount，默认开启）
async function isViewerFetchEnabled() {
  const settings = await StorageHelper.get('settings');
  return settings?.fetchViewerCount !== false;
}

// 检测 B站登录态：SESSDATA Cookie 存在即视为已登录。
// 登录态下 SW 直连的弹幕 WS 握手携带登录 Cookie，实测必被 1006 风控；
// 未登录（无 Cookie）时 SW 直连可用（见 .pi/test-bili-comet.cjs）。
// 因此登录与否决定 B站采样走页面桥接还是 SW 直连。
async function isBiliLoggedIn() {
  try {
    const cookie = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'SESSDATA' });
    return !!(cookie && cookie.value);
  } catch (e) {
    return false;
  }
}

// 清除 streamers 中的观众数字段（关闭开关时调用，避免 popup 显示过期数据）
async function stripViewerCounts() {
  const streamers = (await StorageHelper.get('streamers')) || [];
  if (!streamers.some(s => 'vipCount' in s || 'rankCount' in s)) {
    return;
  }
  const cleaned = streamers.map(s => {
    const { vipCount, rankCount, ...rest } = s;
    return rest;
  });
  await StorageHelper.set('streamers', cleaned);
}

// Service Worker 每次唤醒时同步弹幕客户端状态（观众数开关 / B站页面通道）
syncBarrageRooms();

async function syncBarrageRooms() {
  const viewerEnabled = await isViewerFetchEnabled();
  const rooms = (await StorageHelper.get('rooms')) || [];
  const hasBili = rooms.some(r => r.platform === 'bilibili');

  if (!viewerEnabled) {
    // 关闭观众数获取：清除已存观众数，停用页面通道并关闭桥接标签页
    biliPageChannelEnabled = false;
    await StorageHelper.set('biliPageChannelEnabled', false);
    await stripViewerCounts();
    await closeBridgeTab();
    return;
  }
  if (!hasBili) {
    // 无 B站房间：停用页面通道并关闭桥接标签页（斗鱼采样不受影响）
    biliPageChannelEnabled = false;
    await StorageHelper.set('biliPageChannelEnabled', false);
    await closeBridgeTab();
    return;
  }
  // 有 B站房间：通道选择 —— 登录态（SESSDATA）下 SW 直连握手必被 1006 风控，
  // 必须走页面桥接；未登录时 SW 直连可用。持久化的降级标记（未登录时被风控
  // 降级过）在 SW 重启后继续生效，与登录检测共同决定通道。
  // 两种通道均为采样节奏（每 10 分钟一次）：页面通道每次采样临时打开桥接标签页，
  // 拿到数据即关闭，不保留常驻页面与长连接（见 sampleViewerCounts）。
  const useBridge = (await isBiliLoggedIn()) ||
    (await StorageHelper.get('biliPageChannelEnabled')) === true;
  if (useBridge !== biliPageChannelEnabled) {
    biliPageChannelEnabled = useBridge;
    await StorageHelper.set('biliPageChannelEnabled', useBridge);
    console.log(`[bili] 通道切换为 ${useBridge ? '页面桥接' : 'SW 直连'}`);
  }
  if (!useBridge) {
    // 未启用页面通道：清理可能残留的桥接标签页（旧版常驻页面/采样异常遗留）
    await closeBridgeTab();
  }
}

// 收到 oni 推送 → 更新 streamers[].vipCount（写入 storage 供 popup 读取）
async function updateVipCount({ roomId, vipCount }) {
  if (!(await isViewerFetchEnabled())) {
    return;
  }
  const streamers = (await StorageHelper.get('streamers')) || [];
  const index = streamers.findIndex(s => s.platform === 'douyu' && String(s.roomId) === String(roomId));
  if (index === -1) {
    return;
  }
  streamers[index] = { ...streamers[index], vipCount };
  await StorageHelper.set('streamers', streamers);
}

// 收到 ONLINE_RANK_COUNT 推送 → 更新 streamers[].rankCount（高能榜在线数）
// 页面通道为长连接模式（每 4-6 秒推送一次），仅在数值变化时写 storage 与打日志
async function updateRankCount({ roomId, rankCount }) {
  if (!(await isViewerFetchEnabled())) {
    return;
  }
  const streamers = (await StorageHelper.get('streamers')) || [];
  const index = streamers.findIndex(s => s.platform === 'bilibili' && String(s.roomId) === String(roomId));
  if (index === -1) {
    console.warn(`[bili] updateRankCount 未找到匹配 streamers 条目 roomId=${roomId} rankCount=${rankCount} streamers=${streamers.length}条`);
    return;
  }
  if (streamers[index].rankCount === rankCount) {
    return; // 数值未变化，跳过写入
  }
  streamers[index] = { ...streamers[index], rankCount };
  await StorageHelper.set('streamers', streamers);
  console.log(`[bili] updateRankCount 已写入 ${roomId} rankCount=${rankCount}`);
}

// === B站弹幕页面通道（SW 直连被风控时的降级后备） ===
// SW 直连为主通道（认证参数与页面弹幕一致后实测可用，见 .pi/test-bili-comet.cjs）；
// 若未来 B站风控收紧（本轮采样全败且快速断开），onFallback 切换为页面通道：
// content script 在 live.bilibili.com 页面上下文建连（lib/bilibili-page-bridge.js），
// 通过 chrome.runtime 消息回传高能榜在线数。
const BRIDGE_TAB_URL = 'https://live.bilibili.com/?dyext=1'; // 桥接标签页标记 URL
let biliPageChannelEnabled = false; // 页面通道启用标记（持久化，SW 重启后仍生效）

// SW 直连采样被风控（本轮全败且快速断开）→ 降级到页面通道
async function handleBiliChannelFallback() {
  if (biliPageChannelEnabled || !(await isViewerFetchEnabled())) {
    return;
  }
  biliPageChannelEnabled = true;
  await StorageHelper.set('biliPageChannelEnabled', true); // 持久化，SW 重启后仍走页面通道
  console.warn('[bili] SW 直连采样被风控，切换到页面通道');
  // 停止 SW 直连采样，避免继续触发风控（destroy 只断开连接，不触发降级判定）；
  // 桥接标签页不在此常驻，下一次 sampleViewerCounts 采样时临时打开
  bilibiliBarrageClient.destroy();
  try {
    await chrome.notifications.create('bili_bridge_fallback', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'B站高能榜连接已切换通道',
      message: '当前浏览器拦截了扩展直连，已切换为页面通道。每次采样时会自动临时打开一个 B站标签页，获取后自动关闭。',
      priority: 1
    });
  } catch (e) {
    // 通知失败不影响功能
  }
}

// 关闭桥接标签页（无 B站房间 / 关闭观众数开关 / 采样完成后调用）
async function closeBridgeTab() {
  const tabs = await chrome.tabs.query({ url: 'https://live.bilibili.com/*' });
  for (const tab of tabs) {
    if (tab.url && tab.url.includes('dyext=1')) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

// 等待桥接页 content script 就绪（新建/刷新后注入需要时间），返回是否就绪
async function waitBridgeReady(tabId, attempts = 15) {
  for (let i = 0; i < attempts; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'BILI_PING' });
      return true;
    } catch (e) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return false;
}

let bridgeEnsurePromise = null; // 并发去重：alarm 采样与设置变更可能同时触发创建

// 确保桥接标签页存在（优先复用已打开的，否则自动创建，不抢焦点）
async function ensureBridgeTab() {
  if (bridgeEnsurePromise) {
    return bridgeEnsurePromise; // 进行中的创建/检测共享同一次结果，避免重复弹出标签页
  }
  bridgeEnsurePromise = _ensureBridgeTab().finally(() => { bridgeEnsurePromise = null; });
  return bridgeEnsurePromise;
}

async function _ensureBridgeTab() {
  const tabs = await chrome.tabs.query({ url: 'https://live.bilibili.com/*' });
  const existing = tabs.find(t => t.url && t.url.includes('dyext=1'));
  if (existing) {
    // 扩展重载后旧页面的 content script 会失效（chrome.runtime 断开），消息无人响应；
    // ping 检测存活，无响应则刷新页面重新注入
    try {
      await chrome.tabs.sendMessage(existing.id, { type: 'BILI_PING' });
    } catch (e) {
      console.warn('[bili] 桥接页 content script 未响应, 刷新重新注入');
      await chrome.tabs.reload(existing.id);
    }
    await dedupeBridgeTabs();
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: BRIDGE_TAB_URL, active: false });
  await dedupeBridgeTabs();
  return tab.id;
}

// 清理多余的桥接标签页：扩展重载瞬间新旧 SW 交替时，旧 SW 的创建请求可能已经发出，
// 导致残留两个 dyext=1 页面（内存锁无法跨 SW 实例生效），统一保留第一个
async function dedupeBridgeTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://live.bilibili.com/*' });
  const bridges = tabs.filter(t => t.url && t.url.includes('dyext=1'));
  for (const extra of bridges.slice(1)) {
    console.warn(`[bili] 发现多余桥接标签页 tabId=${extra.id}, 关闭`);
    chrome.tabs.remove(extra.id).catch(() => {});
  }
}

// 桥接标签页只在采样期间存在（临时打开 → 采样完成/超时后由 SW 关闭），
// 不需要「用户关闭后自动重开」的兜底逻辑（常驻模式遗留，临时模式下会导致
// SW 主动关页后被重新打开，页面残留）。
// === 初始化 ===
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await StorageHelper.getAll();

  // 数据迁移（旧版本→新版本）
  await StorageHelper.migrateLegacyFormat();

  if (Object.keys(existing).length === 0) {
    await chrome.storage.local.set({
      ...DEFAULT_STORAGE,
      _firstRun: true
    });
  }

  // 通道选择（页面桥接 vs SW 直连）统一由 syncBarrageRooms 按登录态/降级标记决策，
  // 这里不再重置标记或关闭桥接页，避免与顶层 syncBarrageRooms() 竞态覆盖。
  // （登录用户：ensureBridgeTab 会 ping 存活检测，重载后失效的桥接页自动刷新重注入）
  await syncBarrageRooms();

  await createAlarm();
});

// === 定时器管理 ===
async function createAlarm() {
  const settings = await StorageHelper.get('settings');
  const interval = settings?.refreshInterval || 60;
  const minutes = Math.max(1, Math.floor(interval / 60));
  chrome.alarms.create('refreshRooms', { periodInMinutes: minutes });
  // 观众数采样 alarm：10 分钟短连一次，平时不保持 WS 连接
  chrome.alarms.create('sampleViewerCounts', { periodInMinutes: VIEWER_SAMPLE_INTERVAL });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refreshRooms') {
    await refreshRooms();
  } else if (alarm.name === 'sampleViewerCounts') {
    await sampleViewerCounts();
  }
});

// === 观众数定时采样 ===
// 每 10 分钟短连一次：斗鱼单连接订阅全部房间，B站每房间一条连接；
// 拿到数据立即断开，平时零 WS 连接（由 chrome.alarms 驱动，SW 休眠后自动恢复）。
// B站登录态（SESSDATA）下 SW 直连握手必被 1006 风控，改为页面通道：临时打开
// 桥接标签页，在页面上下文建立长连接（登录态下短连同样被风控），拿到高能榜
// 在线数即断开并关闭页面，节奏与斗鱼一致。
async function sampleViewerCounts() {
  if (!(await isViewerFetchEnabled())) {
    return;
  }
  const rooms = (await StorageHelper.get('rooms')) || [];
  const douyuIds = rooms.filter(r => r.platform === 'douyu').map(r => String(r.roomId));
  const bilibiliIds = rooms.filter(r => r.platform === 'bilibili').map(r => String(r.roomId));

  if (douyuIds.length > 0) {
    barrageClient.sample(douyuIds);
  }
  if (bilibiliIds.length > 0) {
    if (biliPageChannelEnabled) {
      // 页面通道（登录态主通道/降级后备）：临时开页 → 长连接采样 → 桥接页发
      // BILI_SAMPLE_DONE 后由 SW 关闭页面（不在此长时间等待，消息事件可靠唤醒
      // 休眠中的 SW 完成关页，避免等待期间 SW 空闲被终止）
      await startBiliBridgeSample(bilibiliIds);
    } else {
      // SW 直连主通道（未登录）：每个房间一条短连，收到高能榜在线数即断开（认证参数与页面弹幕一致）
      bilibiliBarrageClient.sample(bilibiliIds);
    }
  }
}

// 页面通道采样：打开（或复用）桥接标签页并驱动一轮采样。
// 采样完成/超时由桥接页发 BILI_SAMPLE_DONE，SW 收到后关闭页面；不在这里
// await 完成信号（最长 60 秒的等待会让 SW 空闲被终止，而消息事件可靠唤醒）。
async function startBiliBridgeSample(roomIds) {
  const tabId = await ensureBridgeTab();
  const ready = await waitBridgeReady(tabId);
  if (!ready) {
    console.warn('[bili] 桥接页长时间未就绪, 本轮跳过');
    await closeBridgeTab();
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'BILI_SAMPLE_ROOMS', roomIds });
  } catch (e) {
    console.warn('[bili] 驱动桥接页采样失败, 本轮跳过');
    await closeBridgeTab();
  }
}

// === 核心轮询逻辑 ===
async function refreshRooms() {
  const rooms = await StorageHelper.get('rooms');
  if (!rooms || rooms.length === 0) {
    return; // 未配置房间号，跳过
  }

  const douyuRooms = rooms.filter(r => r.platform === 'douyu');
  const bilibiliRooms = rooms.filter(r => r.platform === 'bilibili');
  const douyuIds = douyuRooms.map(r => r.roomId);
  const bilibiliIds = bilibiliRooms.map(r => r.roomId);

  const [douyuResult, bilibiliResult] = await Promise.all([
    douyuIds.length > 0
      ? DouyuAPI.batchFetchRoomInfo(douyuIds)
      : { success: true, data: [] },
    bilibiliIds.length > 0
      ? BilibiliAPI.batchFetchRoomInfo(bilibiliIds)
      : { success: true, data: [] }
  ]);

  // 合并 API 成功数据与上一次状态（API 失败的房间保留旧数据）
  const prevStreamers = (await StorageHelper.get('streamers')) || [];
  const prevMap = {};
  prevStreamers.forEach(s => {
    prevMap[`${s.platform}_${s.roomId}`] = s;
  });
  const prevOnline = new Set(
    prevStreamers.filter(s => s.online).map(s => `${s.platform}_${s.roomId}`)
  );

  // 按 roomId 索引 API 成功返回的结果
  const apiData = new Map();
  douyuResult.data.forEach(d => apiData.set(`douyu_${d.roomId}`, { ...d, platform: 'douyu' }));
  bilibiliResult.data.forEach(d => apiData.set(`bilibili_${d.roomId}`, { ...d, platform: 'bilibili' }));

  // 逐个房间合并：API 成功取新数据，失败保留旧数据
  const mergedData = [];
  for (const room of rooms) {
    const key = `${room.platform}_${room.roomId}`;
    const fresh = apiData.get(key);
    let item;
    if (fresh) {
      item = { ...fresh };
    } else if (prevMap[key]) {
      item = { ...prevMap[key] };
    } else {
      continue;
    }
    // 传递 per-room 通知标记
    item.notify = room.notify === true;
    // 透传弹幕推送的贵宾数/高能榜在线数（API 不返回该字段，避免被轮询覆盖）
    if (prevMap[key] && typeof prevMap[key].vipCount === 'number') {
      item.vipCount = prevMap[key].vipCount;
    }
    if (prevMap[key] && typeof prevMap[key].rankCount === 'number') {
      item.rankCount = prevMap[key].rankCount;
    }
    mergedData.push(item);
  }

  if (mergedData.length === 0) {
    return;
  }

  await StorageHelper.set('streamers', mergedData);
  await StorageHelper.set('lastRefresh', Date.now());

  const onlineCount = mergedData.filter(s => s.online).length;
  chrome.action.setBadgeText({ text: onlineCount > 0 ? String(onlineCount) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF4400' });

  const isFirstRun = (await StorageHelper.get('_firstRun')) === true;
  if (isFirstRun) {
    const onlineEntries = mergedData.filter(s => s.online).map(s => ({
      roomId: s.roomId,
      platform: s.platform
    }));
    await StorageHelper.set('notifiedRooms', onlineEntries);
    await StorageHelper.set('_firstRun', null);
  } else {
    const settings = await StorageHelper.get('settings');
    if (settings?.notificationsEnabled !== false) {
      await checkNewLiveStreams(mergedData, prevOnline);
    }
  }
}

// 数字格式化：>= 1 万显示 x.x万，否则原样（与 popup 保持一致）
function formatNumber(num) {
  if (num >= 10000) {
    return (num / 10000).toFixed(1) + '万';
  }
  return String(num);
}

// === 新开播通知 ===
async function checkNewLiveStreams(currentStreamers, prevOnlineSet) {
  const rawNotified = (await StorageHelper.get('notifiedRooms')) || [];
  const notifiedMap = new Set(
    rawNotified.map(n => `${n.platform}_${n.roomId}`)
  );

  for (const streamer of currentStreamers) {
    if (!streamer.online) continue;
    if (streamer.notify !== true) continue;  // 跳过用户设置了不通知的房间

    const compositeKey = `${streamer.platform}_${streamer.roomId}`;
    const isNewlyLive = !prevOnlineSet.has(compositeKey);
    const alreadyNotified = notifiedMap.has(compositeKey);

    if (isNewlyLive && !alreadyNotified) {
      const platformPrefix = streamer.platform === 'bilibili' ? '[B站]' : '[斗鱼]';
      // 统计文案按平台区分：斗鱼显示贵宾数（弹幕推送），B站显示高能榜在线数（弹幕推送）
      const statText = streamer.platform === 'bilibili'
        ? (typeof streamer.rankCount === 'number' && streamer.rankCount > 0
            ? `${formatNumber(streamer.rankCount)} 高能榜`
            : '')
        : (typeof streamer.vipCount === 'number' && streamer.vipCount > 0
            ? `${formatNumber(streamer.vipCount)} 贵宾`
            : '');
      try {
        await chrome.notifications.create(compositeKey, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: `${platformPrefix} ${streamer.nickname} 开播了！`,
          message: streamer.title || '正在直播',
          contextMessage: [streamer.category, statText].filter(Boolean).join(' · '),
          buttons: [{ title: '进入直播间' }],
          priority: 2
        });
        notifiedMap.add(compositeKey);
      } catch (e) {
        console.error('通知创建失败:', e);
      }
    }
  }

  const onlineKeys = new Set(
    currentStreamers
      .filter(s => s.online && s.notify === true)
      .map(s => `${s.platform}_${s.roomId}`)
  );
  const updatedNotified = rawNotified.filter(n =>
    onlineKeys.has(`${n.platform}_${n.roomId}`)
  );
  await StorageHelper.set('notifiedRooms', updatedNotified);
}

// === 通知按钮点击 ===
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    const url = getLiveUrlFromNotificationId(notificationId);
    if (url) chrome.tabs.create({ url });
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const url = getLiveUrlFromNotificationId(notificationId);
  if (url) chrome.tabs.create({ url });
});

function getLiveUrlFromNotificationId(notificationId) {
  const [platform, ...rest] = notificationId.split('_');
  const roomId = rest.join('_');
  if (platform === 'bilibili') {
    return `https://live.bilibili.com/${roomId}`;
  }
  return `https://www.douyu.com/${roomId}`;
}

// === 消息处理 ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'MANUAL_REFRESH':
      refreshRooms().then(() => sendResponse({ ok: true }));
      return true;

    case 'SETTINGS_UPDATED':
      // 重建轮询 alarm，重新同步弹幕客户端状态，并立即采样一次（开关即时生效）
      createAlarm().then(() => syncBarrageRooms()).then(() => sampleViewerCounts())
        .then(() => sendResponse({ ok: true }));
      return true;

    case 'ADD_ROOM':
      handleAddRoom(message.roomId, message.platform).then(sendResponse);
      return true;

    case 'REMOVE_ROOM':
      handleRemoveRoom(message.roomId, message.platform).then(sendResponse);
      return true;

    // 页面通道（content script）回传的高能榜在线数
    case 'BILI_RANK_COUNT':
      updateRankCount({ roomId: message.roomId, rankCount: message.rankCount })
        .then(() => sendResponse({ ok: true }));
      return true;

    // 桥接页本轮采样完成/超时 → 关闭桥接标签页（消息事件可靠唤醒休眠中的 SW，
    // 避免采样流程在 SW 侧长时间等待导致空闲被终止）
    case 'BILI_SAMPLE_DONE':
      closeBridgeTab().catch(() => {});
      sendResponse({ ok: true });
      return true;

    default:
      sendResponse({ ok: false });
  }
});

// === 房间管理 ===
async function handleAddRoom(rawRoomId, platform) {
  const roomId = rawRoomId?.trim();
  if (!roomId || !/^\d+$/.test(roomId)) {
    return { ok: false, error: '房间号格式无效' };
  }
  platform = platform || 'douyu';

  // 检查是否已存在（同平台+同房间号）
  const rooms = (await StorageHelper.get('rooms')) || [];
  if (rooms.some(r => r.roomId === roomId && r.platform === platform)) {
    return { ok: false, error: '该房间已在监控列表中' };
  }

  // 根据平台选择 API
  let api = platform === 'bilibili' ? BilibiliAPI : DouyuAPI;
  let resolveResult = await api.resolveNickname(roomId);

  // 如果所选平台解析失败，自动尝试另一个平台（兜底）
  if (!resolveResult.success) {
    const otherPlatform = platform === 'bilibili' ? 'douyu' : 'bilibili';
    const otherApi = otherPlatform === 'bilibili' ? BilibiliAPI : DouyuAPI;
    const otherResult = await otherApi.resolveNickname(roomId);
    if (otherResult.success) {
      platform = otherPlatform;
      resolveResult = otherResult;
    }
  }

  if (!resolveResult.success) {
    return { ok: false, error: '房间号不存在或无法访问' };
  }

  // 添加到列表
  rooms.push({ roomId, nickname: resolveResult.nickname, platform, notify: false });
  await StorageHelper.set('rooms', rooms);

  const notified = (await StorageHelper.get('notifiedRooms')) || [];
  if (!notified.some(n => n.roomId === roomId && n.platform === platform)) {
    notified.push({ roomId, platform });
    await StorageHelper.set('notifiedRooms', notified);
  }

  await refreshRooms();
  await syncBarrageRooms();
  // 立即采样一次观众数，不用等下一个 10 分钟周期
  await sampleViewerCounts();

  return { ok: true, nickname: resolveResult.nickname };
}

async function handleRemoveRoom(roomId, platform) {
  platform = platform || 'douyu';
  let rooms = (await StorageHelper.get('rooms')) || [];
  rooms = rooms.filter(r => !(r.roomId === roomId && r.platform === platform));
  await StorageHelper.set('rooms', rooms);

  // 也从 streamers 中移除
  let streamers = (await StorageHelper.get('streamers')) || [];
  streamers = streamers.filter(s => !(s.roomId === roomId && s.platform === platform));
  await StorageHelper.set('streamers', streamers);

  // Update badge
  const onlineCount = streamers.filter(s => s.online).length;
  chrome.action.setBadgeText({ text: onlineCount > 0 ? String(onlineCount) : '' });

  await syncBarrageRooms();
  // 移除房间后立即采样，刷新剩余房间的观众数
  await sampleViewerCounts();

  return { ok: true };
}
