# Cookie 转房间号监控重构 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将斗鱼开播通知 Chrome 扩展从 Cookie 鉴权改为房间号直连监控，用户只需输入房间号即可监控直播状态

**Architecture:** 移除 Cookie 相关逻辑，新增 `DouyuAPI.fetchRoomInfo(roomId)` 公开 API 查询，Options 页改为房间号管理 UI，Service Worker 轮询逻辑改为遍历房间列表并行查询

**Tech Stack:** Chrome Extension Manifest V3, vanilla JS, chrome.storage.local, chrome.alarms, chrome.notifications

## Global Constraints

- 所有数据存储在 chrome.storage.local 中，不可外传
- API 基址: `https://www.douyu.com`
- 刷新间隔最小 60 秒
- 代码文件编码: UTF-8
- 在 Chrome 中加载已解压的扩展进行验证

---

## 文件结构

| 文件 | 改动 | 职责 |
|------|------|------|
| `lib/storage.js` | 修改 | `DEFAULT_STORAGE` 中 `cookie` → `rooms` |
| `lib/douyu-api.js` | 重写 | 移除 Cookie 方法，新增 `fetchRoomInfo` / `batchFetchRoomInfo` |
| `background.js` | 中等改动 | 轮询逻辑从关注列表 API → 遍历房间号并行查询 |
| `options/options.html` | 重写 | 移除 Cookie 卡片，改为房间号管理 UI |
| `options/options.js` | 重写 | Cookie 保存/测试 → 房间号增删/自动解析 |
| `options/options.css` | 微调 | 适应新 UI 布局 |
| `popup/popup.html` | 小改 | 移除 cookieExpired 状态，noCookie → noRoom |
| `popup/popup.js` | 小改 | 移除 Cookie 过期检测逻辑 |

---

### Task 1: Storage 模块 — 数据结构迁移

**Files:**
- Modify: `lib/storage.js` (DEFAULT_STORAGE)

**Interfaces:**
- Produces: 新的 `DEFAULT_STORAGE`，用 `rooms` 替换 `cookie`，移除 `_cookieError`

- [ ] **Step 1: 修改 DEFAULT_STORAGE**

将 `lib/storage.js` 中的 `DEFAULT_STORAGE`：

```diff
 const DEFAULT_STORAGE = {
-  cookie: {
-    value: '',
-    lastChecked: 0
-  },
+  rooms: [],
   streamers: [],
   lastRefresh: 0,
   notifiedRooms: [],
   settings: {
     refreshInterval: 60,
     notificationsEnabled: true
   }
 };
```

- [ ] **Step 2: 提交**

```bash
git add lib/storage.js
git commit -m "refactor(storage): replace cookie with rooms in DEFAULT_STORAGE"
```

---

### Task 2: API 模块 — 重写为公开房间 API

**Files:**
- Rewrite: `lib/douyu-api.js`

**Interfaces:**
- Produces: `DouyuAPI.fetchRoomInfo(roomId)` → `{ success: true, data: { roomId, nickname, title, online, ... } }`
- Produces: `DouyuAPI.batchFetchRoomInfo(roomIds)` → `{ success: true, data: [...] }`
- Removes: `_parseCookie`, `validateCookie`, `fetchFollowList`, `testCookie`

- [ ] **Step 1: 重写 lib/douyu-api.js**

```javascript
// lib/douyu-api.js — 斗鱼 API 封装（公开 API，无需 Cookie）

const API_BASE = 'https://www.douyu.com';

const DouyuAPI = {
  /**
   * 查询单个房间的直播信息
   * 使用公开 API，不需要 Cookie
   * @param {string} roomId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async fetchRoomInfo(roomId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${API_BASE}/japi/room/info/${roomId}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      clearTimeout(timeout);

      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        return { success: false, error: 'parse_error' };
      }

      if (result.error !== 0) {
        return { success: false, error: `api_error_${result.error}` };
      }

      const d = result.data || {};
      return {
        success: true,
        data: {
          roomId: String(d.room_id || roomId),
          nickname: d.owner_name || '',
          title: d.room_name || '',
          online: String(d.show_status) === '1',
          coverUrl: d.room_src || '',
          avatarUrl: d.owner_avatar || '',
          viewers: parseInt(d.hn, 10) || 0,
          category: d.cate_name || '',
          startTime: d.show_time ? parseInt(d.show_time, 10) * 1000 : 0
        }
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { success: false, error: 'timeout' };
      }
      return { success: false, error: 'network_error', message: err.message };
    }
  },

  /**
   * 批量查询多个房间的直播状态（并行）
   * @param {string[]} roomIds
   * @returns {Promise<{success: boolean, data: Array, errors: Array}>}
   */
  async batchFetchRoomInfo(roomIds) {
    if (!roomIds || roomIds.length === 0) {
      return { success: true, data: [], errors: [] };
    }

    const results = await Promise.allSettled(
      roomIds.map(id => this.fetchRoomInfo(id))
    );

    const data = [];
    const errors = [];

    results.forEach((r, index) => {
      if (r.status === 'fulfilled' && r.value.success) {
        data.push(r.value.data);
      } else if (r.status === 'fulfilled') {
        errors.push({ roomId: roomIds[index], error: r.value.error });
      } else {
        errors.push({ roomId: roomIds[index], error: r.reason?.message || 'unknown' });
      }
    });

    return { success: data.length > 0, data, errors };
  },

  /**
   * 根据房间号解析主播名（添加房间时使用）
   * @param {string} roomId
   * @returns {Promise<{success: boolean, nickname?: string, error?: string}>}
   */
  async resolveNickname(roomId) {
    const result = await this.fetchRoomInfo(roomId);
    if (result.success) {
      return { success: true, nickname: result.data.nickname };
    }
    return { success: false, error: result.error };
  }
};
```

