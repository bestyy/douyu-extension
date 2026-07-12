# Bilibili 直播间监控支持 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有斗鱼开播通知 Chrome 扩展增加 Bilibili 直播平台的房间监控功能

**Architecture:** 平行扩展方案——新增 `lib/bilibili-api.js` 封装 Bilibili 公开 API，在 `background.js` 中按平台分组轮询，rooms/streamers/notifiedRooms 存储增加 `platform` 字段区分平台，UI 组件增加平台标识标签。

**Tech Stack:** Chrome Extension MV3, 原生 JavaScript, chrome.storage.local

## Global Constraints

- 所有新代码遵循现有代码风格（ES6+, async/await, JSDoc 注释）
- 不加第三方依赖
- 不加 npm 包、构建工具
- 保持与 Chrome Extension MV3 兼容（Service Worker，无 DOM API）
- Bilibili API 使用公开端点，不需要 Cookie/鉴权
- 向后兼容已有斗鱼数据（旧格式自动迁移）

---

### Task 1: 创建 `lib/bilibili-api.js`

**Files:**
- Create: `lib/bilibili-api.js`

**Interfaces:**
- Produces: `BilibiliAPI.fetchRoomInfo(roomId)`, `BilibiliAPI.batchFetchRoomInfo(roomIds)`, `BilibiliAPI.resolveNickname(roomId)`

- [ ] **Step 1: 编写 `lib/bilibili-api.js` 完整文件

