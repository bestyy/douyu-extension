// background.js — Service Worker

importScripts('lib/storage.js');
importScripts('lib/douyu-api.js');

// === 初始化 ===
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await StorageHelper.getAll();
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

  const roomIds = rooms.map(r => r.roomId);
  const result = await DouyuAPI.batchFetchRoomInfo(roomIds);

  if (!result.success && result.data.length === 0) {
    return; // 所有房间查询失败，保留上次缓存
  }

  // 获取之前的直播列表用于检测新开播
  const prevStreamers = (await StorageHelper.get('streamers')) || [];
  const prevOnlineRoomIds = new Set(
    prevStreamers.filter(s => s.online).map(s => s.roomId)
  );

  // 更新存储
  await StorageHelper.set('streamers', result.data);
  await StorageHelper.set('lastRefresh', Date.now());

  // 更新 badge
  const onlineCount = result.data.filter(s => s.online).length;
  chrome.action.setBadgeText({ text: onlineCount > 0 ? String(onlineCount) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF4400' });

  // 首次运行标记
  const isFirstRun = (await StorageHelper.get('_firstRun')) === true;
  if (isFirstRun) {
    const onlineIds = result.data.filter(s => s.online).map(s => s.roomId);
    await StorageHelper.set('notifiedRooms', onlineIds);
    await StorageHelper.set('_firstRun', null);
  } else {
    // 检测新开播 → 发送通知
    const settings = await StorageHelper.get('settings');
    if (settings?.notificationsEnabled !== false) {
      await checkNewLiveStreams(result.data, prevOnlineRoomIds);
    }
  }
}

// === 新开播通知 ===
async function checkNewLiveStreams(currentStreamers, prevOnlineRoomIds) {
  const notifiedRooms = new Set((await StorageHelper.get('notifiedRooms')) || []);

  for (const streamer of currentStreamers) {
    if (!streamer.online) continue;

    const isNewlyLive = !prevOnlineRoomIds.has(streamer.roomId);
    const alreadyNotified = notifiedRooms.has(streamer.roomId);

    if (isNewlyLive && !alreadyNotified) {
      try {
        await chrome.notifications.create(streamer.roomId, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: `🔴 ${streamer.nickname} 开播了！`,
          message: streamer.title || '正在直播',
          contextMessage: `${streamer.category} · ${streamer.viewers} 人观看`,
          buttons: [{ title: '进入直播间' }],
          priority: 2
        });
        notifiedRooms.add(streamer.roomId);
      } catch (e) {
        console.error('通知创建失败:', e);
      }
    }
  }

  const onlineRoomIds = new Set(currentStreamers.filter(s => s.online).map(s => s.roomId));
  const updatedNotified = [...notifiedRooms].filter(id => onlineRoomIds.has(id));
  await StorageHelper.set('notifiedRooms', updatedNotified);
}

// === 通知按钮点击 ===
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    chrome.tabs.create({ url: `https://www.douyu.com/${notificationId}` });
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.tabs.create({ url: `https://www.douyu.com/${notificationId}` });
});

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
      handleAddRoom(message.roomId).then(sendResponse);
      return true;

    case 'REMOVE_ROOM':
      handleRemoveRoom(message.roomId).then(sendResponse);
      return true;

    default:
      sendResponse({ ok: false });
  }
});

// === 房间管理 ===
async function handleAddRoom(roomId) {
  // 验证房间号格式
  if (!roomId || !/^\d+$/.test(roomId.trim())) {
    return { ok: false, error: '房间号格式无效' };
  }
  roomId = roomId.trim();

  // 检查是否已存在
  const rooms = (await StorageHelper.get('rooms')) || [];
  if (rooms.some(r => r.roomId === roomId)) {
    return { ok: false, error: '该房间已在监控列表中' };
  }

  // 解析主播名
  const resolveResult = await DouyuAPI.resolveNickname(roomId);
  if (!resolveResult.success) {
    return { ok: false, error: '房间号不存在或无法访问' };
  }

  // 添加到列表
  rooms.push({ roomId, nickname: resolveResult.nickname });
  await StorageHelper.set('rooms', rooms);

  // Pre-add to notifiedRooms to prevent immediate notification
  const notified = (await StorageHelper.get('notifiedRooms')) || [];
  if (!notified.includes(roomId)) {
    notified.push(roomId);
    await StorageHelper.set('notifiedRooms', notified);
  }

  // 立即触发一次刷新，使新房间的状态尽快可见
  refreshRooms();

  return { ok: true, nickname: resolveResult.nickname };
}

async function handleRemoveRoom(roomId) {
  let rooms = (await StorageHelper.get('rooms')) || [];
  rooms = rooms.filter(r => r.roomId !== roomId);
  await StorageHelper.set('rooms', rooms);

  // 也从 streamers 中移除
  let streamers = (await StorageHelper.get('streamers')) || [];
  streamers = streamers.filter(s => s.roomId !== roomId);
  await StorageHelper.set('streamers', streamers);

  // Update badge
  const onlineCount = streamers.filter(s => s.online).length;
  chrome.action.setBadgeText({ text: onlineCount > 0 ? String(onlineCount) : '' });

  return { ok: true };
}
