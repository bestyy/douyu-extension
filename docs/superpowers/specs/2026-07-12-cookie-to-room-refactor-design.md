# Cookie 转房间号监控重构 — 设计文档

## 概述

将斗鱼开播通知 Chrome 扩展的鉴权方式从**手动 Cookie 鉴权**改为**房间号直连监控**。用户只需输入房间号，扩展自动通过斗鱼公开 API 查询直播状态，不再依赖登录 Cookie。

## 动机

- 手动复制 Cookie 操作繁琐，且 Cookie 会过期需频繁更新
- Cookie 字段多（acf_uid, acf_auth, acf_biz 等 6 个字段），用户容易漏复制
- 斗鱼房间公开 API 无需鉴权即可获取直播状态

## 架构变化

### 旧架构

```
登录 Cookie → 关注列表 API (需鉴权) → 全部关注主播的直播状态
```

### 新架构

```
房间号列表 → roomBase 公开 API (无需鉴权) → 每个房间的直播状态
```

### 改动文件清单

| 文件 | 改动程度 |
|------|----------|
| `lib/douyu-api.js` | 重写 — 移除 Cookie 相关，新增 `fetchRoomInfo` / `batchFetchRoomInfo` |
| `lib/storage.js` | 小改 — `DEFAULT_STORAGE` 中 `cookie` → `rooms` |
| `background.js` | 中等改动 — 轮询逻辑改为遍历房间号并行查询 |
| `options/options.html` | 重写 — 移除 Cookie 卡片，改为房间号管理 UI |
| `options/options.js` | 重写 — Cookie 保存/测试 → 房间号增删/自动解析 |
| `options/options.css` | 小改 — 微调样式适应新 UI |
| `popup/popup.html` | 小改 — 移除 cookieExpired 状态，noCookie → noRoom |
| `popup/popup.js` | 小改 — 移除 Cookie 过期检测逻辑 |
| `manifest.json` | 不变 |

## API 层：`lib/douyu-api.js`

### 新的公开接口方法

使用斗鱼公开房间信息 API（无需 Cookie）：

```
GET https://www.douyu.com/japi/room/info/{roomId}
```

响应格式（片段）：
```json
{
  "error": 0,
  "data": {
    "room_id": "12345",
    "owner_name": "我就是那个菜",
    "room_name": "今天冲一万分",
    "room_src": "https://.../cover.jpg",
    "show_status": "1",
    "hn": "2345",
    "cate_name": "DOTA2",
    "show_time": "1712345600"
  }
}
```

### 新增方法

| 方法 | 说明 |
|------|------|
| `fetchRoomInfo(roomId)` | 查询单个房间的直播状态和信息 |
| `batchFetchRoomInfo(roomIds)` | 并行查询多个房间，用 `Promise.allSettled` 处理部分失败 |
| `resolveNickname(roomId)` | 根据房间号获取主播名，用于添加房间时自动解析 |

### 移除的方法

- ~~`_parseCookie`~~
- ~~`validateCookie`~~
- ~~`fetchFollowList`~~
- ~~`testCookie`~~

### 设计细节

- 每个请求 10 秒超时，避免坏房间号卡住
- 单个房间失败不影响其他房间
- 请求频率：十几个房间同时并行，1-2 秒内完成

## 数据存储：`lib/storage.js`

`DEFAULT_STORAGE` 变化：

```diff
- cookie: { value: '', lastChecked: 0 },
+ rooms: [],
```

移除所有 `_cookieError` 相关字段。

`rooms` 存储结构：
```json
{
  "roomId": "12345",
  "nickname": "我就是那个菜"
}
```

`streamers` 字段格式不变，popup 渲染逻辑无需修改。

## Service Worker：`background.js`

### 轮询流程（新）

```
chrome.alarms 定时触发
    │
    ▼
从 storage 读取 rooms 列表
    │
    ├── 空列表 → 跳过（未配置房间号）
    │
    ▼
batchFetchRoomInfo(roomIds)  ← 并行查询每个房间
    │
    ▼
合并结果 → 写入 storage.streamers
    │
    ├── 更新 badge（在线人数）
    └── checkNewLiveStreams()  ← 逻辑不变
```

