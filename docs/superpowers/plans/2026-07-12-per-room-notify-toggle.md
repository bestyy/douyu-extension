# 每房间通知开关 — 实现计划

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页的房间列表中每行加一个勾选框，让用户控制每个房间开播时是否弹出通知。

**Architecture:** `rooms[]` 每个对象新增 `notify?: boolean` 字段，默认 `false`。options 页面渲染 checkbox 并写 storage，background.js 轮询时根据 `notify` 标记决定是否发通知。

**Tech Stack:** Chrome Extension Manifest V3, vanilla JS, chrome.storage.local

## Global Constraints

- 新增房间时 `notify` 不传值，代码中 `undefined` 等同于 `false`
- 旧数据无 `notify` 字段，自动视为 `false`
- 勾选变化立即写 storage，不依赖"保存设置"按钮
- Popup 不做任何改动

---

### Task 1: 后端逻辑 — Storage + Background

**Files:**
- Modify: `background.js`（2 处改动）
- Modify: `lib/storage.js`（注释说明）

**Interfaces:**
- Consumes: rooms[].notify (boolean | undefined)
- Produces: streamers[].notify (boolean) — 合并数据时从 rooms 传递到 streamers

- [ ] **Step 1: lib/storage.js — 给 DEFAULT_STORAGE 的 rooms 示例加注释**

```js
const DEFAULT_STORAGE = {
  rooms: [],   // { roomId, nickname, platform, notify?: boolean }
  streamers: [],
  lastRefresh: 0,
  notifiedRooms: [],
  settings: {
    refreshInterval: 60,
    notificationsEnabled: true
  }
};
```

- [ ] **Step 2: background.js — refreshRooms 中传递 notify 标记**

找到 `refreshRooms()` 函数中逐个房间合并的 `for` 循环（当前大约在第 67 行附近），修改为在 push 到 `mergedData` 前设置 `notify` 字段：

```js
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
  mergedData.push(item);
}
```

- [ ] **Step 3: background.js — checkNewLiveStreams 跳过不通知的房间**

在 `checkNewLiveStreams()` 函数的 `for` 循环开头（遍历 `currentStreamers`），在 `if (!streamer.online) continue;` 之后增加：

```js
// 跳过用户设置了不通知的房间
if (streamer.notify !== true) continue;
```

最终循环代码变为：

```js
for (const streamer of currentStreamers) {
  if (!streamer.online) continue;
  if (streamer.notify !== true) continue;  // 新增

  const compositeKey = `${streamer.platform}_${streamer.roomId}`;
  const isNewlyLive = !prevOnlineSet.has(compositeKey);
  const alreadyNotified = notifiedMap.has(compositeKey);

  if (isNewlyLive && !alreadyNotified) {
    // ... 发送通知逻辑不变
  }
}
```

- [ ] **Step 4: 验证后端逻辑**

手动验证步骤：
1. 在 Chrome 扩展管理页面点击加载已解压的扩展，重新加载
2. 打开设置页，添加一个房间
3. 观察 background.js 的 console 确认 `notify` 标记正确传递
4. 手动开放直播间后检查是否根据 `notify` 决定通知

- [ ] **Step 5: 提交**

```bash
git add lib/storage.js background.js
git commit -m "feat: add per-room notify flag to storage and background logic"
```

---

### Task 2: 前端 UI — Options 页面

**Files:**
- Modify: `options/options.html`（1 处改动 — room-item 模板）
- Modify: `options/options.js`（2 处改动 — 渲染 checkbox + change 事件）
- Modify: `options/options.css`（新增 checkbox 样式）

**Interfaces:**
- Consumes: `rooms[].notify` 渲染勾选状态
- Produces: `chrome.storage.local.set({ rooms })` 保存勾选状态

- [ ] **Step 1: options.html — 房间列表模板加 checkbox**

在 `renderRoomList()` 的模板字符串中，在 drag-handle 之前插入 checkbox：

