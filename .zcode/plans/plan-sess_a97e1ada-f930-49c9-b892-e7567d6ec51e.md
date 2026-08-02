## 目标
把斗鱼弹幕 WebSocket 的 oni 消息(贵宾数)接入扩展,在 popup 房间卡片中显示"X 贵宾"。

## 已确认的协议(逆向成果)
- 直连 `wss://danmuproxy.douyu.com:8505/`(页面实际使用),**无需 vk 签名**(仅 gateway 中转需要,已从 common_65f59e8.js 提取:barrageLogin 只加 ver/aver/ct)
- 帧格式:4 字节小端长度 + 4 字节小端类型(689) + UTF-8 文本体(`key@=value/` 分隔,列表 `@AA=`/`@AS` 分隔)
- loginreq:`type@=loginreq/roomid@=XXX/dfl@=/username@=visitor<随机>/uid@=<随机>/ver@=20220825/aver@=218101901/ct@=0/`
- 订阅:`type@=joingroup/rid@=XXX/gid@=1/`(每个房间一条,单连接可订阅多房间)
- 心跳:`type@=mrkl/` 每 45 秒
- 贵宾数:oni 消息 `vn` 字段,约每 6 秒推送,按 `rid` 区分房间
- 版本常量:`LOGIN_VERSION=20220825`、`COUNT_VERSION=218101901`(common_65f59e8.js:9646)

## 实施步骤

### 1. 直连验证(实现第一步)
用 Node REPL 本地直连 danmuproxy 发送 loginreq+joingroup,验证随机 visitor 身份可收到 oni。若被拒,启用备选 gateway 方案(vk = md5(rt + salt + devid),salt 和算法已提取,devid 用随机 32 位 hex)。

### 2. 新增 `lib/douyu-barrage.js`(斗鱼弹幕客户端)
- `encodeFrame(body)`/`decodeFrame(buf)`:二进制协议编解码
- `parseDyMessage(body)`:key@=value 解析(含 @AA= 列表)
- `createBarrageClient({ onVipCount })`:
  - 连接 danmuproxy(8505 优先,失败轮换 8501-8504)
  - loginreq + 逐房间 joingroup
  - 45s mrkl 心跳
  - oni 解析 → 回调 `{ rid, vipCount: vn }`
  - 断线指数退避重连(2s 起,上限 60s),房间列表变化时重建连接
- 风格:无分号、单引号、2 空格缩进、中文注释、`{success, data?, error?}` 信封(与 douyu-api.js 一致)

### 3. 修改 `background.js`
- 引入 BarrageClient,维护订阅房间列表(读 storage.rooms 中 platform=douyu 的)
- 收到 oni → 更新 `streamers[].vipCount`(写入 chrome.storage.local)
- `refreshRooms` 合并时从 prevMap 透传 vipCount(仿 notify 透传模式,background.js:87,避免 API 轮询覆盖)
- ADD_ROOM/REMOVE_ROOM 后重建订阅
- 复用现有 alarm:每次唤醒检查 WS 存活,断开则重连(WS 每 6 秒有消息,天然保活 SW,alarm 仅兜底)

### 4. 修改 `popup.js` + `popup.css`
- `streamer-meta` 行新增:`· X 贵宾`(仅 douyu 平台、vipCount > 0 时显示;未开播/无数据显示 "--" 或隐藏,降级不破坏现有 UI)
- 复用现有 `formatNumber`(popup.js:140)格式化

### 5. 更新 `CLAUDE.md`
- Storage Schema 增加 `streamers[].vipCount`
- 记录 barrage 连接方案、协议要点(loginreq 无需签名、oni 消息结构)

## 数据流
```
danmuproxy WS → douyu-barrage.js 解析 oni → background 写 storage.streamers[].vipCount
→ popup 打开读 storage → 卡片显示 "X 贵宾"(≤6 秒延迟,与页面同步)
```

## 风险与备选
- 直连被拒 → gateway 中转方案(vk 算法已完整提取,含 salt:`r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p[`)
- 某房间无 oni 推送(未开播)→ 不显示贵宾数,不影响现有功能
- 不修改 manifest(无需新增权限,wss 连接在 MV3 不需要 host_permissions;若走 gateway 也只需现有 https://www.douyu.com/* 权限)

## 验证
- 加载扩展,添加斗鱼房间,等 10 秒,popup 显示贵宾数,与斗鱼网页"贵宾(NNN)"对比一致
- 多房间、增删房间、断网重连场景