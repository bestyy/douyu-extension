# 斗鱼关注开播通知 - Chrome Extension

实时监控斗鱼直播间开播状态，支持通知推送和快速跳转。

## Architecture

```
douyu-extensions/
├── background.js          # Service Worker — 核心轮询、房间管理、通知
├── manifest.json          # Chrome Extension Manifest V3
├── lib/
│   ├── douyu-api.js       # 斗鱼公开 API 封装（/betard/ endpoint）
│   └── storage.js         # chrome.storage.local 封装
├── options/
│   ├── options.html       # 设置页：添加/删除房间、刷新间隔
│   ├── options.js         # 设置页逻辑
│   └── options.css
├── popup/
│   ├── popup.html         # 弹窗：显示直播间在线状态
│   ├── popup.js           # 弹窗逻辑
│   └── popup.css
├── icons/                 # 扩展图标
└── generate-icons.js      # 图标生成工具
```

## Key Files

- `background.js` - Service Worker，管理定时轮询（`refreshRooms`）、添加/删除房间（`handleAddRoom`/`handleRemoveRoom`）、发送桌面通知
- `lib/douyu-api.js` - 斗鱼 API 封装，使用公开端点 `https://www.douyu.com/betard/{roomId}`（无需 Cookie）
  - `fetchRoomInfo(roomId)` — 查询单个房间的直播信息
  - `batchFetchRoomInfo(roomIds)` — 批量并行查询
  - `resolveNickname(roomId)` — 解析主播名（添加房间时验证）
- `lib/storage.js` - 存储工具，操作 `chrome.storage.local`，包含默认配置 `DEFAULT_STORAGE`
- `options/options.js` - 设置页，通过 `chrome.runtime.sendMessage` 与 background 通信

## Storage Schema

```
rooms:          [{ roomId: string, nickname: string }]  — 已添加的房间列表
streamers:      [{ roomId, nickname, title, online, coverUrl, avatarUrl, viewers, category, startTime }]
notifiedRooms:  string[]  — 已发送过通知的房间 ID
lastRefresh:    timestamp
settings:       { refreshInterval: number(秒), notificationsEnabled: boolean }
```

## Non-Obvious Commands & Workflows

- 添加房间流程：options 页面发送 `ADD_ROOM` → `handleAddRoom` 调用 `resolveNickname`（验证房间存在并获取主播名）→ 成功后立即触发一次 `refreshRooms`
- 首次安装：`onInstalled` 初始化存储，标记 `_firstRun`，首次轮询时不发送通知
- 刷新间隔：通过 `chrome.alarms` 实现，最小 60 秒

## Gotchas

- **斗鱼 API 端点已变更**：旧 `/japi/room/info/{id}` 已失效，当前使用 `/betard/{id}`。如果将来端点再次变更，需要更新 `lib/douyu-api.js`
- **权限**：需要 `storage`、`alarms`、`notifications` 权限以及 `https://www.douyu.com/*` 主机权限
- **Service Worker**：Chrome 可能因空闲超时终止 Service Worker，轮询由 `chrome.alarms` 触发自动唤醒
- **`room_src`**（封面图）：斗鱼 `/betard/` API 返回相对路径（如 `asrpic/...avif/dy4`），已在 `fetchRoomInfo` 中自动补全 `https://www.douyu.com/` 前缀；`owner_avatar` 返回的是完整 URL，无需处理