```javascript
// lib/bilibili-api.js — Bilibili 公开 API 封装

const BILIBILI_LIVE_API = 'https://api.live.bilibili.com';

const BilibiliAPI = {
  /**
   * 查询单个房间的直播信息
   * 使用 Bilibili 公开 API，无需 Cookie
   * @param {string} roomId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async fetchRoomInfo(roomId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      // Step 1: 获取房间基本信息
      const roomResp = await fetch(
        `${BILIBILI_LIVE_API}/room/v1/Room/get_info?room_id=${roomId}`,
        {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }
      );

      if (!roomResp.ok) {
        clearTimeout(timeout);
        return { success: false, error: 'http_error' };
      }

      const roomData = await roomResp.json();
      clearTimeout(timeout);

      if (roomData.code !== 0 || !roomData.data) {
        return { success: false, error: 'room_not_found' };
      }

      const d = roomData.data;
      const uid = d.uid;

      // Step 2: 获取主播个人信息（昵称、头像）
      let nickname = '';
      let avatarUrl = '';

      if (uid) {
        try {
          const userResp = await fetch(
            `${BILIBILI_LIVE_API}/live_user/v1/UserInfo/get_uid_info?uid=${uid}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
              }
            }
          );
          if (userResp.ok) {
            const userData = await userResp.json();
            if (userData.code === 0 && userData.data) {
              nickname = userData.data.uname || '';
              avatarUrl = userData.data.face || '';
            }
          }
        } catch (e) {
          // 用户信息获取失败时，使用 room info 中的字段
        }
      }

      // 兜底：从 room info 拿主播名
      if (!nickname) {
        nickname = d.uname || '';
      }

      return {
        success: true,
        data: {
          roomId: String(d.room_id || roomId),
          nickname: nickname,
          title: d.title || '',
          online: d.live_status === 1,
          coverUrl: d.user_cover || d.keyframe || '',
          avatarUrl: avatarUrl || d.face || '',
          viewers: d.online || 0,
          category: d.parent_area_name || d.area_name || '',
          startTime: d.live_time ? new Date(d.live_time).getTime() : 0
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
        errors.push({ roomId: roomIds[index], error: r.reason?.message || String(r.reason || 'unknown') });
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

- [ ] **Step 2: 验证文件语法正确性**

Run: `node --check lib/bilibili-api.js`
Expected: No error (may need `node` available, otherwise skip this step)

---

### Task 2: 更新 `manifest.json` 和 `lib/storage.js`

**Files:**
- Modify: `manifest.json`
- Modify: `lib/storage.js`

**Interfaces:**
- Produces: 新增 `host_permissions` 条目、`notifiedRooms` 格式迁移函数

- [ ] **Step 1: 更新 manifest.json 增加 Bilibili 权限**

在 `manifest.json` 的 `host_permissions` 数组中添加 `https://api.live.bilibili.com/*`。

```json
"host_permissions": [
  "https://www.douyu.com/*",
  "https://api.live.bilibili.com/*"
]
```

- [ ] **Step 2: 更新 lib/storage.js 增加数据迁移函数**

在 `StorageHelper` 对象中添加 `migrateLegacyFormat` 方法：

```javascript
// lib/storage.js — 在 StorageHelper 对象末尾添加

  /**
   * 迁移旧格式数据到新格式
   * v1.0.0→v1.1.0: notifiedRooms 从 string[] 迁移为 {roomId, platform}[]
   *                rooms 从 {roomId, nickname} 迁移为 {roomId, nickname, platform}
   */
  async migrateLegacyFormat() {
    let changed = false;
    const all = await this.getAll();

    // 迁移 rooms: 旧格式无 platform 字段
    if (Array.isArray(all.rooms)) {
      let migrated = false;
      const newRooms = all.rooms.map(r => {
        if (typeof r === 'object' && r.roomId && !r.platform) {
          migrated = true;
          return { ...r, platform: 'douyu' };
        }
        return r;
      });
      if (migrated) {
        await this.set('rooms', newRooms);
        changed = true;
      }
    }

    // 迁移 streamers: 旧格式无 platform 字段
    if (Array.isArray(all.streamers)) {
      let migrated = false;
      const newStreamers = all.streamers.map(s => {
        if (typeof s === 'object' && s.roomId && !s.platform) {
          migrated = true;
          return { ...s, platform: 'douyu' };
        }
        return s;
      });
      if (migrated) {
        await this.set('streamers', newStreamers);
        changed = true;
      }
    }

    // 迁移 notifiedRooms: 旧格式是 string[]
    if (Array.isArray(all.notifiedRooms) && all.notifiedRooms.length > 0) {
      const first = all.notifiedRooms[0];
      if (typeof first === 'string') {
        const newNotified = all.notifiedRooms.map(id => ({
          roomId: id,
          platform: 'douyu'
        }));
        await this.set('notifiedRooms', newNotified);
        changed = true;
      }
    }

    return changed;
  }
```

- [ ] **Step 3: 验证修改**

检查 manifest.json 和 storage.js 的语法正确性。

---

### Task 3: 更新 `background.js` — 核心逻辑

**Files:**
- Modify: `background.js`

**Interfaces:**
- Consumes: `BilibiliAPI` (from Task 1), `StorageHelper.migrateLegacyFormat` (from Task 2)
- Produces: 平台感知的轮询、通知、房间管理

- [ ] **Step 1: 导入 BilibiliAPI 并增加迁移调用**

在文件开头的 `importScripts` 中增加 BilibiliAPI，并在 `onInstalled` 中调用迁移：

```javascript
importScripts('lib/storage.js');
importScripts('lib/douyu-api.js');
importScripts('lib/bilibili-api.js');
```

修改 `onInstalled`：

```javascript
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
```

- [ ] **Step 2: 修改 `refreshRooms` — 按平台分组轮询**

```javascript
async function refreshRooms() {
  const rooms = await StorageHelper.get('rooms');
  if (!rooms || rooms.length === 0) {
    return;
  }

  // 按平台分组
  const douyuRooms = rooms.filter(r => r.platform === 'douyu');
  const bilibiliRooms = rooms.filter(r => r.platform === 'bilibili');
  const douyuIds = douyuRooms.map(r => r.roomId);
  const bilibiliIds = bilibiliRooms.map(r => r.roomId);

  // 并行查询两个平台
  const [douyuResult, bilibiliResult] = await Promise.all([
    douyuIds.length > 0 ? DouyuAPI.batchFetchRoomInfo(douyuIds) : { success: true, data: [] },
    bilibiliIds.length > 0 ? BilibiliAPI.batchFetchRoomInfo(bilibiliIds) : { success: true, data: [] }
  ]);

  // 合并结果，给每个数据加上 platform 标记
  let allData = [
    ...douyuResult.data.map(d => ({ ...d, platform: 'douyu' })),
    ...bilibiliResult.data.map(d => ({ ...d, platform: 'bilibili' }))
  ];

  if (allData.length === 0) {
    return;
  }

  // 获取之前的直播列表用于检测新开播
  const prevStreamers = (await StorageHelper.get('streamers')) || [];
  const prevOnline = new Set(
    prevStreamers.filter(s => s.online).map(s => `${s.platform}_${s.roomId}`)
  );

  // 更新存储
  await StorageHelper.set('streamers', allData);
  await StorageHelper.set('lastRefresh', Date.now());

  // 更新 badge
  const onlineCount = allData.filter(s => s.online).length;
  chrome.action.setBadgeText({ text: onlineCount > 0 ? String(onlineCount) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF4400' });

  // 首次运行标记
  const isFirstRun = (await StorageHelper.get('_firstRun')) === true;
  if (isFirstRun) {
    const onlineIds = allData.filter(s => s.online).map(s => ({ roomId: s.roomId, platform: s.platform }));
    await StorageHelper.set('notifiedRooms', onlineIds);
    await StorageHelper.set('_firstRun', null);
  } else {
    const settings = await StorageHelper.get('settings');
    if (settings?.notificationsEnabled !== false) {
      await checkNewLiveStreams(allData, prevOnline);
    }
  }
}
```

- [ ] **Step 3: 修改 `checkNewLiveStreams` — 平台感知的通知**

```javascript
async function checkNewLiveStreams(currentStreamers, prevOnlineSet) {
  const rawNotified = (await StorageHelper.get('notifiedRooms')) || [];
  const notifiedMap = new Set(
    rawNotified.map(n => `${n.platform}_${n.roomId}`)
  );

  for (const streamer of currentStreamers) {
    if (!streamer.online) continue;

    const compositeKey = `${streamer.platform}_${streamer.roomId}`;
    const isNewlyLive = !prevOnlineSet.has(compositeKey);
    const alreadyNotified = notifiedMap.has(compositeKey);

    if (isNewlyLive && !alreadyNotified) {
      // 根据平台选择通知标题前缀和图标
      const platformPrefix = streamer.platform === 'bilibili' ? '🟣 [B站]' : '🔴 [斗鱼]';
      try {
        await chrome.notifications.create(compositeKey, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: `${platformPrefix} ${streamer.nickname} 开播了！`,
          message: streamer.title || '正在直播',
          contextMessage: `${streamer.category} · ${streamer.viewers} 人观看`,
          buttons: [{ title: '进入直播间' }],
          priority: 2
        });
        notifiedMap.add(compositeKey);
      } catch (e) {
        console.error('通知创建失败:', e);
      }
    }
  }

  // 清理已下播的房间通知记录
  const onlineKeys = new Set(
    currentStreamers.filter(s => s.online).map(s => `${s.platform}_${s.roomId}`)
  );
  const updatedNotified = [];
  for (const n of rawNotified) {
    if (onlineKeys.has(`${n.platform}_${n.roomId}`)) {
      updatedNotified.push(n);
    }
  }
  await StorageHelper.set('notifiedRooms', updatedNotified);
}
```

- [ ] **Step 4: 修改通知按钮点击 — 平台感知跳转**

```javascript
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
  const roomId = rest.join('_'); // 防止 roomId 本身含下划线（虽然极少见）
  if (platform === 'bilibili') {
    return `https://live.bilibili.com/${roomId}`;
  }
  return `https://www.douyu.com/${roomId}`;
}
```

- [ ] **Step 5: 修改房间管理 — handleAddRoom / handleRemoveRoom**

```javascript
// 在消息处理中传递 platform
case 'ADD_ROOM':
  handleAddRoom(message.roomId, message.platform).then(sendResponse);
  return true;

