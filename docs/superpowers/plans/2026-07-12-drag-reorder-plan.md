# 房间列表拖拽排序 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 options 页的房间管理列表增加拖拽手柄排序功能，松手自动保存，popup 同步反映新顺序

**架构:** HTML5 原生 Drag & Drop API 实现。每个房间项左侧添加拖拽手柄（≡），只有按住手柄可拖动。拖放后直接写入 `chrome.storage.local`（rooms + streamers 同步重排），不经过 background.js。

**技术栈:** HTML5 Drag & Drop API, Chrome Extension (Manifest V3), chrome.storage.local

## 全局约束

- 不引入第三方依赖
- 拖拽只能通过手柄触发，不能通过房间项其他区域触发
- 松手即自动保存，无需额外"保存"按钮
- 新顺序立即反映到 popup 页面
- 修改范围限制在 `options/` 目录下，`background.js` 不动

---

### Task 1: CSS 拖拽样式

**Files:**
- Modify: `options/options.css`（在 `.room-item` 相关区域追加）

**Interfaces:**
- Consumes: 无
- Produces: `.drag-handle`, `.room-item.dragging`, `.room-item.drag-over` 样式类

- [ ] **Step 1: 追加拖拽手柄和拖拽状态样式**

在 `options/options.css` 末尾 `.btn-remove` 样式之后，追加以下代码：

```css
/* === 拖拽排序 === */
.drag-handle {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  color: #bbb;
  font-size: 16px;
  user-select: none;
  flex-shrink: 0;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}

.drag-handle:hover {
  color: #666;
  background: #eee;
}

.drag-handle:active {
  cursor: grabbing;
}

.room-item.dragging {
  opacity: 0.4;
  border-style: dashed;
}

.room-item.drag-over-top {
  border-top: 2px solid var(--accent);
}

.room-item.drag-over-bottom {
  border-bottom: 2px solid var(--accent);
}
```

- [ ] **Step 2: 提交**

```bash
git add options/options.css
git commit -m "style: add drag handle and drag state CSS"
```

---

### Task 2: 拖拽手柄 HTML + 拖拽逻辑

**Files:**
- Modify: `options/options.js`

**Interfaces:**
- Consumes: 
  - CSS class `.drag-handle`, `.room-item.dragging`, `.room-item.drag-over-top`, `.room-item.drag-over-bottom`（来自 Task 1）
  - `chrome.storage.local` get/set API
- Produces:
  - `renderRoomList()` 中每个 room-item 内新增拖拽手柄
  - `initDragAndDrop()` — 绑定所有拖拽事件

- [ ] **Step 1: 修改 renderRoomList 添加拖拽手柄**

在 `options/options.js` 的 `renderRoomList()` 函数中，修改 room-item 模板字符串，在平台标签之前添加拖拽手柄：

**修改前：**
```js
return `
  <div class="room-item" data-room-id="${r.roomId}" data-platform="${r.platform}">
    <span class="room-status">${statusIcon}</span>
    ${platformLabel}
    <span class="room-id">${r.roomId}</span>
    <span class="room-nickname">${escapeHtml(r.nickname || '未知')}</span>
    <button class="btn-remove" data-room-id="${r.roomId}">✕</button>
  </div>
`;
```

**修改后：**
```js
return `
  <div class="room-item" data-room-id="${r.roomId}" data-platform="${r.platform}">
    <span class="drag-handle" draggable="false">⠿</span>
    <span class="room-status">${statusIcon}</span>
    ${platformLabel}
    <span class="room-id">${r.roomId}</span>
    <span class="room-nickname">${escapeHtml(r.nickname || '未知')}</span>
    <button class="btn-remove" data-room-id="${r.roomId}">✕</button>
  </div>
`;
```

- [ ] **Step 2: 添加 initDragAndDrop 函数**

在 `options/options.js` 中 `renderRoomList` 函数之后，添加 `initDragAndDrop` 函数（在 `DOMContentLoaded` 回调内部，或者作为一个独立函数在文件末尾）：

