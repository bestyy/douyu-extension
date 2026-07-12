# 斗鱼关注开播通知 Chrome 插件 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Chrome Manifest V3 扩展，监控斗鱼关注主播的开播状态并推送通知

**Architecture:** Service Worker 定时调用斗鱼关注列表 API → 筛选在线主播 → 写入 chrome.storage → 更新 badge 和通知。Popup 从 storage 读取并渲染开播卡片。Options 页管理 Cookie 和设置。

**Tech Stack:** Chrome Extension Manifest V3, vanilla JS (无框架), chrome.storage.local, chrome.alarms, chrome.notifications

## Global Constraints

- 必须使用 Manifest V3
- 所有数据存储在 chrome.storage.local 中，不可外传
- Cookie 字段要求: acf_uid, acf_auth, acf_biz, acf_stk, acf_ct, acf_ltkid
- API 基址: `https://www.douyu.com`
- 刷新间隔最小 60 秒
- 图标资源使用 emoji/unicode 占位（后续可替换为正式图标）
- 代码文件编码: UTF-8

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `manifest.json` | 扩展配置、权限声明 |
| `lib/storage.js` | chrome.storage.local 的 CRUD 封装 |
| `lib/douyu-api.js` | 斗鱼 API 调用（关注列表 + Cookie 鉴权） |
| `background.js` | Service Worker：定时轮询、通知推送、badge 更新 |
| `popup/popup.html` | 弹窗 HTML 结构 |
| `popup/popup.css` | 弹窗样式 |
| `popup/popup.js` | 弹窗逻辑：从 storage 读取并渲染列表 |
| `options/options.html` | 设置页 HTML |
| `options/options.css` | 设置页样式 |
| `options/options.js` | 设置页逻辑：Cookie 保存、测试连接 |
| `icons/` | 扩展图标（使用简单 PNG 或 SVG） |

---

### Task 1: 项目脚手架 + manifest.json

**Files:**
- Create: `manifest.json`
- Create: `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`（使用纯色占位图标）

- [ ] **Step 1: 创建 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "斗鱼关注开播通知",
  "description": "实时显示斗鱼关注主播的开播状态，点击跳转直播间",
  "version": "1.0.0",
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "background": {
    "service_worker": "background.js"
  },
  "options_page": "options/options.html",
  "permissions": [
    "storage",
    "alarms",
    "notifications"
  ],
  "host_permissions": [
    "https://www.douyu.com/*"
  ]
}
```

- [ ] **Step 2: 生成占位图标文件**

```bash
# 使用 Node.js 生成纯色图标 (16x16, 48x48, 128x128 的红色圆形 PNG)
mkdir -p icons
node -e "
const fs = require('fs');
const sizes = [16, 48, 128];
sizes.forEach(size => {
  // 创建一个最小有效的 PNG（纯红色方块）
  // 实际使用中请替换为真实图标
  const { createCanvas } = (() => { try { return require('canvas'); } catch(e) { return null; } })();
  if (createCanvas) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FF4400';
    ctx.beginPath();
    ctx.arc(size/2, size/2, size/2-1, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold ' + Math.floor(size*0.5) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('斗', size/2, size/2);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync('icons/icon' + size + '.png', buffer);
  } else {
    // Fallback: create minimal valid PNG files manually
    console.log('canvas module not available, create placeholder PNG files manually');
  }
});
"
```

如果 canvas 模块不可用，手动创建最简单的 PNG 文件：

```bash
# 最小有效 PNG (1x1 像素红色)
# 可以直接使用在线工具生成并放到 icons/ 目录
echo "请手动将图标文件放入 icons/ 目录" > icons/README.md
```

---

### Task 2: Storage 模块 (lib/storage.js)

**Files:**
- Create: `lib/storage.js`

**Interfaces:**
- Produces: `StorageHelper` 对象，包含 `get(key)`, `set(key, value)`, `getAll()`, `clear()`
- Produces: `DEFAULT_STORAGE` 常量，定义初始 storage 结构

- [ ] **Step 1: 编写 lib/storage.js**

```javascript
// lib/storage.js — chrome.storage.local 封装

const StorageHelper = {
  /**
   * 获取存储的值
   * @param {string} key
   * @returns {Promise<any>}
   */
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  },

  /**
   * 设置存储的值
   * @param {string} key
   * @param {any} value
   */
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },

  /**
   * 获取全部存储数据
   * @returns {Promise<object>}
   */
  async getAll() {
    return await chrome.storage.local.get(null);
  },

  /**
   * 清空存储
   */
  async clear() {
    await chrome.storage.local.clear();
  }
};

