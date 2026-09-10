# 直播开播通知扩展

一个 Chrome MV3 浏览器扩展：监控用户关注的直播平台房间（斗鱼 / B站 / 抖音）的开播状态，开播时发桌面通知，popup 中展示在线主播列表。扩展不登录任何平台账号，全部使用匿名公开接口轮询。

## Language

**平台 (platform)**:
直播平台。取值 `douyu` / `bilibili` / `douyin`。房间、主播、通知、设置开关均以平台为第一维划分。
_Avoid_: 站点、渠道（渠道专指 B站弹幕的传输通道）

**房间 (room)**:
用户在设置页添加、扩展持续监控的一个直播房间。唯一标识是 `platform + roomId` 复合键。对应存储中的 `rooms` 数组。
_Avoid_: 直播间（口语可以，代码/文档用"房间"）

**主播 (streamer)**:
某个房间当前的开播信息快照：是否在线、昵称、标题、封面、分类等。对应存储中的 `streamers` 数组，由轮询产出、由弹幕采样补充观众数字段。
_Avoid_: 用户（主播不是"用户"，扩展没有用户概念）

**房间号 (roomId)**:
用户在设置页输入的直播房间标识，字符串形式。斗鱼/B站必须是纯数字；抖音允许数字 web_rid 或字母抖音号（添加时统一解析为数字 web_rid 存储）。
_Avoid_: ID、房间 ID

**web_rid**:
抖音直播间 URL 路径段（`live.douyin.com/{web_rid}`），是抖音房间在 web 端的公开标识。API 轮询只接受数字 web_rid；字母抖音号仅用于 URL 导航，需解析为数字。
_Avoid_: 抖音房间号、抖音 ID

**贵宾数 (vipCount)**:
斗鱼直播间的贵宾（付费礼物用户）数量，通过弹幕 WebSocket 的 `oni` 消息采样获取，约每 6 秒推送一次。存储在 `streamers[].vipCount`。
_Avoid_: 观众数（贵宾数是斗鱼特有指标）

**高能榜 (rankCount)**:
B站直播间的高能榜在线数，通过弹幕 WebSocket 的 `ONLINE_RANK_COUNT` 消息采样获取。存储在 `streamers[].rankCount`。
_Avoid_: 观众数（高能榜是 B站特有指标）

**观众数 (viewer count)**:
各平台特有观众指标的统称：斗鱼贵宾数、B站高能榜。通过 10 分钟一次的弹幕 WebSocket 采样获取，每个平台独立开关控制。抖音暂不支持观众数功能。
_Avoid_: 在线人数（语义不同）

**采样 (sample)**:
每 10 分钟由 `chrome.alarms` 驱动的一次短连接弹幕 WebSocket 会话：连接 → 收到目标数据 → 立即断开。采样自身不保持连接。
_Avoid_: 长连接（长连接属于弹幕检测的检测长连接，见 ADR-0005）

**开播通知 (notification)**:
新开播时发送的桌面通知，格式 `[平台] 昵称 开播了！`。按房间可单独关闭（`rooms[].notify`）。
_Avoid_: 提醒、弹窗

**通道 (channel)**:
B站弹幕采样的传输方式，取值 `SW 直连` 或 `页面桥接`。登录态下 SW 直连握手必被风控，需页面桥接；未登录时 SW 直连可用。状态与编排封装在 BiliBridgeChannel。
_Avoid_: 平台、渠道

**弹幕客户端 (barrage client)**:
与平台弹幕服务器建 WebSocket 连接的客户端（`BarrageClient` / `BilibiliBarrageClient`）：采样模式解析 `oni` / `ONLINE_RANK_COUNT` 回调观众数字段，检测模式解析 `chatmsg` / `DANMU_MSG` 回调弹幕文本。两种模式各用独立实例（采样短连与检测长连接并存，见 ADR-0005）。
_Avoid_: WS 客户端（弹幕客户端是领域概念，WS 是技术细节）

**抖音签名 (a_bogus)**:
抖音 web 端 API 的请求签名（SM3+RC4+自定义 base64），`web/enter` 接口必需，缺失时返回空 body 风控。算法移植自 MIT 许可的开源实现，见 ADR-0001。
_Avoid_: 加密、token（a_bogus 是签名不是 token）

**未知状态 (unknown status)**:
抖音轮询在风控/网络异常下无法确定房间是否开播的状态（空 body / 503 / 参数错误）。未知 ≠ 未开播：保留上次已知状态并退避重试，不触发下播通知。
_Avoid_: 离线（离线是确定状态，未知不是）

**检测词 (keyword)**:
某房间启用的弹幕命中词，一房多词共用一个计数器，任一词命中即计数加一。子串包含、不区分大小写。
_Avoid_: 关键词、关键字、监控词

**弹幕检测 (danmaku watch)**:
对开启的房间在开播期间保持弹幕长连接、按滑动窗口计数命中、触发后进冷却的 per-room 功能，受全局总开关 `settings.danmakuWatchEnabled` 控制（默认开启；关闭后不再盯守任何房间、不排队、不发检测通知，各房已配的检测词保留）。与开播通知的 `notify` 正交，计数在下播时清空。
_Avoid_: 弹幕监控（监控指轮询开播状态，不是看弹幕文本）、关键词告警

**检测通知 (detection notification)**:
命中在窗口内达到阈值时发的桌面通知，按房间复用通知 ID 覆盖，不堆积，点击进入直播间。
_Avoid_: 提醒、弹窗、告警
