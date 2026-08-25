# 斗鱼关注开播通知 - Chrome Extension

实时监控斗鱼 / Bilibili 直播间开播状态，支持通知推送和快速跳转。

## Architecture

```
douyu-extensions/
├── background.js          # Service Worker — 核心轮询、房间管理、通知（桥接通道逻辑已外移）
├── manifest.json          # Chrome Extension Manifest V3
├── lib/
│   ├── douyu-api.js       # 斗鱼公开 API 封装（/betard/ endpoint）
│   ├── bilibili-api.js    # Bilibili 公开 API 封装
│   ├── douyu-barrage.js   # 斗鱼弹幕 WS 采样客户端（贵宾数 oni 消息，每房间一条连接）
│   ├── bilibili-barrage.js   # B站弹幕 WS 采样客户端（高能榜在线数，SW 直连主通道 + 页面通道复用）
│   ├── bilibili-page-bridge.js # B站页面通道 content script（桥接标签页，仅 ?dyext=1 激活）
│   ├── bili-bridge-channel.js # B站页面桥接通道深 module（sync/sample/close/enableFallback/enabled）
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
├── test/                  # node:test 测试（npm test）
└── generate-icons.js      # 图标生成工具
```

## Key Files

- `background.js` - Service Worker，管理定时轮询（`refreshRooms`）、添加/删除房间（`handleAddRoom`/`handleRemoveRoom`）、发送桌面通知；B站页面桥接通道的状态与编排收进 `BiliBridgeChannel`，background 只保留降级编排（`handleBiliChannelFallback`：`enableFallback` → `destroy` → 通知）
- `lib/douyu-api.js` - 斗鱼 API 封装，使用公开端点 `https://www.douyu.com/betard/{roomId}`（无需 Cookie）
  - `fetchRoomInfo(roomId)` — 查询单个房间的直播信息
  - `batchFetchRoomInfo(roomIds)` — 批量并行查询
  - `resolveNickname(roomId)` — 解析主播名（添加房间时验证）
- `lib/bilibili-api.js` - Bilibili API 封装，使用 `api.live.bilibili.com` 和 `api.bilibili.com` 公开接口（无需 Cookie）
  - `fetchRoomInfo(roomId)` — 两步查询：房间信息 → 主播名片获取昵称/头像
  - `batchFetchRoomInfo(roomIds)` — 批量并行查询
  - `resolveNickname(roomId)` — 解析主播名（添加房间时验证）
- `lib/storage.js` - 存储工具，操作 `chrome.storage.local`，包含默认配置 `DEFAULT_STORAGE`
- `lib/douyu-barrage.js` - 斗鱼弹幕 WS 采样客户端（贵宾数推送）
  - 直连 `wss://danmuproxy.douyu.com:8501-8505/`，**无需 vk 签名**，随机 visitor 身份即可登录
  - 每条连接：`loginreq`（ver@=20220825/aver@=218101901）+ `joingroup`（gid@=1）→ 消息流
  - 贵宾数来自 `oni` 消息的 `vn` 字段，约每 6 秒推送一次 → 回调 `{ roomId, vipCount }`
  - 帧格式：`4B 小端长度 + 4B 小端长度 + 4B 小端类型(689) + UTF-8 body + \0`，长度 = body 字节数 + 9
  - **采样模式**：每个房间一条连接（实测 danmuproxy 单连接多 joingroup 只响应第一个房间，见 `.pi/test-douyu-multiroom.cjs`），收到贵宾数或 20 秒超时后立即断开，平时零 WS 连接
  - **未开播兜底**：未开播房间不推送 oni（实测 `betard` 的 `show_status !== 1`），超时后查询开播状态按贵宾数 0 上报，避免「漏采」误判；oni 无 `vn` 字段（未开通贵宾）同样按 0 上报
  - **超时重试一次**：开播中但 20 秒超时未收到 oni（网络抖动等）→ 立即重连重试一次（`_connect(roomId, true)` 继承重试标记，防止无限重试），重试连接仍超时则本轮跳过；避免「开播中却漏采」