case 'REMOVE_ROOM':
  handleRemoveRoom(message.roomId, message.platform).then(sendResponse);
  return true;
```

修改 `handleAddRoom`：

```javascript
async function handleAddRoom(roomId, platform) {
  // 验证房间号格式
  if (!roomId || !/^\d+$/.test(roomId.trim())) {
    return { ok: false, error: '房间号格式无效' };
  }
  roomId = roomId.trim();
  platform = platform || 'douyu'; // 默认斗鱼（向后兼容）

  // 检查是否已存在（同平台+同房间号）
  const rooms = (await StorageHelper.get('rooms')) || [];
  if (rooms.some(r => r.roomId === roomId && r.platform === platform)) {
    return { ok: false, error: '该房间已在监控列表中' };
  }

  // 根据平台选择 API
  const api = platform === 'bilibili' ? BilibiliAPI : DouyuAPI;
  const resolveResult = await api.resolveNickname(roomId);
  if (!resolveResult.success) {
    return { ok: false, error: '房间号不存在或无法访问' };
  }

  // 添加到列表
  rooms.push({ roomId, nickname: resolveResult.nickname, platform });
  await StorageHelper.set('rooms', rooms);

  // Pre-add to notifiedRooms
  const notified = (await StorageHelper.get('notifiedRooms')) || [];
  const compositeKey = `${platform}_${roomId}`;
  if (!notified.some(n => `${n.platform}_${n.roomId}` === compositeKey)) {
    notified.push({ roomId, platform });
    await StorageHelper.set('notifiedRooms', notified);
  }

  // 立即触发一次刷新
  refreshRooms();

  return { ok: true, nickname: resolveResult.nickname };
}
```

修改 `handleRemoveRoom`：

```javascript
async function handleRemoveRoom(roomId, platform) {
  platform = platform || 'douyu';
  let rooms = (await StorageHelper.get('rooms')) || [];
  rooms = rooms.filter(r => !(r.roomId === roomId && r.platform === platform));
  await StorageHelper.set('rooms', rooms);

  // 也从 streamers 中移除
  let streamers = (await StorageHelper.get('streamers')) || [];
  streamers = streamers.filter(s => !(s.roomId === roomId && s.platform === platform));
  await StorageHelper.set('streamers', streamers);

  // 更新 badge
  const onlineCount = streamers.filter(s => s.online).length;
  chrome.action.setBadgeText({ text: onlineCount > 0 ? String(onlineCount) : '' });

  return { ok: true };
}
```

---

### Task 4: 更新 Options 页面 — 平台选择 UI

**Files:**
- Modify: `options/options.html`
- Modify: `options/options.js`
- Modify: `options/options.css`

- [ ] **Step 1: 修改 options.html — 添加平台下拉菜单**

把输入行改为包含平台选择：

```html
<div class="input-row">
  <select id="roomPlatform">
    <option value="douyu">🔴 斗鱼</option>
    <option value="bilibili">🟣 B站</option>
  </select>
  <input type="text" id="roomIdInput" placeholder="输入房间号（如 12345）" autocomplete="off">
  <button id="addRoomBtn" class="btn primary">➕ 添加</button>
