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
// 订阅 ONLINE_RANK_COUNT 消息（高能榜在线数），约每 4-6 秒推送一次
// 若 SW 直连被风控（如豆包+登录态），降级到页面通道（bilibili-page-bridge.js）
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
  if (!(await isViewerFetchEnabled())) {
    // 关闭观众数获取：停用页面通道，清除已存观众数，关闭桥接标签页
    biliPageChannelEnabled = false;
    await StorageHelper.set('biliPageChannelEnabled', false);
    await stripViewerCounts();
    const tabs = await chrome.tabs.query({ url: 'https://live.bilibili.com/*' });
    for (const tab of tabs) {
      if (tab.url && tab.url.includes('dyext=1')) {
        chrome.tabs.remove(tab.id).catch(() => {});
      }
    }
    return;
  }
  // 恢复页面通道降级状态（SW 重启后从 storage 恢复，避免反复直连→降级循环）
  const pageEnabled = biliPageChannelEnabled
    || (await StorageHelper.get('biliPageChannelEnabled')) === true;
  if (pageEnabled) {
    biliPageChannelEnabled = true;
    await ensureBridgeTab();
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
  streamers[index] = { ...streamers[index], rankCount };
  await StorageHelper.set('streamers', streamers);
  console.log(`[bili] updateRankCount 已写入 ${roomId} rankCount=${rankCount}`);
}

// === B站弹幕页面通道（降级方案） ===
// 部分浏览器（如豆包）登录 B站后，SW 直连 WS 携带登录 Cookie 被 B站风控断开。
// 检测到后切换为 content script 在 B站页面上下文建连（lib/bilibili-page-bridge.js），
// 通过 chrome.runtime 消息回传高能榜在线数。
const BRIDGE_TAB_URL = 'https://live.bilibili.com/?dyext=1'; // 桥接标签页标记 URL
let biliPageChannelEnabled = false;

// SW 直连采样被风控（连续多轮快速断开）→ 降级到页面通道
async function handleBiliChannelFallback() {
  if (biliPageChannelEnabled || !(await isViewerFetchEnabled())) {
    return;
  }
  biliPageChannelEnabled = true;
  await StorageHelper.set('biliPageChannelEnabled', true); // 持久化，SW 重启后仍走页面通道
  console.warn('[bili] SW 直连采样被风控，切换到页面通道');
  // 停止 SW 直连采样，避免继续触发风控
  bilibiliBarrageClient.sample([]);
  await ensureBridgeTab();
  try {
    await chrome.notifications.create('bili_bridge_fallback', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'B站高能榜连接已切换通道',
      message: '当前浏览器拦截了扩展直连，已自动打开一个后台 B站标签页作为桥接。请勿关闭该标签页。',
      priority: 1
    });
  } catch (e) {
    // 通知失败不影响功能
  }
}

// 确保桥接标签页存在（优先复用已打开的，否则自动创建，不抢焦点）
async function ensureBridgeTab() {
  const tabs = await chrome.tabs.query({ url: 'https://live.bilibili.com/*' });
  const existing = tabs.find(t => t.url && t.url.includes('dyext=1'));
  if (existing) {
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: BRIDGE_TAB_URL, active: false });
  return tab.id;
}

// 桥接标签页被用户关闭后自动重开
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!biliPageChannelEnabled) {
    return;
  }
  setTimeout(() => {
    if (biliPageChannelEnabled) {
      ensureBridgeTab().catch(() => {});
    }
  }, 1000);
});

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
// 拿到数据立即断开，平时零 WS 连接（由 chrome.alarms 驱动，SW 休眠后自动恢复）
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
      // 页面通道：由桥接标签页在页面上下文采样，结果经 BILI_RANK_COUNT 回传
      const tabs = await chrome.tabs.query({ url: 'https://live.bilibili.com/*' });
      for (const tab of tabs) {
        if (tab.url && tab.url.includes('dyext=1')) {
          chrome.tabs.sendMessage(tab.id, { type: 'BILI_SAMPLE_ROOMS', roomIds: bilibiliIds }).catch(() => {
            // content script 未就绪（页面加载中），下一轮再采样
          });
        }
      }
    } else {
      bilibiliBarrageClient.sample(bilibiliIds);
    }
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