- `lib/bilibili-barrage.js` - B站弹幕 WS 客户端（高能榜在线数），双模式共存：
  - **采样模式**（`sample(roomIds)`，SW 直连主通道/未登录用）：每个房间一条短连，收到第一条高能榜在线数即断开，20s 超时收尾，平时零 WS 连接
  - **长连接模式**（`setRooms(roomIds)`，页面桥接通道/登录态用）：心跳保活（30s）+ 异常断开指数退避重连 + 1006 快速断开轮换服务器；登录态下采样短连同样被 1006 风控，必须长连接（用户实测）。页面桥接同样按 10 分钟采样节奏使用：临时开页建连，拿到数据即断开并关闭页面（见 `lib/bilibili-page-bridge.js`）
  - comet 通道（getDanmuInfo 的 host_list，2245 端口）；认证包（op=7, protover=2）需带真实房号（短房号先经 room_init 解析）、spi 签发配对 buvid、support_ack/queue_uid/scene 字段
- `lib/bilibili-page-bridge.js` - B站页面通道 content script（登录态主通道 + SW 直连被风控时的降级后备，由 manifest 注入 live.bilibili.com）
  - 仅桥接标签页激活（URL 带 `?dyext=1`，SW 采样时临时创建/复用/存活检测）；响应 `BILI_PING`（存活检测）与 `BILI_SAMPLE_ROOMS`（驱动一轮采样：长连接建连，收到各房间高能榜在线数即断开全部 WS，60s 总超时兜底），结果经 `BILI_RANK_COUNT` 回传，完成后发 `BILI_SAMPLE_DONE` 通知 SW 关闭本页
- `lib/bili-bridge-channel.js` - B站页面桥接通道深 module（构造注入 `{ storage, tabs, isLoggedIn }`，UMD 双兼容：importScripts + node require）
  - `sync()` — 通道决策：查询「B站观众数开关 / 房间列表有无 B站 / 登录态 / 持久化降级标记」产出通道状态（`enabled` getter），并处理副作用（关 B站开关时清 streamers 的 rankCount、关桥接页、持久化、切换日志；斗鱼 vipCount 不在此处理，由 background `pruneStaleViewerCounts` 负责）
  - `sample(roomIds)` — 页面通道采样：`_ensureTab`（并发去重锁）→ `_waitReady`（ping 重试）→ `BILI_SAMPLE_ROOMS`；未就绪/发送失败 → log + `close()`，fire-and-forget 不等待完成信号
  - `close()` — 只关 dyext=1 标记页，用户自开的 live.bilibili.com 页面不动
  - `enableFallback()` — 置内存标记 + 持久化 `biliPageChannelEnabled` + 日志（开关关闭/已启用时跳过）；`console.warn('[bili] SW 直连采样被风控，切换到页面通道')`
  - 测试：`test/bili-bridge-channel.test.cjs`（node:test，fake storage/tabs 设施，覆盖 14 个行为用例）
- `options/options.js` - 设置页，通过 `chrome.runtime.sendMessage` 与 background 通信

## Storage Schema

```
rooms:          [{ roomId: string, nickname: string, platform: 'douyu'|'bilibili', notify?: boolean }]  — 已添加的房间列表；notify 控制单房间通知开关，默认 false
streamers:      [{ roomId, nickname, title, online, coverUrl, avatarUrl, viewers, category, startTime, platform, vipCount?, rankCount? }]  — vipCount 为斗鱼贵宾数（弹幕 oni 推送），rankCount 为 B站高能榜在线数（ONLINE_RANK_COUNT 推送），均非 API 字段
notifiedRooms:  [{ roomId: string, platform: string }]  — 已发送过通知的房间 ID
lastRefresh:    timestamp
settings:       { refreshInterval: number(秒), notificationsEnabled: boolean, openInCurrentTab: boolean, fetchDouyuViewerCount: boolean, fetchBilibiliViewerCount: boolean, fetchViewerCount?: boolean }  — 观众数开关按平台拆分（2026-08）：斗鱼/B站各自独立；旧版仅有总开关 fetchViewerCount，读取时回退其语义（新字段优先），保存设置时删除旧字段
biliPageChannelEnabled: boolean  — 页面桥接通道启用标记（SW 直连被风控降级时持久化，重启后继续生效；由 biliBridge.sync() 统一重写）
```

## Non-Obvious Commands & Workflows

- 添加房间流程：options 页面发送 `ADD_ROOM` → `handleAddRoom` 调用 `resolveNickname`（验证房间存在并获取主播名）→ 成功后立即触发一次 `refreshRooms`
  - 自动兜底：如果所选平台解析失败，自动尝试另一个平台
