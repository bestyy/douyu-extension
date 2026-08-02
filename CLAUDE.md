# 斗鱼关注开播通知 - Chrome Extension

实时监控斗鱼 / Bilibili 直播间开播状态，支持通知推送和快速跳转。

## Architecture

```
douyu-extensions/
├── background.js          # Service Worker — 核心轮询、房间管理、通知
├── manifest.json          # Chrome Extension Manifest V3
├── lib/
│   ├── douyu-api.js       # 斗鱼公开 API 封装（/betard/ endpoint）
│   ├── bilibili-api.js    # Bilibili 公开 API 封装
│   ├── douyu-barrage.js   # 斗鱼弹幕 WebSocket 客户端（贵宾数 oni 消息）
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
- `lib/bilibili-api.js` - Bilibili API 封装，使用 `api.live.bilibili.com` 和 `api.bilibili.com` 公开接口（无需 Cookie）
  - `fetchRoomInfo(roomId)` — 两步查询：房间信息 → 主播名片获取昵称/头像
  - `batchFetchRoomInfo(roomIds)` — 批量并行查询
  - `resolveNickname(roomId)` — 解析主播名（添加房间时验证）
- `lib/storage.js` - 存储工具，操作 `chrome.storage.local`，包含默认配置 `DEFAULT_STORAGE`
- `lib/douyu-barrage.js` - 斗鱼弹幕 WebSocket 客户端（贵宾数推送）
  - 直连 `wss://danmuproxy.douyu.com:8501-8505/`，**无需 vk 签名**，随机 visitor 身份即可登录
  - 每个斗鱼房间一条连接：`loginreq`（ver@=20220825/aver@=218101901）+ `joingroup`（gid@=1）→ 消息流
  - 心跳 `type@=mrkl/` 每 45 秒；断线指数退避重连（2s 起，上限 60s），失败自动轮换端口
  - 贵宾数来自 `oni` 消息的 `vn` 字段，约每 6 秒推送一次 → 回调 `{ roomId, vipCount }`
  - 帧格式：`4B 小端长度 + 4B 小端长度 + 4B 小端类型(689) + UTF-8 body + \0`，长度 = body 字节数 + 9
- `options/options.js` - 设置页，通过 `chrome.runtime.sendMessage` 与 background 通信

## Storage Schema

```
rooms:          [{ roomId: string, nickname: string, platform: 'douyu'|'bilibili', notify?: boolean }]  — 已添加的房间列表；notify 控制单房间通知开关，默认 false
streamers:      [{ roomId, nickname, title, online, coverUrl, avatarUrl, viewers, category, startTime, platform, vipCount? }]  — vipCount 为斗鱼贵宾数，来自弹幕 oni 推送，非 API 字段
notifiedRooms:  [{ roomId: string, platform: string }]  — 已发送过通知的房间 ID
lastRefresh:    timestamp
settings:       { refreshInterval: number(秒), notificationsEnabled: boolean, openInCurrentTab: boolean }
```

## Non-Obvious Commands & Workflows

- 添加房间流程：options 页面发送 `ADD_ROOM` → `handleAddRoom` 调用 `resolveNickname`（验证房间存在并获取主播名）→ 成功后立即触发一次 `refreshRooms`
  - 自动兜底：如果所选平台解析失败，自动尝试另一个平台
- 手动刷新：发送 `MANUAL_REFRESH` 消息触发一轮立即轮询
- 设置变更：发送 `SETTINGS_UPDATED` 消息重建 alarm（更新刷新间隔）
- 首次安装：`onInstalled` 初始化存储，标记 `_firstRun`，首次轮询时不发送通知
- 刷新间隔：通过 `chrome.alarms` 实现，最小 60 秒
- Per-room 通知开关：每个房间独立控制是否发送开播通知（`rooms[].notify`），新添加的房间默认 `notify: false`（不通知），用户需在设置页通过 checkbox 手动开启
- 贵宾数数据流：danmuproxy WS → `douyu-barrage.js` 解析 oni → background 写 `streamers[].vipCount` → popup 卡片显示「X 贵宾」（仅斗鱼且 > 0 时显示）
  - Service Worker 每次唤醒、ADD_ROOM/REMOVE_ROOM 后调用 `syncBarrageRooms()` 同步订阅；`refreshRooms` 合并时从 prevMap 透传 `vipCount`（API 不返回该字段）
  - oni 每 6 秒推送天然保活 Service Worker；未开播房间可能无 oni 推送，此时不显示贵宾数

## Gotchas

- **斗鱼 API 端点已变更**：旧 `/japi/room/info/{id}` 已失效，当前使用 `/betard/{id}`。如果将来端点再次变更，需要更新 `lib/douyu-api.js`
- **权限**：需要 `storage`、`alarms`、`notifications` 权限以及 `https://www.douyu.com/*`、`https://api.live.bilibili.com/*`、`https://api.bilibili.com/*` 主机权限
- **Service Worker**：Chrome 可能因空闲超时终止 Service Worker，轮询由 `chrome.alarms` 触发自动唤醒
- **通知格式**：通知标题自动添加 `[斗鱼]` 或 `[B站]` 前缀区分平台；通知 ID 使用 `platform_roomId` 格式
- **`room_src`**（封面图）：斗鱼 `/betard/` API 返回相对路径，`fetchRoomInfo` 中已做三级补全：`http` 开头直接使用，`//` 开头补 `https:`，否则补 `https://rpic.douyucdn.cn/`；`owner_avatar` 返回完整 URL，无需处理
- **数据迁移**：`storage.js` 的 `migrateLegacyFormat` 在 `onInstalled` 时自动将旧格式（`notifiedRooms` 为 `string[]`、`rooms`/`streamers` 无 `platform` 字段）迁移到新格式（`{roomId, platform}[]`）
- **封面图回退**：popup 中封面图加载失败时自动回退到 `icons/icon48.png`，且使用 `referrerPolicy: 'no-referrer'` 避免跨域引用问题

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件形式存放在 `.scratch/<feature-slug>/` 下。详见 `docs/agents/issue-tracker.md`。

### Domain docs

Single-context 布局：`CONTEXT.md` + `docs/adr/` 在仓库根目录。详见 `docs/agents/domain.md`。