</div>
```

- [ ] **Step 2: 修改 options.js — 添加平台参数**

在 `handleAddRoom` 函数中获取平台值：

```javascript
async function handleAddRoom() {
  const roomId = roomIdInput.value.trim();
  const platform = document.getElementById('roomPlatform').value;
  // ... 其余验证逻辑不变 ...

  chrome.runtime.sendMessage({ type: 'ADD_ROOM', roomId, platform }, (response) => {
    // ... 回调不变 ...
  });
}
```

在房间列表渲染中增加平台标签：

```javascript
roomList.innerHTML = rooms.map(r => {
  const isOnline = onlineMap[r.roomId];
  const statusIcon = isOnline ? '🟢' : '🔴';
  const platformLabel = r.platform === 'bilibili' ? '<span class="platform-tag bilibili">B站</span>' : '<span class="platform-tag douyu">斗鱼</span>';
  return `
    <div class="room-item" data-room-id="${r.roomId}">
      <span class="room-status">${statusIcon}</span>
      ${platformLabel}
      <span class="room-id">${r.roomId}</span>
      <span class="room-nickname">${escapeHtml(r.nickname || '未知')}</span>
      <button class="btn-remove" data-room-id="${r.roomId}">✕</button>
    </div>
  `;
}).join('');
```

注意：删除按钮需要 also 传递 platform。修改 `btn-remove` 的事件处理：

```javascript
document.querySelectorAll('.btn-remove').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const roomItem = btn.closest('.room-item');
    const roomId = btn.dataset.roomId;
    const platform = roomItem.dataset.platform || 'douyu';
    chrome.runtime.sendMessage({ type: 'REMOVE_ROOM', roomId, platform }, () => {
      renderRoomList();
    });
  });
});
```

并在渲染时给 `room-item` 加 `data-platform`：

```javascript
return `
  <div class="room-item" data-room-id="${r.roomId}" data-platform="${r.platform}">
    ...
  </div>
`;
```

- [ ] **Step 3: 修改 options.css — 平台标签样式**

```css
/* 平台标签 */
.platform-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}