const DEFAULT_STORAGE = {
  cookie: {
    value: '',
    lastChecked: 0
  },
  streamers: [],
  lastRefresh: 0,
  notifiedRooms: [],
  settings: {
    refreshInterval: 60,
    notificationsEnabled: true
  }
};

// 通过 importScripts 加载，全局可用
```

---

### Task 3: API 模块 (lib/douyu-api.js)

**Files:**
- Create: `lib/douyu-api.js`

**Interfaces:**
- Consumes: 来自 StorageHelper 的 cookie
- Produces: `DouyuAPI` 对象，包含 `fetchFollowList(cookieString)`, `testCookie(cookieString)`

- [ ] **Step 1: 编写 lib/douyu-api.js**

```javascript
// lib/douyu-api.js — 斗鱼 API 封装

const API_BASE = 'https://www.douyu.com';

const DouyuAPI = {
  /**
   * 从 cookie 字符串解析为对象
   * @param {string} cookieString - "key1=val1; key2=val2; ..."
   * @returns {object}
   */
  _parseCookie(cookieString) {
    const result = {};
    cookieString.split(';').forEach(pair => {
      const [key, ...rest] = pair.trim().split('=');
      if (key && rest.length > 0) {
        result[key.trim()] = rest.join('=').trim();
      }
    });
    return result;
  },

  /**
   * 验证 cookie 中是否包含必要字段
   * @param {string} cookieString
   * @returns {{ valid: boolean, missing: string[] }}
   */
  validateCookie(cookieString) {
    const required = ['acf_uid', 'acf_auth', 'acf_biz', 'acf_stk', 'acf_ct', 'acf_ltkid'];
    const parsed = this._parseCookie(cookieString);
    const missing = required.filter(key => !parsed[key]);
    return {
      valid: missing.length === 0,
      missing
    };
  },

  /**
   * 获取关注列表（含直播状态）
   * @param {string} cookieString
   * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
   */
  async fetchFollowList(cookieString) {
    try {
      const response = await fetch(`${API_BASE}/wgapi/livenc/liveweb/follow/list?sort=0&cid1=0`, {
        headers: {
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      const result = await response.json();

      if (result.error !== 0) {
        // Cookie 过期或无效
        if (result.error === 1004 || result.error === 1003) {
          return { success: false, error: 'cookie_expired' };
        }
        return { success: false, error: `api_error_${result.error}` };
      }

      // 标准化数据
      const streamers = (result.data?.list || []).map(item => ({
        roomId: String(item.room_id),
        nickname: item.nickname || '',
        title: item.room_name || '',
        online: item.show_status === 1,
        coverUrl: item.room_src || '',
        avatarUrl: item.avatar || '',
        viewers: item.hn || 0,
        category: item.cname2 || item.cname1 || '',
        startTime: item.show_time ? item.show_time * 1000 : 0
      }));

      return { success: true, data: streamers };
    } catch (err) {
      return { success: false, error: 'network_error', message: err.message };
    }
  },

  /**
   * 测试 Cookie 是否有效
   * @param {string} cookieString
   * @returns {Promise<{valid: boolean, nickname?: string, error?: string}>}
   */
  async testCookie(cookieString) {
    try {
      const response = await fetch(`${API_BASE}/japi/roomuserlevel/apinc/levelInfo?rid=1`, {
        headers: {
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      const result = await response.json();

      if (result.error === 0) {
        return { valid: true };
      }
      return { valid: false, error: 'cookie_invalid' };
    } catch (err) {
      return { valid: false, error: 'network_error' };
    }
  }
};

// 通过 importScripts 加载，全局可用
```

---

### Task 4: Service Worker (background.js)

**Files:**
- Create: `background.js`

**Interfaces:**
- Consumes: `StorageHelper`, `DouyuAPI`
- 后台运行，无 UI

- [ ] **Step 1: 编写 background.js**

```javascript
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

  // 清除过期标记（如果之前有的话）
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
```

---

### Task 5: Popup 弹窗 UI

**Files:**
- Create: `popup/popup.html`
- Create: `popup/popup.css`
- Create: `popup/popup.js`

- [ ] **Step 1: 编写 popup.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="app">
    <header>
      <h1>🔴 斗鱼关注</h1>
      <span id="onlineCount" class="badge">0</span>
    </header>

    <div id="loading" class="state-msg">加载中...</div>
    <div id="noCookie" class="state-msg hidden">
      <p>⚠️ 未配置 Cookie</p>
      <p class="sub">请前往 <a href="#" id="openOptions">设置页</a> 配置 Cookie</p>
    </div>
    <div id="cookieExpired" class="state-msg hidden">
      <p>⚠️ Cookie 已过期</p>
      <p class="sub">请前往 <a href="#" id="openOptionsExpired">设置页</a> 更新 Cookie</p>
    </div>
    <div id="emptyState" class="state-msg hidden">
      <p>☕ 当前没有主播开播</p>
    </div>
    <div id="errorState" class="state-msg hidden">
      <p>❌ 网络异常</p>
      <p class="sub">请稍后重试</p>
    </div>

    <div id="streamerList" class="hidden"></div>

    <footer>
      <button id="refreshBtn">🔄 刷新</button>
      <button id="settingsBtn">⚙️ 设置</button>
    </footer>
  </div>

  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: 编写 popup.css**

```css
/* popup.css */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  width: 360px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  color: #333;
  background: #fff;
}

#app {
  display: flex;
  flex-direction: column;
  min-height: 200px;
  max-height: 500px;
}

/* Header */
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #FF4400;
  color: #fff;
}

header h1 {
  font-size: 16px;
  font-weight: 600;
}

.badge {
  background: rgba(255, 255, 255, 0.25);
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
}

/* State messages */
.state-msg {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: #999;
}

.state-msg .sub {
  font-size: 12px;
  margin-top: 8px;
  color: #bbb;
}

.state-msg a {
  color: #FF4400;
  cursor: pointer;
  text-decoration: underline;
}

.hidden {
  display: none !important;
}

/* Streamer list */
#streamerList {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.streamer-card {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.15s;
  border-bottom: 1px solid #f0f0f0;
}

.streamer-card:hover {
  background: #fafafa;
}

.streamer-card:last-child {
  border-bottom: none;
}

.streamer-cover {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
  background: #f0f0f0;
}

.streamer-info {
  flex: 1;
  margin-left: 12px;
  min-width: 0;
}

.streamer-name {
  font-weight: 600;
  font-size: 14px;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.streamer-title {
  font-size: 12px;
  color: #666;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.streamer-meta {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
}

.live-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #FF4400;
  margin-right: 4px;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* Footer */
footer {
  display: flex;
  border-top: 1px solid #eee;
  padding: 0;
}

footer button {
  flex: 1;
  padding: 10px;
  border: none;
  background: #fff;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
  color: #666;
}

footer button:hover {
  background: #f5f5f5;
}

footer button:active {
  background: #eee;
}

footer button + button {
  border-left: 1px solid #eee;
}

/* Loading spinner */
#loading::after {
  content: '';
  display: inline-block;
  width: 20px;
  height: 20px;
  border: 2px solid #ddd;
  border-top-color: #FF4400;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  margin-top: 8px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 3: 编写 popup.js**

```javascript
// popup.js — 弹窗逻辑

document.addEventListener('DOMContentLoaded', async () => {
  const streamerList = document.getElementById('streamerList');
  const onlineCount = document.getElementById('onlineCount');
  const loading = document.getElementById('loading');
  const noCookie = document.getElementById('noCookie');
  const cookieExpired = document.getElementById('cookieExpired');
  const emptyState = document.getElementById('emptyState');
  const errorState = document.getElementById('errorState');

  // 打开设置页
  document.getElementById('openOptions').addEventListener('click', openOptions);
  document.getElementById('openOptionsExpired').addEventListener('click', openOptions);
  document.getElementById('settingsBtn').addEventListener('click', openOptions);

  // 刷新按钮
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    // 通知 background 立即刷新
    chrome.runtime.sendMessage({ type: 'MANUAL_REFRESH' }, () => {
      // 刷新后重新加载
      loadData();
    });
  });

  async function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  await loadData();
});

async function loadData() {
  const streamerList = document.getElementById('streamerList');
  const onlineCount = document.getElementById('onlineCount');
  const loading = document.getElementById('loading');
  const noCookie = document.getElementById('noCookie');
  const cookieExpired = document.getElementById('cookieExpired');
  const emptyState = document.getElementById('emptyState');
  const errorState = document.getElementById('errorState');

  // 隐藏所有状态
  [noCookie, cookieExpired, emptyState, errorState, streamerList].forEach(el => el.classList.add('hidden'));
  loading.classList.remove('hidden');

  try {
    const data = await chrome.storage.local.get(null);
    loading.classList.add('hidden');

    // Cookie 检查
    const cookie = data.cookie;
    if (!cookie || !cookie.value) {
      noCookie.classList.remove('hidden');
      return;
    }

    // 检查是否标记为过期
    if (data._cookieError === 'expired') {
      cookieExpired.classList.remove('hidden');
      return;
    }

    const streamers = data.streamers || [];
    const onlineStreamers = streamers.filter(s => s.online);

    if (onlineStreamers.length === 0) {
      emptyState.classList.remove('hidden');
      onlineCount.textContent = '0';
      return;
    }

    // 渲染列表
    onlineCount.textContent = String(onlineStreamers.length);
    renderStreamerList(streamerList, onlineStreamers);
    streamerList.classList.remove('hidden');

  } catch (err) {
    loading.classList.add('hidden');
    errorState.classList.remove('hidden');
  }
}

function renderStreamerList(container, streamers) {
  container.innerHTML = '';

  streamers.forEach(s => {
    const card = document.createElement('div');
    card.className = 'streamer-card';
    card.addEventListener('click', () => {
      chrome.tabs.create({ url: `https://www.douyu.com/${s.roomId}` });
    });

    const coverImg = document.createElement('img');
    coverImg.className = 'streamer-cover';
    coverImg.src = s.coverUrl || 'icons/icon48.png';
    coverImg.alt = s.nickname;
    coverImg.addEventListener('error', () => { coverImg.src = 'icons/icon48.png'; });

    const infoDiv = document.createElement('div');
    infoDiv.className = 'streamer-info';
    infoDiv.innerHTML = `
        <div class="streamer-name">${escapeHtml(s.nickname)}</div>
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatNumber(num) {
  if (num >= 10000) {
    return (num / 10000).toFixed(1) + '万';
  }
  return String(num);
}
```

---

### Task 6: Options 设置页

**Files:**
- Create: `options/options.html`
- Create: `options/options.css`
- Create: `options/options.js`

- [ ] **Step 1: 编写 options/options.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="options.css">
  <title>斗鱼关注开播通知 - 设置</title>
</head>
<body>
  <div class="container">
    <h1>⚙️ 斗鱼直播通知 设置</h1>

    <section class="card">
      <h2>🔑 Cookie 设置</h2>
      <p class="hint">从 douyu.com 登录后的 Cookie 中复制必要字段</p>
      <textarea id="cookieInput" rows="4" placeholder="acf_uid=xxx; acf_auth=xxx; acf_biz=xxx; acf_stk=xxx; acf_ct=xxx; acf_ltkid=xxx"></textarea>
      <div class="btn-row">
        <button id="saveCookieBtn" class="btn primary">💾 保存 Cookie</button>
        <button id="testCookieBtn" class="btn">🔗 测试连接</button>
      </div>
      <div id="cookieStatus" class="status hidden"></div>
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

    <section class="card help">
      <h2>❓ 如何获取 Cookie？</h2>
      <ol>
        <li>在 Chrome 中登录 <a href="https://www.douyu.com" target="_blank">douyu.com</a></li>
        <li>按 F12 打开开发者工具 → Application → Cookies → <code>www.douyu.com</code></li>
        <li>确认包含以下字段：
          <code>acf_uid</code>、<code>acf_auth</code>、<code>acf_biz</code>、<code>acf_stk</code>、<code>acf_ct</code>、<code>acf_ltkid</code>
        </li>
        <li>复制所有 Cookie 字符串（或者直接从 Application 面板复制全部）</li>
        <li>粘贴到上方的输入框并保存</li>
      </ol>
    </section>
  </div>

  <script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: 编写 options/options.css**

```css
/* options/options.css */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  color: #333;
  background: #f5f5f5;
  padding: 20px;
}

.container {
  max-width: 600px;
  margin: 0 auto;
}

h1 {
  font-size: 22px;
  color: #FF4400;
  margin-bottom: 24px;
}

.card {
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}

.card h2 {
  font-size: 16px;
  color: #333;
  margin-bottom: 12px;
}

.hint {
  font-size: 12px;
  color: #999;
  margin-bottom: 8px;
}

textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 13px;
  font-family: 'Courier New', monospace;
  resize: vertical;
  outline: none;
  transition: border-color 0.2s;
}

textarea:focus {
  border-color: #FF4400;
}

.btn-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.btn {
  padding: 8px 20px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: #fff;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s;
  color: #666;
}

.btn:hover {
  background: #f5f5f5;
}

.btn.primary {
  background: #FF4400;
  color: #fff;
  border-color: #FF4400;
}

.btn.primary:hover {
  background: #e63e00;
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.setting-row label {
  flex: 1;
  font-size: 14px;
}

.setting-row input[type="number"] {
  width: 100px;
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  text-align: center;
}

.toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.toggle-row input[type="checkbox"] {
  width: 18px;
  height: 18px;
  accent-color: #FF4400;
}

.status {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
}

.status.success {
  background: #e8f5e9;
  color: #2e7d32;
}

.status.error {
  background: #fbe9e7;
  color: #c62828;
}

.status.info {
  background: #e3f2fd;
  color: #1565c0;
}

.help ol {
  margin-left: 18px;
  line-height: 1.8;
}

.help li {
  margin-bottom: 6px;
}

.help code {
  background: #f5f5f5;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
  color: #FF4400;
}

.help a {
  color: #FF4400;
  text-decoration: none;
}

.help a:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: 编写 options/options.js**

```javascript
// options/options.js — 设置页逻辑

document.addEventListener('DOMContentLoaded', async () => {
  // 加载已有的设置
  const data = await chrome.storage.local.get(null);

  const cookieInput = document.getElementById('cookieInput');
  const refreshInterval = document.getElementById('refreshInterval');
  const notificationsEnabled = document.getElementById('notificationsEnabled');

  if (data.cookie?.value) {
    cookieInput.value = data.cookie.value;
  }
  if (data.settings?.refreshInterval) {
    refreshInterval.value = data.settings.refreshInterval;
  }
  if (data.settings?.notificationsEnabled !== undefined) {
    notificationsEnabled.checked = data.settings.notificationsEnabled;
  }

  // 保存 Cookie
  document.getElementById('saveCookieBtn').addEventListener('click', async () => {
    const value = cookieInput.value.trim();
    if (!value) {
      showStatus('cookieStatus', '请输入 Cookie', 'error');
      return;
    }

    await chrome.storage.local.set({
      cookie: { value, lastChecked: Date.now() }
    });

    showStatus('cookieStatus', '✅ Cookie 已保存', 'success');
  });

  // 测试连接
  document.getElementById('testCookieBtn').addEventListener('click', async () => {
    const value = cookieInput.value.trim();
    if (!value) {
      showStatus('cookieStatus', '请先输入 Cookie', 'error');
      return;
    }

    showStatus('cookieStatus', '⏳ 正在测试连接...', 'info');

    // 通过 background 测试
    chrome.runtime.sendMessage({ type: 'TEST_COOKIE', cookie: value }, (response) => {
      if (response?.valid) {
        showStatus('cookieStatus', '✅ Cookie 有效，连接成功！', 'success');
      } else {
        showStatus('cookieStatus', `❌ 连接失败：${response?.error || 'Cookie 无效或已过期'}`, 'error');
      }
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

    // 通知 background 重建定时器
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });

    showStatus('settingsStatus', '✅ 设置已保存', 'success');
  });

  // 通知开关实时保存
  notificationsEnabled.addEventListener('change', async () => {
    const data = await chrome.storage.local.get('settings');
    const settings = data.settings || {};
    settings.notificationsEnabled = notificationsEnabled.checked;
    await chrome.storage.local.set({ settings });
  });
});

function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}
```

---

### Task 7: 完善 background.js 消息处理

**Files:**
- Modify: `background.js`（在末尾添加消息监听）

- [ ] **Step 1: 在 background.js 末尾添加消息处理**

```javascript
// background.js — 追加到文件末尾