```js
  // === 拖拽排序 ===
  function initDragAndDrop() {
    const roomList = document.getElementById('roomList');
    let dragSrc = null;

    // 只有从手柄开始 mouse down 才启用 draggable
    // 每次重新设置前先清除所有历史状态
    roomList.querySelectorAll('.drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation(); // 防止冒泡到 room-item
        // 重置所有项，防止残留 draggable 状态
        roomList.querySelectorAll('.room-item').forEach(el => {
          el.setAttribute('draggable', 'false');
        });
        const item = handle.closest('.room-item');
        item.setAttribute('draggable', 'true');
      });
    });

    roomList.querySelectorAll('.room-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        // 只有 draggable=true 时才会触发 dragstart，
        // 而 draggable=true 仅通过手柄 mousedown 设置，
        // 所以此处不需要额外验证
        dragSrc = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.roomId);
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        if (item === dragSrc) return;

        // 判断插入位置：鼠标位于当前项上半部分还是下半部分
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const isAfter = e.clientY > midY;

        // 清除所有项的 drag-over 类
        roomList.querySelectorAll('.room-item').forEach(el => {
          el.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        item.classList.add(isAfter ? 'drag-over-bottom' : 'drag-over-top');
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      item.addEventListener('dragend', () => {
        roomList.querySelectorAll('.room-item').forEach(el => {
          el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
          el.setAttribute('draggable', 'false');
        });
        dragSrc = null;
      });

      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (item === dragSrc) return;

        // 计算新顺序
        const items = Array.from(roomList.querySelectorAll('.room-item'));
        const dragIndex = items.indexOf(dragSrc);
        const dropIndex = items.indexOf(item);

        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const insertAfter = e.clientY > midY;

        // 构建新的排序
        let newOrder;
        if (dragIndex < dropIndex) {
          // 向下拖：移除 dragSrc，插入到 dropIndex（或之后）
          newOrder = items.filter(el => el !== dragSrc);
          const insertAt = insertAfter ? dropIndex : dropIndex;
          newOrder.splice(insertAt, 0, dragSrc);
        } else {
          // 向上拖
          newOrder = items.filter(el => el !== dragSrc);
          const insertAt = insertAfter ? dropIndex + 1 : dropIndex;
          newOrder.splice(insertAt, 0, dragSrc);
        }

        // 从 DOM 顺序提取新 rooms 数组
        const newRooms = newOrder.map(el => ({
          roomId: el.dataset.roomId,
          platform: el.dataset.platform
        }));

        // 直接写入 storage
        const { rooms = [], streamers = [] } = await chrome.storage.local.get(['rooms', 'streamers']);

        // 按新 rooms 顺序重建 rooms 对象（保留 nickname）
        const roomMap = {};
        rooms.forEach(r => {
          roomMap[`${r.platform}_${r.roomId}`] = r;
        });
        const updatedRooms = newRooms.map(r => ({
          ...roomMap[`${r.platform}_${r.roomId}`],
          roomId: r.roomId,
          platform: r.platform
        }));

        // 同步重排 streamers
        const streamerMap = {};
        streamers.forEach(s => {
          streamerMap[`${s.platform}_${s.roomId}`] = s;
        });
        const updatedStreamers = [];
        for (const r of newRooms) {
          const key = `${r.platform}_${r.roomId}`;
          if (streamerMap[key]) {
            updatedStreamers.push(streamerMap[key]);
          }
        }

        await chrome.storage.local.set({
          rooms: updatedRooms,
          streamers: updatedStreamers
        });

        // 清除样式并重新渲染
        roomList.querySelectorAll('.room-item').forEach(el => {
          el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
          el.setAttribute('draggable', 'false');
        });
        dragSrc = null;

        // 重新渲染列表（保持新视觉顺序）
        await renderRoomList();
      });
    });
  }
```

- [ ] **Step 3: 在 renderRoomList 末尾调用 initDragAndDrop**

在 `renderRoomList()` 函数内部，在设置删除按钮事件之后（即 `document.querySelectorAll('.btn-remove').forEach(...)` 块之后），调用 `initDragAndDrop()`：

```js
    // 删除按钮事件
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

    // 初始化拖拽排序
    initDragAndDrop();
```

- [ ] **Step 4: 提交**

```bash
git add options/options.js
git commit -m "feat: add drag-and-drop reorder for room list"
```

---

### 手动验证步骤

1. 打开 `chrome://extensions` → 加载已解压的扩展（或重载）
2. 右键 → 选项页进入设置
3. 添加 3 个以上房间
4. 鼠标悬停在拖拽手柄（⠿）上 → 指针变为 grab 图标
5. 按住手柄上下拖动一个房间 → 被拖动项半透明，被越过项显示橙色插入线
6. 松手 → 房间顺序更新，自动保存
7. 点击"刷新全部状态"或重新打开设置页 → 顺序保持
8. 打开 popup 弹窗 → 在线主播的顺序与设置页一致
9. 点击删除按钮 → 不应触发拖拽
10. 点击房间项空白区域 → 不应触发拖拽