- [ ] **Step 2: 提交**

```bash
git add lib/douyu-api.js
git commit -m "refactor(api): rewrite to public room API, remove cookie methods"
```

---

### Task 3: Service Worker — 轮询逻辑改造

**Files:**
- Modify: `background.js`

**Interfaces:**
- Consumes: 新的 `DouyuAPI.batchFetchRoomInfo(roomIds)`, 新的 `StorageHelper.get('rooms')`
- Removes: `refreshFollowList` 中的 Cookie 读取和过期标记
- Message changes: 移除 `TEST_COOKIE` 处理，新增 `ADD_ROOM` 处理

- [ ] **Step 1: 重写 background.js**

```javascript
// background.js — Service Worker

importScripts('lib/storage.js');
importScripts('lib/douyu-api.js');

// === 初始化 ===
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await StorageHelper.getAll();
  if (Object.keys(existing).length === 0) {
    await chrome.storage.local.set(DEFAULT_STORAGE);
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

  return { ok: true };
}
```

- [ ] **Step 2: 提交**

```bash
git add background.js
git commit -m "refactor(background): switch to room-based polling, remove cookie logic"
```

---

### Task 4: Options 设置页 — 房间号管理 UI

**Files:**
- Rewrite: `options/options.html`
- Rewrite: `options/options.js`
- Minor modify: `options/options.css`（移除 Cookie 相关样式，添加房间列表样式）

- [ ] **Step 1: 重写 options/options.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="options.css">
  <title>斗鱼直播通知 - 设置</title>
</head>
<body>
  <div class="container">
    <h1>⚙️ 斗鱼直播通知 设置</h1>

    <section class="card">
      <h2>📺 房间号管理</h2>
      <p class="hint">添加要监控的斗鱼直播间房间号</p>
      <div class="input-row">
        <input type="text" id="roomIdInput" placeholder="输入房间号（如 12345）" autocomplete="off">
        <button id="addRoomBtn" class="btn primary">➕ 添加</button>
      </div>
      <div id="addStatus" class="status hidden"></div>
      <div id="roomList" class="room-list"></div>
      <div id="emptyRooms" class="empty-hint">尚未添加房间，请输入房间号并点击添加</div>
      <button id="refreshStatusBtn" class="btn" style="margin-top:12px">🔄 刷新全部状态</button>
    </section>

    <section class="card">
      <h2>⏱️ 刷新设置</h2>
      <div class="setting-row">
        <label for="refreshInterval">轮询间隔（秒，最小 60）：</label>
        <input type="number" id="refreshInterval" min="60" value="60" step="30">
      </div>
      <button id="saveSettingsBtn" class="btn primary">💾 保存设置</button>
      <div id="settingsStatus" class="status hidden"></div>
    </section>

    <section class="card">
      <h2>🔔 通知设置</h2>
      <label class="toggle-row">
        <input type="checkbox" id="notificationsEnabled" checked>
        <span>新开播时发送桌面通知</span>
      </label>
    </section>
  </div>

  <script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: 重写 options/options.js**