.platform-tag.douyu {
  background: #fff0eb;
  color: #FF4400;
  border: 1px solid #ffd5cc;
}

.platform-tag.bilibili {
  background: #f0f4ff;
  color: #00a1d6;
  border: 1px solid #cce5ff;
}

/* 平台下拉选择 */
#roomPlatform {
  padding: 8px 10px;
  font-size: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: none;
  background: #fff;
  cursor: pointer;
}

#roomPlatform:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(255, 68, 0, 0.15);
}
```

---

### Task 5: 更新 Popup 页面 — 平台标识

**Files:**
- Modify: `popup/popup.js`
- Modify: `popup/popup.css`

- [ ] **Step 1: 修改 popup.js — 平台标签和动态跳转**

在 `renderStreamerList` 函数中增加平台标签和动态跳转：

```javascript
function renderStreamerList(container, streamers) {
  container.innerHTML = '';

  streamers.forEach(s => {
    const card = document.createElement('div');
    card.className = 'streamer-card';
    card.addEventListener('click', () => {
      // 根据平台跳转
      const url = s.platform === 'bilibili'
        ? `https://live.bilibili.com/${s.roomId}`
        : `https://www.douyu.com/${s.roomId}`;
      chrome.tabs.create({ url });
    });

    const coverImg = document.createElement('img');
    coverImg.className = 'streamer-cover';
    coverImg.alt = s.nickname;
    coverImg.referrerPolicy = 'no-referrer';
    const fallbackSrc = chrome.runtime.getURL('icons/icon48.png');
    coverImg.addEventListener('error', () => {
      if (coverImg.src !== fallbackSrc) {
        coverImg.src = fallbackSrc;
      }
    });
    coverImg.src = s.coverUrl || fallbackSrc;

    const infoDiv = document.createElement('div');
    infoDiv.className = 'streamer-info';
    infoDiv.innerHTML = `
      <div class="streamer-name">
        ${s.platform === 'bilibili' ? '<span class="platform-tag bilibili">B站</span>' : '<span class="platform-tag douyu">斗鱼</span>'}
        ${escapeHtml(s.nickname)}
      </div>
      <div class="streamer-title">${escapeHtml(s.title || '正在直播')}</div>
      <div class="streamer-meta">
        <span class="live-dot"></span>
        ${escapeHtml(s.category)} · ${formatNumber(s.viewers)} 人
      </div>
    `;

    card.appendChild(coverImg);
    card.appendChild(infoDiv);
    container.appendChild(card);
  });
}
```

- [ ] **Step 2: 修改 popup.css — 平台标签样式**

```css
/* 平台标签（popup 版） */
.platform-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  vertical-align: middle;
  margin-right: 4px;
}

.platform-tag.douyu {
  background: #fff0eb;
  color: #FF4400;
  border: 1px solid #ffd5cc;
}

.platform-tag.bilibili {
  background: #f0f4ff;
  color: #00a1d6;
  border: 1px solid #cce5ff;
}
```

---

### Task 6: 端到端验证

- [ ] **Step 1: 在 Chrome 中加载扩展**

打开 `chrome://extensions`，开启开发者模式，点击"加载已解压的扩展"，选择 `E:/code/douyu-extensions` 目录。

- [ ] **Step 2: 验证旧数据兼容**

确认扩展加载正常无错误。检查旧斗鱼房间是否正常显示（含"斗鱼"标签）。

- [ ] **Step 3: 验证添加 Bilibili 房间**

打开设置页，选择"B站"，输入 Bilibili 直播房间号（如 `20978565`），点击添加，确认主播名正常解析。

- [ ] **Step 4: 验证轮询和通知**

等待轮询触发（或手动点击刷新），确认两个平台的状态都能正确显示。如果主播正在直播，popup 中应显示带平台标签的卡片。

- [ ] **Step 5: 验证通知和跳转**

如果触发通知，确认通知标题包含 `[斗鱼]` 或 `[B站]` 前缀，点击后跳转到正确平台 URL。

---