// === 消息处理 ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'TEST_COOKIE':
      // 测试 Cookie 有效性
      DouyuAPI.testCookie(message.cookie).then(sendResponse);
      return true; // 异步响应

    case 'MANUAL_REFRESH':
      // 手动触发刷新
      refreshFollowList().then(() => sendResponse({ ok: true }));
      return true;

    case 'SETTINGS_UPDATED':
      // 设置更新后重建定时器
      createAlarm();
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false });
  }
});
```

---

### Task 8: 完整性验证

**Files:** 无需修改

- [ ] **Step 1: 验证文件完整性**

```bash
# 确认所有文件存在
ls -la manifest.json background.js lib/storage.js lib/douyu-api.js
ls -la popup/popup.html popup/popup.js popup/popup.css
ls -la options/options.html options/options.js options/options.css
ls -la icons/icon16.png icons/icon48.png icons/icon128.png
```

- [ ] **Step 2: 在 Chrome 中加载扩展测试**

```
1. 打开 Chrome → chrome://extensions
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 douyu-extensions 目录
5. 确认扩展出现在列表中且无错误
```

- [ ] **Step 3: 功能测试**

```
1. Options 页: 填写 Cookie → 测试连接 → 保存
2. Popup: 点击扩展图标 → 确认显示关注列表
3. 通知: 有主播开播 → 确认收到系统通知
4. 点击通知/列表项 → 确认跳转到直播间
5. Badge: 确认图标上显示在线人数
```
