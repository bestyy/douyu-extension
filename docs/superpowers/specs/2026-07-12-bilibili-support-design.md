# Bilibili 直播间监控支持 — 设计文档

## 概述

在现有斗鱼关注开播通知扩展中，增加 Bilibili 直播平台的房间监控功能，支持同时监控两个平台的直播间开播状态、桌面通知和快捷跳转。

## 存储模型变更

### `rooms` 数组（房间列表）

```js
// 旧格式
{ roomId: "12345", nickname: "主播名" }

// 新格式
{ roomId: "12345", nickname: "主播名", platform: "douyu" }
{ roomId: "88888", nickname: "B站主播", platform: "bilibili" }
```

### `streamers` 数组（直播状态缓存）

```js
// 旧格式
{ roomId, nickname, title, online, coverUrl, avatarUrl, viewers, category, startTime }

// 新格式
{ roomId, nickname, platform, title, online, coverUrl, avatarUrl, viewers, category, startTime }
```

### `notifiedRooms` 数组（已通知列表）

```js
// 旧格式：["12345"]
// 新格式：[{ roomId: "12345", platform: "douyu" }]
```

### 向后兼容

`onInstalled` 时检测旧格式（数组项为字符串，或对象无 `platform` 字段），自动补齐 `platform: "douyu"`。

## 新文件：`lib/bilibili-api.js`

对标 `lib/douyu-api.js`，提供三个方法：

### API 端点

- 房间信息：`https://api.live.bilibili.com/room/v1/Room/get_info?room_id={roomId}`
- 用户信息：`https://api.live.bilibili.com/live_user/v1/UserInfo/get_uid_info?uid={uid}`

### 方法签名

| 方法 | 说明 |
|------|------|
| `fetchRoomInfo(roomId)` | 查询单个房间的直播信息 |
| `batchFetchRoomInfo(roomIds)` | 并行批量查询 |
| `resolveNickname(roomId)` | 解析主播名（添加房间时验证） |

### 字段映射

| `fetchRoomInfo` 输出字段 | Bilibili API 来源 |
|------------------------|------------------|
| `roomId` | `room_id` |
| `nickname` | `uname`（从 uid 信息获取） |
| `title` | `title` |
| `online` | `live_status === 1` |
| `coverUrl` | `user_cover` |
| `avatarUrl` | `face`（从 uid 信息获取） |
| `viewers` | `online` → `onlines` |
| `category` | `area_name` 或 `parent_area_name` |
| `startTime` | `live_time`（Unix 秒 → 毫秒） |

### 错误处理

- 网络超时：10s AbortController
- HTTP 非 200：返回 `{ success: false, error: 'http_error' }`
- JSON 解析失败：返回 `{ success: false, error: 'parse_error' }`
- 房间不存在（API 返回 code ≠ 0）：返回 `{ success: false, error: 'room_not_found' }`

## 核心逻辑变更（`background.js`）

### `refreshRooms()` — 按平台分组轮询

1. 读取 `rooms` 列表
2. 按 `platform` 字段分组 → `douyuIds`、`bilibiliIds`
3. 并发调用：
   - `DouyuAPI.batchFetchRoomInfo(douyuIds)`
   - `BilibiliAPI.batchFetchRoomInfo(bilibiliIds)`
4. 合并结果数组，确保每个流数据携带 `platform` 标记
5. 继续使用现有逻辑：对比 `prevOnlineRoomIds`、更新 badge、检测新开播

### 新开播检测（`checkNewLiveStreams`）

- 对比上一轮在线状态时，使用 `roomId + platform` 的组合键
- `notifiedRooms` 存储 `{roomId, platform}` 对象
- 判断 `isNewlyLive` 时，同时匹配 roomId 和 platform

### 通知内容

- 斗鱼：标题 `🔴 [斗鱼] 主播名 开播了！`，跳转 `https://www.douyu.com/{roomId}`
- Bilibili：标题 `🟣 [B站] 主播名 开播了！`，跳转 `https://live.bilibili.com/{roomId}`

### 通知 ID

- 使用 `{platform}_{roomId}` 格式（如 `douyu_12345`、`bilibili_88888`），防止跨平台同 roomId 冲突

### 房间管理（`handleAddRoom` / `handleRemoveRoom`）

- 消息协议：`ADD_ROOM` 增加 `platform` 参数
- `handleAddRoom(roomId, platform)`：根据 platform 选择 API 调用 `resolveNickname`
- 添加成功后立即可 `pre-add to notifiedRooms` 使用复合键
- `handleRemoveRoom(roomId, platform)`：删除时同时匹配 roomId 和 platform

## 平台标识方案

使用 **emoji + 文字标签** 方式（轻量，无需额外图片资源）。

| 位置 | 斗鱼 | Bilibili |
|------|------|----------|
| options 房间列表 | `🔴 斗鱼` 标签 | `🟣 B站` 标签 |
| popup 主播卡片 | `🔴 斗鱼` 角标 | `🟣 B站` 角标 |
| 通知标题 | `🔴 [斗鱼] ...` | `🟣 [B站] ...` |

## 权限变更

### `manifest.json`

```json
"host_permissions": [
  "https://www.douyu.com/*",
  "https://api.live.bilibili.com/*"
]
```

## UI 变更

### Options 页面

- 添加房间输入行增加一个平台下拉选择器（斗鱼 / B站）
- 房间列表项左侧增加平台标签

### Popup 页面

- 在线直播卡片增加平台标识角标
- 点击卡片根据平台跳转对应 URL

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `lib/bilibili-api.js` | **新增** | Bilibili API 封装 |
| `background.js` | **修改** | 平台感知轮询、通知、房间管理 |
| `manifest.json` | **修改** | 增加 Bilibili host 权限 |
| `lib/storage.js` | **修改** | `DEFAULT_STORAGE` 无变化；`notifiedRooms` 存储格式变更 |
| `options/options.js` | **修改** | 增加平台下拉选择、平台标签渲染 |
| `options/options.html` | **修改** | 增加平台选择 UI |
| `options/options.css` | **修改** | 平台标签样式 |
| `popup/popup.js` | **修改** | 平台标签渲染、跳转 URL 动态化 |
| `popup/popup.css` | **修改** | 平台标签样式 |

## 不涉及变更

- `popup/popup.html` — 结构无需改变
- `lib/douyu-api.js` — 完全不动
- `generate-icons.js` — 不涉及
- `icons/` — 平台标识用 emoji/文字，无需图标

## 边界情况与错误处理

1. **旧数据迁移**：`onInstalled` 检测旧格式 `notifiedRooms`（纯字符串数组），自动转为 `[{roomId, platform: 'douyu'}]`
2. **空平台轮询**：如果某个平台没有已添加的房间，跳过该平台 API 调用
3. **部分 API 失败**：`batchFetchRoomInfo` 已设计为部分失败不影响其他房间
4. **通知 ID 冲突**：`{platform}_{roomId}` 确保跨平台唯一
5. **删除房间**：必须同时匹配 `roomId + platform`，允许不同平台相同 roomId 共存
6. **同房间号跨平台**：如果用户同时添加了斗鱼房间 12345 和 B站房间 12345（假设存在），它们是各自独立的条目