- 手动刷新：发送 `MANUAL_REFRESH` 消息触发一轮立即轮询
- 设置变更：发送 `SETTINGS_UPDATED` 消息重建 alarm（更新刷新间隔），并重新同步弹幕订阅（观众数开关即时生效）
- 首次安装：`onInstalled` 初始化存储，标记 `_firstRun`，首次轮询时不发送通知
- 刷新间隔：通过 `chrome.alarms` 实现，最小 60 秒
- Per-room 通知开关：每个房间独立控制是否发送开播通知（`rooms[].notify`），新添加的房间默认 `notify: false`（不通知），用户需在设置页通过 checkbox 手动开启
- 贵宾数数据流：每 10 分钟采样一次（`chrome.alarms` 驱动 `sampleViewerCounts`）→ danmuproxy WS 短连 → `douyu-barrage.js` 解析 oni → background 写 `streamers[].vipCount` → popup 卡片显示「X 贵宾」（仅斗鱼且 > 0 时显示）
  - **采样模式（斗鱼始终 / B站未登录）**：每房间一条连接（认证/订阅必须按房间建连），收到数据立即断开，全部完成或超时（均 20s）收尾，平时零 WS 连接，连接数仅在采样窗口内等于房间数；**B站登录态走页面桥接**（同样 10 分钟采样节奏：临时开页长连接采样，见下），不参与 SW 直连短连采样
  - `refreshRooms` 合并时从 prevMap 透传 `vipCount`（API 不返回该字段）；斗鱼未开播房间超时后查 `betard` 兜底上报 0，B站未开播房间保持旧值
  - **B站 1006 风控的真正根因（2026-08 实证，推翻此前所有 Origin/Cookie 假设）**：对照真实直播间页面弹幕连接（`.pi/test-bili-comet.cjs` 三环境验证：node 自定义 Origin / chrome-extension Origin / 无 Cookie 头均连通）确认三点——
    - **通道**：必须用 getDanmuInfo 返回的 comet 服务器（`host_list`，2245 端口）；broadcast 7826 通道对非官方客户端握手即 1006，绝不能使用（旧代码硬编码 7826 优先是持续 1006 的直接原因）
    - **认证包字段**：必须带 `support_ack: true`、`queue_uid`（随机 8 位即可）、`scene: 'room'`（页面弹幕连接逐字对照抓包确认），缺失即被拒；`protover: 2` 请求 zlib（3 会收到 brotli，浏览器无解压 API）
    - **buvid 配对**：必须用 spi 接口（`/x/frontend/finger/spi`）签发的 buvid3/buvid4 配对（成对写入 Cookie）；旧版本用 `crypto.randomUUID()` 写入 buvid4 污染配对也会 1006。`resolveBuvid3()` 优先 spi，失败回退已有 Cookie，再兜底随机
  - **通道选择（登录态决定，2026-08 用户实证）**：登录态（SESSDATA Cookie）下 SW 直连的弹幕 WS 握手携带登录 Cookie，实测必被 1006 风控（spi 配对正确仍被拒，**采样短连与长连接均如此**）；未登录（无 Cookie）时 SW 直连短连采样可用。`biliBridge.sync()` 用 `isBiliLoggedIn()`（chrome.cookies.get SESSDATA）决策：**登录 → 页面桥接**（`biliPageChannelEnabled` 持久化；采样时 `biliBridge.sample()` 临时开页 + `BILI_SAMPLE_ROOMS` 驱动长连接采样，完成即关页），**未登录 → SW 直连采样**（`bilibiliBarrageClient.sample`）；未登录时被风控降级过的标记在重启后继续生效
  - **页面通道必须长连接（用户实测）**：登录态下桥接页短连采样同样收不到数据；`setRooms()` 长连接（心跳 30s + 指数退避重连）正常。2026-08 起两通道统一为 10 分钟采样节奏：页面通道每次采样临时开桥接页 → 长连接建连（拿首条高能榜在线数即收尾，60s 总超时兜底）→ `BILI_SAMPLE_DONE` 消息驱动 SW 关闭页面，平时无 WS 无常驻页面
  - **SW 直连（未登录）**：`sampleViewerCounts` 的 B站分支按 `biliBridge.enabled` 分流——关闭时直接 `bilibiliBarrageClient.sample(ids)`（SW 环境 chrome-extension Origin、无 Cookie 握手均实测可用）；被风控（本轮全败且快速断开）时 `onFallback` → `handleBiliChannelFallback` 编排：`biliBridge.enableFallback()`（持久化标记 `biliPageChannelEnabled`）→ `bilibiliBarrageClient.destroy()` → `chrome.notifications.create(...)`；标记统一由 `biliBridge.sync()` 按登录态/降级状态重写（onInstalled 不再重置，避免与顶层同步竞态覆盖，`_ensureTab` 的 ping 存活检测会自动刷新重注入失效桥接页）
  - 桥接标签页生命周期（临时采样，2026-08）：`biliBridge.sample()` 内 `_ensureTab`（并发去重锁 `_ensurePromise`，防止 alarm 与设置变更竞态重复弹页）用 `BILI_PING` 存活检测 + reload 重注入；`_dedupeTabs` 清理残留的多余桥接页（跨 SW 生命周期重载瞬间旧 SW 的创建请求可能已发出，内存锁无法跨实例）；采样完成/超时后桥接页发 `BILI_SAMPLE_DONE` 触发 `biliBridge.close()`（消息事件可靠唤醒休眠中的 SW，不在 SW 侧长等待）；无 B站房间或关闭开关时同样 `close()` 关闭；**无 onRemoved 自动重开**（临时模式下 SW 主动关页，兜底重开会残留页面）
  - ADD_ROOM/REMOVE_ROOM、设置变更（SETTINGS_UPDATED，如切换观众数开关）后立即采样一次，不用等下一个 10 分钟周期
