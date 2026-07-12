// background.js — Service Worker

importScripts('lib/storage.js');
importScripts('lib/douyu-api.js');

// === 初始化 ===
chrome.runtime.onInstalled.addListener(async () => {
  // 初始化默认存储
  const existing = await StorageHelper.getAll();
  if (Object.keys(existing).length === 0) {
    await chrome.storage.local.set(DEFAULT_STORAGE);
  }
  // 创建定时器
  await createAlarm();
});

// === 定时器管理 ===
async function createAlarm() {
  const settings = await StorageHelper.get('settings');
  const interval = settings?.refreshInterval || 60;
  // 最小 60 秒
  const minutes = Math.max(1, Math.floor(interval / 60));
  chrome.alarms.create('refreshFollowList', { periodInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refreshFollowList') {
    await refreshFollowList();
  }
});

// === 核心轮询逻辑 ===
async function refreshFollowList() {
  const cookie = await StorageHelper.get('cookie');
  if (!cookie || !cookie.value) {
    return; // 未配置 Cookie，跳过
  }

  const result = await DouyuAPI.fetchFollowList(cookie.value);

  if (!result.success) {
    if (result.error === 'cookie_expired') {
      // 标记 cookie 失效
      await StorageHelper.set('cookie', { ...cookie, lastChecked: Date.now() });
      await StorageHelper.set('_cookieError', 'expired');
    }
    return;
  }

  // 清除过期标记
  await StorageHelper.set('_cookieError', null);

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

  // 检测新开播 → 发送通知
  const settings = await StorageHelper.get('settings');
  if (settings?.notificationsEnabled !== false) {
    await checkNewLiveStreams(result.data, prevOnlineRoomIds);
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
      // 发送通知
      chrome.notifications.create(streamer.roomId, {
        type: 'basic',
        iconUrl: streamer.coverUrl || 'icons/icon128.png',
        title: `🔴 ${streamer.nickname} 开播了！`,
        message: streamer.title || '正在直播',
        contextMessage: `${streamer.category} · ${streamer.viewers} 人观看`,
        buttons: [{ title: '进入直播间' }],
        priority: 2
      });

      notifiedRooms.add(streamer.roomId);
    }
  }

  // 清理已下播的房间通知记录
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
