# 房间列表拖拽排序设计文档

## 概述

为选项页（options/options.html）的房间管理列表增加拖拽排序功能，允许用户通过拖拽手柄（≡ 图标）调整房间显示顺序，松手即自动保存。

## 交互设计

- 每个 `.room-item` 的左侧添加拖拽手柄元素（≡ 图标）
- 只有按住手柄才能拖动（防止误触删除按钮或选中文本）
- 拖拽中原位置保持半透明占位样式，被拖过的项之间显示插入线指示
- 拖放后立即保存新顺序

### 鼠标光标状态

| 区域 | 光标 | 说明 |
|---|---|---|
| 手柄区域 | `grab` / `grabbing` | 可拖拽 |
| 房间项其余区域 | 默认 | 不可触发拖拽 |

### 拖拽视觉反馈

- `.room-item.dragging` — 拖拽中源项半透明
- `.room-item.drag-over` — 被越过项高亮上/下边框显示插入位置

## 存储与数据流

### 存储结构（不变）

```js
rooms: [{ roomId, nickname, platform }]  // 数组顺序即显示顺序
streamers: [{ roomId, nickname, title, online, ... }]  // 跟随 rooms 顺序
```

### 数据流

```
用户拖拽放下
  → options.js 从 DOM 提取新顺序（遍历 .room-item 的 dataset）
  → 直接写入 chrome.storage.local（rooms + streamers 同步重排）
  → 重新渲染房间列表
```

> 不经过 background.js，因为排序变更无需 API 调用、无需更新 badge、无需触发通知。操作在 options.js 内直接完成，与「保存设置」的处理方式一致。

**Popup 同步生效**：因 streamers 同步重排写入 storage，popup 页面（`popup.js` 的 `loadData()`）下次打开或手动刷新时直接读取新顺序，自动反映。不需要额外改动 popup。

## 修改文件清单

### 1. `options/options.html`

- 每个 room-item 添加一个 `<span class="drag-handle">⠿</span>` 元素

### 2. `options/options.css`

新增样式：
- `.drag-handle` — 手柄样式（宽 24px、居中对齐、灰色、cursor: grab）
- `.room-item.dragging` — 拖拽中源项透明度 0.4
- `.room-item.drag-over` — 被越过项的上/下边框高亮
- `.drag-handle:active` — 手柄 grabbed 光标

### 3. `options/options.js`

- 在 `renderRoomList()` 的 `room-item` 模板中添加拖拽手柄
- 新增 `initDragAndDrop()` 函数：
  - **拖拽启动**：`.drag-handle` 的 `mousedown` → 设置父 `.room-item` 的 `draggable="true"`
  - `dragstart`：记录被拖元素 (`dragSrc`)，添加 `.dragging` 类
  - `dragover`：`e.preventDefault()` 启用放置，判断插入位置，添加 `.drag-over` 类
  - `dragend`：移除所有拖拽样式类，重置 `.room-item` 的 `draggable="false"`
  - `drop`：读取新顺序，直接写入 `chrome.storage.local`，重新渲染
- 每次 `renderRoomList()` 完成后调用 `initDragAndDrop()` 重新绑定事件

### 4. `background.js`

无改动。排序操作全部在 options.js 中直接完成，无需新增 background 消息处理。

## 不需要修改的文件

- `manifest.json` — 无需新增权限或资源
- `lib/storage.js` — 存储 API 足够
- `popup/` — 弹窗会通过下次刷新自动反映新顺序
- `lib/douyu-api.js` / `lib/bilibili-api.js` — 无关
