# 纯规则 module 保持零依赖，判定所需的常量自带而不引用共享词汇

整理平台事实（「房间标识」，见 CONTEXT.md）时，第一次正面撞上一条一直只写在注释里的立场：`lib/danmaku-watch.js`、`lib/viewer-alert.js`、`lib/danmaku-surge.js` 三个纯规则 module 不引用任何其他 lib，甚至为此各自持有取值范围——`lib/danmaku-surge.js` 的 `SURGE_LIMITS` 与 `lib/room-store.js` 的 `ROOM_STORE_SURGE_LIMITS` 是同一张表的两份，房间库那句注释写明了理由：「本文件不依赖其他 lib 的加载顺序，故范围在此各自持有」。而平台标签、观众数指标文案、存储字段、平台观众数开关、直播间 URL 这一批事实要被收进一个共享词汇 module（`lib/room-identity.js`），其中一部分正被纯规则 module 使用。

结论是**按「谁在用」分开对待**，而不是按「像不像平台事实」：

- 被本 module 的判定逻辑实际使用的常量留在本行。`WATCH_PLATFORMS` 被 `selectWatchPlan` 用来过滤没有弹幕通道的平台，它是这个判定口径的一部分，跟着判定走才能在单测里单独 require 驱动。
- 只是停放在本行的平台事实搬进共享词汇。`VIEWER_METRICS` 在 `lib/viewer-alert.js` 里没有任何函数读它——真正的消费方是编排的通知文案与设置页、弹窗的指标文案——它躺在一个不使用它的 module 里，只会在词汇 module 出现后变成第二份字符串。

代价认下来：新增一个平台时，判定类常量仍要在多处各自补一行，这是本决策的固有代价，不是疏漏。

## Considered Options

- **判定所需常量自带、停放的平台事实搬走（选用）**：纯规则 module 保持零依赖、加载位置不受影响；共享词汇只承载被搬运的事实。今天没有任何纯规则 module 需要引用词汇 module。
- **纯规则 module 直接引用共享词汇的全局（否决）**：SW 里 `importScripts` 让所有 lib 都是全局，写起来最省事；但这会推翻「本模块自带、不依赖加载顺序」的意图——单测从「require 一个文件」变成「先往 `globalThis` 挂好词汇」，纯函数不再能独立驱动，且加载顺序重新变成一个隐性契约。
- **全部经构造入参与函数入参注入（否决）**：依赖方向最干净、测试最可控；但 `selectWatchPlan(rooms, onlineKeys, { limit, watchEnabled, surgeEnabled })` 这类纯函数的参数会继续变宽，「这个平台有没有弹幕通道」从一个常量变成每个调用点都要传的事实，而 seam 处只有一个 adapter——没有一个真实的替换需求。

## Consequences

- 判据落到两处具体结果：`WATCH_PLATFORMS` 留在 `lib/danmaku-watch.js`；`VIEWER_METRICS` 从 `lib/viewer-alert.js` 搬进房间标识 module，`lib/viewer-alert.js` 的导出与装配根（`background.js`）的 `rules` 包相应收窄一项。
- 平台事实从散在五个 module 的十余处收到三处：房间标识 module（标签 / 指标名 / 字段 / 开关键 / 直播间 URL / 复合键）、`lib/danmaku-watch.js` 的 `WATCH_PLATFORMS`、以及各判定 module 自带的取值范围表。
- 复合键的字符串格式（`platform_roomId`）仍出现在 `selectWatchPlan` 里的一行拼接：那里的 key 是匹配调用方 `onlineKeys` 的局部手段，不为它去改一个被二十多个测试穿透的纯函数返回形状。格式冻结，由房间标识 module 的测试钉住。
- 共享词汇 module（`lib/room-identity.js`）零依赖，因此加载位置必须排在被依赖者之前：`background.js` 的 `importScripts` 首位、设置页与弹窗的 `<script>` 顺序同向、`test/service-worker-entry.test.cjs` 的 `LIB_FILES` 同序。
- 「两处字符串一样就合并」在这里不成立：不能因为判定常量与词汇表的值相同就把常量也搬走，那会重新引入加载顺序依赖。这是本决策最容易被当成冗余而绕开的地方（与 ADR-0003 末尾那条同一性质）。
