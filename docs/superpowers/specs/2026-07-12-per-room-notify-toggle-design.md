# 每房间通知开关 — 设计规格

## 概述

在设置页面的房间列表中，为每个房间添加一个勾选框，控制该房间开播时是否发送桌面通知。默认不通知，用户手动勾选需要通知的房间。

## 存储变更

### rooms[] 对象新增字段

```js
{
  roomId: string,
  nickname: string,
  platform: 'douyu' | 'bilibili',
  notify?: boolean   // 新增：true=开播时通知，false/undefined=不通知
}
```

- 默认值为 `false`（不通知）
- 新增房间时不带 `notify` 字段（即 `undefined`，代码统一视为 `false`）
- 无需数据迁移脚本——旧数据无 `notify` 字段即视作不通知

## 变更文件

### 1. lib/storage.js
- `DEFAULT_STORAGE` 无需改动
- 新增 `notify` 字段的注释说明

### 2. options/options.html
房间列表模板中，每行 `.room-item` 的开头增加一个 checkbox：

```html
<input type="checkbox" class="room-notify-cb" ${r.notify ? 'checked' : ''}>
```

放在拖拽手柄（`.drag-handle`）前面。

### 3. options/options.css
新增 `.room-notify-cb` 勾选框样式：
- 尺寸 16px，圆角 3px
- 勾选态使用主题色 `--accent` (#FF4400)
- hover 时变色
- 与其他元素垂直居中

### 4. options/options.js
- `renderRoomList()`：渲染时根据 `r.notify` 设置 checkbox 状态
- `.room-notify-cb` 的 `change` 事件监听器：
  - 读取当前 items 顺序，更新对应 room 的 `notify` 字段
  - 直接将完整 `rooms` 数组写入 `chrome.storage.local`
- 删除按钮逻辑无需改动
- 拖拽排序逻辑也需保存 `notify` 字段（当前拖拽排序已通过 `updatedRooms` 重建，只需确保 `notify` 被保留）

### 5. background.js
- `refreshRooms()` 中，合并数据时从 `rooms` 读取 `notify` 标记传递到流数据
- `checkNewLiveStreams()` 中增加过滤条件：跳过 `streamer.notify !== true` 的房间

#### notify 标记传递方式

方案：在 `mergedData` 中每个 streamer 对象添加 `notify` 字段。

```js
// refreshRooms() 中，逐个房间合并后
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
  // 传递 notify 标记
  item.notify = room.notify === true;
  mergedData.push(item);
}
```

然后在 `checkNewLiveStreams()` 开头或主循环中过滤：

```js
// 跳过不通知的房间
if (streamer.notify !== true) continue;
```

## 数据流

```
用户勾选/取消勾选 checkbox
    ↓ change 事件
options.js → chrome.storage.local.set({ rooms })
    ↓ (下一次轮询)
background.js refreshRooms()
    ├─ 从 rooms 读取 notify 标记
    ├─ 合并到 streamers 数据
    └─ checkNewLiveStreams() 跳过 notify=false
```

## 不需要改动的文件

- `popup/popup.html` — 弹窗只显示状态，不做设置
- `popup/popup.js` — 同上
- `manifest.json` — 无需新增权限
- 各 API 文件 — 纯数据获取，无关

## 边界情况

| 场景 | 行为 |
|------|------|
| 新添加房间 | `notify` 默认为 `false`（不通知） |
| 旧数据迁移 | 无 `notify` 字段，视为 `false` |
| 删除房间 | 房间消失，无需清理 |
| 勾选状态修改后立即触发轮询 | 保存后下一轮 alarm 生效；手动刷新也生效 |
| 全部取消勾选 | 所有房间不通知，全局通知开关仍然独立控制 |
| 快速连续勾选/取消 | 每次 change 写一次 storage，最后一次生效 |