- 观众数开关（2026-08 按平台拆分）：设置页两个开关独立控制——`fetchDouyuViewerCount`（斗鱼贵宾数）/`fetchBilibiliViewerCount`（B站高能榜在线数），均默认 true；旧版总开关 `fetchViewerCount` 保留为读取回退（新字段未写入时生效），新版本保存设置时删除。关闭斗鱼开关 → background `pruneStaleViewerCounts` 清 `streamers` 的 `vipCount`；关闭 B站开关 → `biliBridge.sync()` 清 `rankCount`、停用页面通道并关闭桥接标签页；无 B站房间时同样关闭桥接标签页但**不清 streamers**（斗鱼贵宾数仍有效，该分支有测试覆盖）；设置变更（`SETTINGS_UPDATED`）经 `syncViewerSettings()`（biliBridge.sync + pruneStaleViewerCounts）触发重新同步，开关即时生效

## Gotchas

- **斗鱼 API 端点已变更**：旧 `/japi/room/info/{id}` 已失效，当前使用 `/betard/{id}`。如果将来端点再次变更，需要更新 `lib/douyu-api.js`
- **权限**：需要 `storage`、`alarms`、`notifications` 权限以及 `https://www.douyu.com/*`、`https://api.live.bilibili.com/*`、`https://api.bilibili.com/*` 主机权限
- **Service Worker**：Chrome 可能因空闲超时终止 Service Worker，轮询由 `chrome.alarms` 触发自动唤醒
- **通知格式**：通知标题自动添加 `[斗鱼]` 或 `[B站]` 前缀区分平台；通知 ID 使用 `platform_roomId` 格式
- **`room_src`**（封面图）：斗鱼 `/betard/` API 返回相对路径，`fetchRoomInfo` 中已做三级补全：`http` 开头直接使用，`//` 开头补 `https:`，否则补 `https://rpic.douyucdn.cn/`；`owner_avatar` 返回完整 URL，无需处理
- **数据迁移**：`storage.js` 的 `migrateLegacyFormat` 在 `onInstalled` 时自动将旧格式（`notifiedRooms` 为 `string[]`、`rooms`/`streamers` 无 `platform` 字段）迁移到新格式（`{roomId, platform}[]`）
- **封面图回退**：popup 中封面图加载失败时自动回退到 `icons/icon48.png`，且使用 `referrerPolicy: 'no-referrer'` 避免跨域引用问题
- **测试设施**：`npm test`（node:test，零依赖）跑 `test/` 目录；lib 文件 UMD 双兼容（`importScripts` 下 `module` 未定义自动跳过，node 下可 `require`），module 内不引用 `chrome` 全局（依赖构造注入）才能被测试

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件形式存放在 `.scratch/<feature-slug>/` 下。详见 `docs/agents/issue-tracker.md`。

### Domain docs

Single-context 布局：`CONTEXT.md` + `docs/adr/` 在仓库根目录。详见 `docs/agents/domain.md`。