```javascript
// options/options.js — 设置页逻辑（房间号管理版）

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get(null);

  const roomIdInput = document.getElementById('roomIdInput');
  const addRoomBtn = document.getElementById('addRoomBtn');
  const roomList = document.getElementById('roomList');
  const emptyRooms = document.getElementById('emptyRooms');
  const refreshStatusBtn = document.getElementById('refreshStatusBtn');
  const addStatus = document.getElementById('addStatus');
  const refreshInterval = document.getElementById('refreshInterval');
  const notificationsEnabled = document.getElementById('notificationsEnabled');

  // 加载现有设置
  if (data.settings?.refreshInterval) {
    refreshInterval.value = data.settings.refreshInterval;
  }
  if (data.settings?.notificationsEnabled !== undefined) {
    notificationsEnabled.checked = data.settings.notificationsEnabled;
  }

  // 渲染房间列表
  async function renderRoomList() {
    const rooms = (await chrome.storage.local.get('rooms')).rooms || [];
    const streamers = (await chrome.storage.local.get('streamers')).streamers || [];
    const onlineMap = {};
    streamers.forEach(s => { onlineMap[s.roomId] = s.online; });

    if (rooms.length === 0) {
      roomList.innerHTML = '';
      emptyRooms.classList.remove('hidden');
      return;
    }
    emptyRooms.classList.add('hidden');

    roomList.innerHTML = rooms.map(r => {
      const isOnline = onlineMap[r.roomId];
      const statusIcon = isOnline ? '🟢' : '🔴';
      return `
        <div class="room-item" data-room-id="${r.roomId}">
          <span class="room-status">${statusIcon}</span>
          <span class="room-id">${r.roomId}</span>
          <span class="room-nickname">${escapeHtml(r.nickname || '未知')}</span>
          <button class="btn-remove" data-room-id="${r.roomId}">✕</button>
        </div>
      `;
    }).join('');

    // 删除按钮事件
    document.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const roomId = btn.dataset.roomId;
        chrome.runtime.sendMessage({ type: 'REMOVE_ROOM', roomId }, () => {
          renderRoomList();
        });
      });
    });
  }

  // 添加房间
  async function handleAddRoom() {
    const roomId = roomIdInput.value.trim();
    if (!roomId) {
      showStatus(addStatus, '请输入房间号', 'error');
      return;
    }
    if (!/^\d+$/.test(roomId)) {
      showStatus(addStatus, '房间号必须为纯数字', 'error');
      return;
    }

    showStatus(addStatus, '⏳ 正在解析房间号...', 'info');
    addRoomBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'ADD_ROOM', roomId }, (response) => {
      addRoomBtn.disabled = false;
      if (response?.ok) {
        roomIdInput.value = '';
        showStatus(addStatus, `✅ 已添加：${response.nickname}`, 'success');
        renderRoomList();
      } else {
        showStatus(addStatus, `❌ ${response?.error || '添加失败'}`, 'error');
      }
    });
  }

  addRoomBtn.addEventListener('click', handleAddRoom);
  roomIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddRoom();
  });

  // 刷新全部状态
  refreshStatusBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'MANUAL_REFRESH' }, () => {
      renderRoomList();
      showStatus(addStatus, '🔄 状态已刷新', 'success');
      setTimeout(() => addStatus.classList.add('hidden'), 2000);
    });
  });

  // 保存设置
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const interval = Math.max(60, parseInt(refreshInterval.value, 10) || 60);
    refreshInterval.value = interval;
    await chrome.storage.local.set({
      settings: {
        refreshInterval: interval,
        notificationsEnabled: notificationsEnabled.checked
      }
    });
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
    showStatus(document.getElementById('settingsStatus'), '✅ 设置已保存', 'success');
  });

  notificationsEnabled.addEventListener('change', async () => {
    const data = await chrome.storage.local.get('settings');
    const settings = data.settings || {};
    settings.notificationsEnabled = notificationsEnabled.checked;
    await chrome.storage.local.set({ settings });
  });

  // 初始渲染
  await renderRoomList();
});

function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
```

- [ ] **Step 3: 更新 options/options.css — 追加房间列表样式**

在文件末尾追加：

```css
/* === 房间号管理 === */
.input-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.input-row input[type="text"] {
  flex: 1;
  padding: 8px 12px;
  font-size: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: none;
  transition: border-color 0.2s;
}

.input-row input[type="text"]:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(255, 68, 0, 0.15);
}

.room-list {
  margin-top: 16px;
}

.room-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 6px;
  background: #fafafa;
  transition: background 0.15s;
}

.room-item:hover {
  background: #f0f0f0;
}

.room-status {
  font-size: 14px;
  flex-shrink: 0;
}

.room-id {
  font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
  font-size: 13px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.room-nickname {
  flex: 1;
  font-size: 14px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-remove {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: #999;
  font-size: 14px;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
  flex-shrink: 0;
}

.btn-remove:hover {
  color: var(--error);
  background: #fef2f2;
}

.empty-hint {
  text-align: center;
  padding: 20px;
  color: #aaa;
  font-size: 14px;
}

.empty-hint.hidden {
  display: none;
}
```

- [ ] **Step 4: 提交**

```bash
git add options/options.html options/options.js options/options.css
git commit -m "feat(options): room management UI, remove cookie UI"
```

---

### Task 5: Popup 弹窗 — 移除 Cookie 状态

**Files:**
- Modify: `popup/popup.html`
- Modify: `popup/popup.js`

- [ ] **Step 1: 修改 popup/popup.html — 移除 cookieExpired，noCookie → noRoom**

