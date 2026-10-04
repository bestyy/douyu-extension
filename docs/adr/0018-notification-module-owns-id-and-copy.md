# 房间通知的 ID 体系与文案收敛到一个纯 module，总开关只声明不改行为

整理通知（见 CONTEXT.md「通知种类」）时撞上三处分散：六种房间通知外形一致（同图标 / 同「进入直播间」按钮 / 同优先级），却只有 `createRoomNotification` 与 `notificationTitlePrefix` 两个帮助函数共享；通知 ID 的后缀表虽集中在编排里，**构造**却在五个 notify 函数中各写各的后缀字面量、**解析**在 `liveUrlFromNotificationId` 里另写一套（还要为订阅的变长 `_sub_<id>` 特判）；文案同样分裂——订阅的标题 / 正文在一个纯模块（`lib/subscription-alert.js`），另四种内联在编排。更隐蔽的是总开关语义：`settings.notificationsEnabled` 名为全局，实际只管开播与订阅，检测 / 观众数 / 激增 / 看点绕过它，而这条规则只被测试固化、代码里读不出来。决定：把「通知长什么样、ID 是什么」整块收进一个纯 module。

**一、新增零依赖纯 module `lib/notifications.js`，拥有六类房间通知的外形。** 它注入「房间标识」module（`lib/room-identity.js`），对外只导出查询：`build(kind, facts) -> { id, content }`（`content` 即通知适配器要的 `{ title, message, contextMessage }`）、`parse(id) -> { kind, platform, roomId, subscriptionId? } | null`（与 `build` 成对互逆）、`isMasterSwitchOn(kind, settings) -> boolean`，以及种类名列表 `KIND_IDS`。登记表（种类 → 后缀 / 总开关 / 文案构造）私有，照 ADR-0005 与「房间标识」的纪律：消费方写不出表里的字段，日后改表形状不算破坏性变更。

**二、编排只留「取值」与「发送」，不再手搓 ID 与文案。** 编排的六个 notify 函数（开播 / 检测 / 观众数 / 激增 / 看点 / 订阅）保留，各自负责从快照或写回结果里取出该类所需的事实，再 `notifications.build(kind, facts)` + `createRoomNotification(id, content)`。`facts` 传领域数据（昵称、标题、阈值、当前值、条目…），展示计算（平台标签前缀、指标文案、`formatNumber`、`truncateDanmu`、拼接与截断）全在 module 内——因为「通知长什么样」正是它的职责。编排里的 `ORCHESTRATOR_*_SUFFIX`、`ORCHESTRATOR_NOTIFICATION_SUFFIXES`、`ORCHESTRATOR_SUBSCRIPTION_ID_MARKER`、`liveUrlFromNotificationId`、`formatNumber`、`truncateDanmu`、`notificationTitlePrefix` 一并删除。

**三、房间身份注入，不引用全局、不复制拼拆键。** `build` 要把种类与房间复合键拼成 ID，`parse` 要把 ID 还原成 `{ platform, roomId }`，文案还要平台标签与观众数指标——这些知识的唯一来源是「房间标识」module，而 ADR-0005 不许复制复合键格式与平台事实。故 `lib/notifications.js` 做成注入 `identity` 的工厂（`createNotifications({ identity })`，与房间库注入 identity 同一套做法），零 `import`、加载位置不受约束、单测直接注入真实 `RoomIdentity`（harness 已经这么做了）。不选「引用全局 `RoomIdentity`」：那会把加载顺序重新变成隐性契约（ADR-0005 明确否决过）。

**四、总开关语义只声明、不改行为。** `settings.notificationsEnabled` 名为全局、实际只管开播与订阅，是既有事实（ADR-0006 明确看点归自己的开关、ADR-0016 明确订阅只受它控制），本次不重命名、不统一到它、也不新增开关——那都是用户可感知的行为 / 配置面变化，超出「收拢通知外形」的范围。改为让登记表显式声明每类的总开关名，并配一条表驱动交叉校验测试：把声明的键置 `false`，断言对应规则 module 的 `isXxxEnabled` 也返回 `false`（检测 / 观众数 / 激增 / 看点四类），使「哪类通知受哪个开关管」从测试断言里的隐知识变成可查、可钉的事实。编排现有的两处总开关判断点（开播 `refreshRooms`、订阅 `handleSubscriptionReminder`）改走 `isMasterSwitchOn`。