```html
roomList.innerHTML = rooms.map(r => {
  const onlineStatus = onlineMap[`${r.platform}_${r.roomId}`];
  let statusIcon;
  if (onlineStatus === true) {
    statusIcon = '🟢';
  } else if (onlineStatus === false) {
    statusIcon = '🔴';
  } else {
    statusIcon = '🟣';
  }
  const platformLabel = r.platform === 'bilibili'
    ? '<span class="platform-tag bilibili">B站</span>'
    : '<span class="platform-tag douyu">斗鱼</span>';
  const checkedAttr = r.notify === true ? 'checked' : '';
  return `
    <div class="room-item" data-room-id="${r.roomId}" data-platform="${r.platform}">
      <input type="checkbox" class="room-notify-cb" ${checkedAttr}>
      <span class="drag-handle" draggable="false">⠿</span>
      <span class="room-status">${statusIcon}</span>
      ${platformLabel}
      <span class="room-id">${r.roomId}</span>
      <span class="room-nickname">${escapeHtml(r.nickname || '未知')}</span>
      <button class="btn-remove" data-room-id="${r.roomId}">✕</button>
    </div>
  `;
}).join('');
```

- [ ] **Step 2: options.js — checkbox change 事件监听**

在 `renderRoomList()` 函数末尾，删除按钮事件绑定之后，增加 checkbox 变化事件：

```js
// checkbox 变化事件 — 更新 notify 状态
document.querySelectorAll('.room-notify-cb').forEach(cb => {
  cb.addEventListener('change', async (e) => {
    e.stopPropagation();
    const roomItem = cb.closest('.room-item');
    const roomId = roomItem.dataset.roomId;
    const platform = roomItem.dataset.platform || 'douyu';

    const { rooms = [] } = await chrome.storage.local.get('rooms');
    const updatedRooms = rooms.map(r => {
      if (r.roomId === roomId && r.platform === platform) {
        return { ...r, notify: cb.checked };
      }
      return r;
    });
    await chrome.storage.local.set({ rooms: updatedRooms });
  });
});
```

- [ ] **Step 3: options.css — checkbox 样式**

在文件末尾新增：

```css
/* 房间通知勾选框 */
.room-notify-cb {
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border: 2px solid #ccc;
  border-radius: 3px;
  outline: none;
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: border-color 0.15s, background-color 0.15s;
  margin: 0;
}

.room-notify-cb:hover {
  border-color: #999;
}

.room-notify-cb:checked {
  background: var(--accent);
  border-color: var(--accent);
}

.room-notify-cb:checked::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 1px;
  width: 5px;
  height: 9px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.room-notify-cb:focus-visible {
  box-shadow: 0 0 0 3px rgba(255, 68, 0, 0.25);
}
```

- [ ] **Step 4: options.js — 拖拽排序保留 notify 字段**

检查现有的拖拽排序 `drop` 事件中的 `updatedRooms` 构建逻辑。当前代码已通过 `roomMap` 保留所有字段：

```js
const updatedRooms = newRooms.map(r => ({
  ...roomMap[`${r.platform}_${r.roomId}`],
  roomId: r.roomId,
  platform: r.platform
}));
```

由于 `roomMap` 是从旧 `rooms` 数组构建的，其中已包含 `notify`，所以 `...roomMap[...]` 会自动保留 `notify`。**此步无需额外代码改动**，确认即可。

- [ ] **Step 5: 验证前端 UI**

手动验证步骤：
1. 重新加载扩展
2. 打开设置页
3. 确认每个房间前面有勾选框
4. 勾选/取消勾选后，刷新页面确认状态保持
5. 添加新房间，确认新房间默认未勾选
6. 删除房间后重新添加，确认重置为未勾选
7. 拖拽排序后确认勾选状态保留

- [ ] **Step 6: 提交**

```bash
git add options/options.html options/options.js options/options.css
git commit -m "feat: add per-room notification checkbox in options page"
```