```diff
     <div id="loading" class="state-msg">加载中...</div>
-    <div id="noCookie" class="state-msg hidden">
-      <p>⚠️ 未配置 Cookie</p>
-      <p class="sub">请前往 <a href="#" id="openOptions">设置页</a> 配置 Cookie</p>
+    <div id="noRoom" class="state-msg hidden">
+      <p>⚠️ 未配置监控房间</p>
+      <p class="sub">请前往 <a href="#" id="openOptions">设置页</a> 添加房间号</p>
     </div>
-    <div id="cookieExpired" class="state-msg hidden">
-      <p>⚠️ Cookie 已过期</p>
-      <p class="sub">请前往 <a href="#" id="openOptionsExpired">设置页</a> 更新 Cookie</p>
-    </div>
     <div id="emptyState" class="state-msg hidden">
```

同时移除 `openOptionsExpired` 相关的事件绑定（第 2 步的 JS 中处理）。

- [ ] **Step 2: 修改 popup/popup.js — 移除 Cookie 检测逻辑**

```diff
 document.addEventListener('DOMContentLoaded', async () => {
   const streamerList = document.getElementById('streamerList');
   const onlineCount = document.getElementById('onlineCount');
   const loading = document.getElementById('loading');
-  const noCookie = document.getElementById('noCookie');
-  const cookieExpired = document.getElementById('cookieExpired');
+  const noRoom = document.getElementById('noRoom');
   const emptyState = document.getElementById('emptyState');
   const errorState = document.getElementById('errorState');

   // 打开设置页
   document.getElementById('openOptions').addEventListener('click', openOptions);
-  document.getElementById('openOptionsExpired').addEventListener('click', openOptions);
   document.getElementById('settingsBtn').addEventListener('click', openOptions);
```

在 `loadData()` 函数中：

```diff
 async function loadData() {
   const streamerList = document.getElementById('streamerList');
   const onlineCount = document.getElementById('onlineCount');
   const loading = document.getElementById('loading');
-  const noCookie = document.getElementById('noCookie');
-  const cookieExpired = document.getElementById('cookieExpired');
+  const noRoom = document.getElementById('noRoom');
   const emptyState = document.getElementById('emptyState');
   const errorState = document.getElementById('errorState');

   // 隐藏所有状态
-  [noCookie, cookieExpired, emptyState, errorState, streamerList].forEach(el => el.classList.add('hidden'));
+  [noRoom, emptyState, errorState, streamerList].forEach(el => el.classList.add('hidden'));
   loading.classList.remove('hidden');

   try {
     const data = await chrome.storage.local.get(null);
     loading.classList.add('hidden');

-    // Cookie 检查
-    const cookie = data.cookie;
-    if (!cookie || !cookie.value) {
-      noCookie.classList.remove('hidden');
-      return;
-    }
-
-    // 检查是否标记为过期
-    if (data._cookieError === 'expired') {
-      cookieExpired.classList.remove('hidden');
+    // 房间号检查
+    const rooms = data.rooms;
+    if (!rooms || rooms.length === 0) {
+      noRoom.classList.remove('hidden');
       return;
     }
```

- [ ] **Step 3: 提交**

```bash
git add popup/popup.html popup/popup.js
git commit -m "refactor(popup): remove cookie expired state, add no-room state"
```

---

### Task 6: 完整性验证

**Files:** 无需修改

- [ ] **Step 1: 确认所有文件一致性**

```bash
# 搜索是否还有残留的 cookie 引用（排除文档和 git）
rg -i "cookie" --type html --type js background.js manifest.json
```

预期输出：仅 manifest.json 中的 `host_permissions: "https://www.douyu.com/*"` 和 background.js 中无 cookie 相关代码。options/options.js 中不应有 cookie 相关代码。

- [ ] **Step 2: 在 Chrome 中加载扩展并测试**

```
1. 打开 Chrome → chrome://extensions
2. 点击"重新加载"（如果已加载）或"加载已解压的扩展程序"
3. 确认扩展出现在列表中且无错误（无红字提示）
```

- [ ] **Step 3: 功能测试**

```
1. Options 页: 输入房间号 → 添加 → 确认自动解析出主播名
2. Options 页: 确认房间列表显示在线状态
3. Options 页: 添加重复房间号 → 应有"已在列表中"提示
4. Options 页: 添加无效房间号 → 应有"不存在"提示
5. Options 页: 点击 ✕ 删除房间
6. Popup: 点击扩展图标 → 显示开播主播列表
7. Popup: 未配置房间 → 显示"未配置监控房间"
8. Popup: 所有离线 → 显示"当前没有主播开播"
9. 通知: 有主播开播 → 收到桌面通知
```

- [ ] **Step 4: 提交最终清理**

```bash
git add -A
git commit -m "chore: final cleanup after cookie-to-room refactor"
```