**五、文案与格式化随之一并搬入，订阅文案从 `subscription-alert` 迁走。** `formatNumber`（编排 :115-120）与 `truncateDanmu`（:109-112）只被通知文案使用，随文案进 module；`[平台]` 前缀由 builder 统一拼，`lib/subscription-alert.js` 里重复的那句 `[${label}]` 消失。订阅通知的 `buildSubscriptionNotification` 从 `lib/subscription-alert.js` 搬进 module（订阅判定 `decideSubscriptions` 与宽限期留在原地）；`subscriptionDisplayName` **留下**——popup 与设置页都用它渲染订阅行，它不是通知专有。`lib/subscription-alert.js` 因此收窄成一个纯订阅判定 module。popup.js 自己那份 `formatNumber`（:384，签名也不同，多一个 `decimals` 参数）本次不动，避免把改动扩到页面层。

**六、非房间通知不纳入。** 渠道降级提示（ID 字面量 `bili_bridge_fallback`）无房间身份、无总开关、自定义 `priority` / `buttons`，是通道的运维通知，不是任何一种「通知种类」，保持原样、不进登记表；登记表因此只有单一形状。

## Considered Options

- **只把 ID 体系搬进 module，文案与门控留在编排**：改动最小、风险最低；但文案分裂与「门控不可见」两处摩擦原样保留，等于只做了一半。
- **连六个 notify 函数一起搬进 module**：通知编排彻底集中；但 module 要注入 store / notifier / 时钟、不再纯计算，与 ADR-0005 的纯 module 路线相悖，且难单测。
- **统一到 `notificationsEnabled` / 重命名总开关**：名实相符；但前者改变用户可感知行为、与 ADR-0006 / ADR-0016 相悖，后者要动设置 UI、存储键迁移与文档，范围膨胀。故只声明、不改行为。
- **调用方传复合键与平台标签（不注入 identity）**：module 保持冻结纯对象，与 `subscription-alert` 收 `platformLabel` 同一形态；但 `parse` 只能返回 `{ kind, key }`、拆键仍推给编排，与「解析返回结构化房间身份」差一点，`facts` 形状也多三个字段。
- **`parse` 直接返回直播间 URL**：与旧 `liveUrlFromNotificationId` 同形、改动最小；但把「ID 方案」与「URL 知识」继续耦在一处，且丢掉「这是哪类通知」。
- **把渠道降级提示纳入登记表**：统一出口；但给表引入无 ref、无门控、自定义后端参数的异类。
- **导出登记表**：测试与消费方最方便；但把表的字段名变成公开接口，日后改字段即破坏性变更。故表私有、只导出查询 + `KIND_IDS`。

## Consequences

- 新增 `lib/notifications.js`（注入 identity 的零依赖工厂）；加入 `background.js` 的 `importScripts` 与 `test/service-worker-entry.test.cjs` 的 `LIB_FILES`。它不被 popup / 设置页加载（页面不需要它）。
- `createOrchestrator` 依赖列表新增 `notifications` 槽，组合根 `background.js` 建实例注入；`store` / `clients` / `apis` / `bridge` 等不变。
- `lib/orchestrator.js` 删除前缀 / 标记 / 后缀表常量、`liveUrlFromNotificationId`、`formatNumber`、`truncateDanmu`、`notificationTitlePrefix`；六个 notify 函数变薄；`onNotificationClicked` 改为 `parse` + `identity.liveUrl`，未知 ID（含渠道降级提示）解析为 `null`、点击无操作。
- `lib/subscription-alert.js` 移除 `buildSubscriptionNotification`（`subscriptionDisplayName` 与 `decideSubscriptions` 留下）；`test/subscription-alert.test.cjs` 的文案用例迁到新 module 的测试。
- 新增 `test/notifications.test.cjs`：ID 构造 / 解析 round-trip（含 `_sub_<id>` 变长后缀、无后缀的开播、未知 ID 返回 `null`）、登记表总开关交叉校验、六类文案表驱动。现有 flow 测试一字不改，继续作为端到端回归（ID 与文案断言保留，形成单元 + 端到端两处契约）。
- 行为零变化：各总开关对各类通知的作用、通知 ID 字符串、标题 / 正文 / 上下文行文案均与今日一致；仅渠道降级提示沿用原路径。
- CONTEXT.md 新增「通知种类」「通知 module」两个词条（与本 ADR 同步落地）。
