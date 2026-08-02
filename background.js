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
const bilibiliBarrageClient = new BilibiliBarrageClient({
  onRankCount: updateRankCount
});

// Service Worker 每次唤醒时同步订阅列表
syncBarrageRooms();

// 订阅所有斗鱼/B站房间的弹幕连接
async function syncBarrageRooms() {
  const rooms = (await StorageHelper.get('rooms')) || [];
  const douyuIds = rooms.filter(r => r.platform === 'douyu').map(r => String(r.roomId));
  barrageClient.setRooms(douyuIds);
  const bilibiliIds = rooms.filter(r => r.platform === 'bilibili').map(r => String(r.roomId));
  bilibiliBarrageClient.setRooms(bilibiliIds);
}

// 收到 oni 推送 → 更新 streamers[].vipCount（写入 storage 供 popup 读取）
async function updateVipCount({ roomId, vipCount }) {
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
  const streamers = (await StorageHelper.get('streamers')) || [];
  const index = streamers.findIndex(s => s.platform === 'bilibili' && String(s.roomId) === String(roomId));
  if (index === -1) {
    return;
  }
  streamers[index] = { ...streamers[index], rankCount };
  await StorageHelper.set('streamers', streamers);
}

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
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refreshRooms') {
    await refreshRooms();
  }
});

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
      createAlarm().then(() => sendResponse({ ok: true }));
      return true;

    case 'ADD_ROOM':
      handleAddRoom(message.roomId, message.platform).then(sendResponse);
      return true;

    case 'REMOVE_ROOM':
      handleRemoveRoom(message.roomId, message.platform).then(sendResponse);
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

  return { ok: true };
}