### 消息处理变化

| 旧消息 | 变化 | 新消息 |
|--------|------|--------|
| `TEST_COOKIE` | 移除 | — |
| `MANUAL_REFRESH` | 保留 | 同名称 |
| `SETTINGS_UPDATED` | 保留 | 同名称 |
| 新增 | — | `ADD_ROOM`（添加房间时由 Options 页调用） |

### 错误处理

- 无效房间号（API 返回非 0 error）：记录但跳过，不影响其他房间
- 网络错误：静默跳过该房间
- 所有房间都失败：保留上次的 `streamers` 缓存

## Options 设置页

### 新 UI 布局

```
┌─────────────────────────────────────┐
│     ⚙️ 斗鱼直播通知 设置              │
├─────────────────────────────────────┤
│  📺 房间号管理                        │
│                                      │
│  ┌─────────────────────────────┐    │
│  │ 输入房间号 (如 12345)        │    │
│  └─────────────────────────────┘    │
│  [➕ 添加房间]                       │
│                                      │
│  已添加的房间：                       │
│  ┌──────────────────────────────┐   │
│  │ 🟢 12345  我就是那个菜     ✕  │   │
│  │ 🔴 67890  YYF             ✕  │   │
│  └──────────────────────────────┘   │
│                                      │
│  [🔄 刷新全部状态]                    │
├─────────────────────────────────────┤
│  ⏱️ 刷新设置（不变）                  │
├─────────────────────────────────────┤
│  🔔 通知设置（不变）                  │
└─────────────────────────────────────┘
```

### 房间号输入交互

1. 用户输入房间号（纯数字），点击"添加"或按 Enter
2. 前台调用 `chrome.runtime.sendMessage({ type: 'ADD_ROOM', roomId })`
3. Background 调用 `DouyuAPI.resolveNickname(roomId)` 解析主播名
4. 成功：添加到 `rooms` 列表，同时立即查询一次直播状态写入 `streamers`
5. 失败：提示"房间号不存在或无效"
6. 重复：提示"该房间已在监控列表中"

### 已添加房间的实时状态

每个房间条目显示在线状态（🟢/🔴），数据来源于 `streamers` 缓存，不额外请求 API。

### 被移除的内容

- Cookie 输入框
- 保存 / 测试 Cookie 按钮
- "如何获取 Cookie" 帮助卡片
- Cookie 相关的状态提示（expired 等）

## Popup 弹窗

### 变化

- 移除 `#cookieExpired` 状态展示
- `#noCookie` 改为 `#noRoom`，文案："⚠️ 未配置监控房间" → "请前往设置页添加房间号"
- `loadData()` 中移除 `_cookieError` 检测
- 其余渲染逻辑完全不变

### 状态展示逻辑（新）

```
storage 加载
    │
    ├── rooms 为空 → 显示"未配置监控房间"
    │
    ├── streamers 为空 → 显示"当前没有主播开播"
    │
    └── 有开播主播 → 渲染卡片列表
```

## 未变动的部分

- `popup/popup.css` — 无需修改
- `manifest.json` — 权限不变
- 通知逻辑（`checkNewLiveStreams`）— 完全复用
- Badge 更新逻辑 — 完全复用
- 设置页的刷新间隔 / 通知开关卡片 — UI 和逻辑不变

## 状态与错误处理

| 场景 | 处理方式 |
|------|----------|
| 未配置房间号 | Popup 显示"请先在设置页添加房间号" |
| 全部房间离线 | 显示"当前没有主播开播 ☕" |
| 部分房间查询失败 | 跳过失败房间，正常处理其他房间 |
| 房间号无效 | 添加房间时提示，不加入列表 |
| 网络错误 | 保留上次 streamers 缓存，静默跳过 |

## 隐私与安全

- 不再存储 Cookie，只需要公开的房间号
- 所有 API 请求直接发送到 douyu.com，不经过代理
- 房间号仅存储在本地 chrome.storage 中
