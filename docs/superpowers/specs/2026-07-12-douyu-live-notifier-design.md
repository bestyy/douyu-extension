# 斗鱼关注开播通知 Chrome 插件 — 设计文档

## 概述

一个 Chrome 浏览器扩展，用于监控斗鱼直播平台用户的关注列表，实时显示已开播的主播，并支持一键跳转直播间。

## 项目架构

```
douyu-extensions/
├── manifest.json              # Manifest V3 配置
├── background.js              # Service Worker - 轮询 + 通知
├── popup/
│   ├── popup.html             # 弹窗 UI
│   ├── popup.js               # 弹窗逻辑
│   └── popup.css              # 弹窗样式
├── options/
│   ├── options.html           # 设置页 (Cookie 管理)
│   ├── options.js             # 设置页逻辑
│   └── options.css            # 设置页样式
├── lib/
│   ├── douyu-api.js           # 斗鱼 API 封装
│   └── storage.js             # Chrome Storage 封装
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 技术选型

| 维度 | 选择 |
|------|------|
| 清单版本 | Manifest V3 |
| 后台脚本 | Service Worker |
| 存储 | chrome.storage.local |
| 定时触发 | chrome.alarms (最小间隔 1 分钟) |
| 通知 | chrome.notifications |
| API 鉴权 | Cookie (acf_uid, acf_auth, etc.) |

## 核心数据流

```
Service Worker (background.js)
    │
    ├── chrome.alarms 定时触发
    │       │
    │       ▼
    │   douyu-api.js.fetchFollowList(cookie)
    │       │
    │       ▼
    │   GET https://www.douyu.com/wgapi/livenc/liveweb/follow/list?sort=0&cid1=0
    │   Headers: Cookie: acf_uid=xxx; acf_auth=xxx; ...
    │       │
    │       ▼
    │   返回 JSON → 筛选 show_status === 1
    │       │
    │       ▼
    │   写入 chrome.storage.local
    │       │
    │       ├── 更新 badge 文本（在线人数）
    │       └── 检测新开播 → 发 chrome.notifications
    │
Popup (popup.js)
    │
    └── 从 chrome.storage.local 读取 streamers 数据
        → 渲染开播卡片列表
```

## 界面设计

### Popup 弹窗

```
┌──────────────────────────────┐
│  🔴 斗鱼关注开播通知     3 在线 │
├──────────────────────────────┤
│  ┌──────┐  我就是那个菜         │
│  │封面图 │  直播中              │
│  │       │  DOTA2 · 2,345 人   │
│  └──────┘  → 点击进入直播间    │
├──────────────────────────────┤
│  ┌──────┐  今天唱什么          │
│  │封面图 │  直播中              │
│  │       │  颜值 · 56 人       │
│  └──────┘  → 点击进入直播间    │
├──────────────────────────────┤
│  [🔄 刷新]     [⚙️ 设置]       │
└──────────────────────────────┘
```

### Options 设置页

```
┌──────────────────────────────┐
│  斗鱼直播通知 - 设置          │
├──────────────────────────────┤
│  🔑 Cookie                   │
│  ┌────────────────────────┐  │
│  │ 粘贴 Cookie 字符串...  │  │
│  └────────────────────────┘  │
│  [保存 Cookie] [测试连接]    │
│                              │
│  ⏱️ 刷新间隔                 │
│  [60 秒]                     │
│                              │
│  🔔 通知                     │
│  [✓] 新开播时发送通知        │
└──────────────────────────────┘
```

## API 接口

### 1. 获取关注列表

```
GET https://www.douyu.com/wgapi/livenc/liveweb/follow/list?sort=0&cid1=0

Cookie: acf_uid=xxx; acf_auth=xxx; acf_biz=xxx; acf_stk=xxx; acf_ct=xxx; acf_ltkid=xxx

响应格式:
{
  "error": 0,
  "data": {
    "list": [
      {
        "room_id": 12345,
        "nickname": "主播名",
        "room_name": "直播间标题",
        "room_src": "https://.../cover.jpg",
        "avatar": "https://.../avatar.jpg",
        "show_status": 1,           // 1=直播中, 0=未开播
        "hn": 2345,                 // 观看人数
        "show_time": 1712345600,     // 开播时间戳
        "cid1": 1,
        "cname1": "游戏",           // 一级分类
        "cid2": 3,
        "cname2": "DOTA2"          // 二级分类
      }
    ]
  }
}
```

### 2. 测试 Cookie 有效性

```
GET https://www.douyu.com/japi/roomuserlevel/apinc/levelInfo?rid=1

Cookie: ... (同上)

响应: error === 0 表示 cookie 有效
```

## Chrome Storage 数据结构

```json
{
  "cookie": {
    "value": "acf_uid=xxx; acf_auth=xxx; ...",
    "lastChecked": 1712345678000
  },
  "streamers": [
    {
      "roomId": "12345",
      "nickname": "我就是那个菜",
      "title": "今天冲一万分",
      "online": true,
      "coverUrl": "https://...",
      "avatarUrl": "https://...",
      "viewers": 2345,
      "category": "DOTA2",
      "startTime": 1712345600000
    }
  ],
  "lastRefresh": 1712345678000,
  "notifiedRooms": ["12345"],
  "settings": {
    "refreshInterval": 60,
    "notificationsEnabled": true
  }
}
```

## 状态与错误处理

| 场景 | 处理方式 |
|------|----------|
| Cookie 未设置 | Popup 显示"请先在设置页配置 Cookie" |
| Cookie 过期 (API 返回 401) | 标记无效，Popup 显示"Cookie 已过期，请更新" |
| 无主播开播 | 显示"当前没有主播开播 ☕" |
| 网络错误 | 显示"网络异常，请稍后重试" |
| API 限频 | 静默跳过本次轮询 |
| 空关注列表 | 显示"关注列表为空" |
| 新开播检测 | 对比 localStorage 缓存，仅在状态从 offline→online 时推送通知 |
| 封面图加载失败 | 显示默认占位图 |

## 隐私与安全

- Cookie 仅存储在本地 chrome.storage 中，不会发送到第三方服务器
- 所有 API 请求直接发送到 douyu.com，不经过代理
- 插件仅请求 `*.douyu.com` 的 host_permission

## 后续可能的扩展

- ~~多账户支持~~ （暂不实现，YAGNI）
- ~~自定义分组/排序~~ （暂不实现，YAGNI）
- ~~开播历史记录~~ （暂不实现，YAGNI）
