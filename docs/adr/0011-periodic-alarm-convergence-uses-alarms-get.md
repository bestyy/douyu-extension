# 周期 alarm 的收敛以 `chrome.alarms.get` 的存在性为准，不用 SW 内存里的布尔标志

看点（`highlightPoll`，5 分钟）、今日统计（`todayStatsPoll`，5 分钟）与弹幕激增结算（`danmakuSurgeTick`，1 分钟）各自是一条周期 `chrome.alarms` 任务。承载它们的 alarm 只在需要时存在、不再需要即清除，这条「收敛」原先靠编排实例内存里的一对布尔标志（`highlightAlarmOn` / `todayStatsAlarmOn` / `surgeAlarmOn`）判断「是否已在跑」。这个判断在 MV3 下是错的。

MV3 的 service worker 会被反复回收重启，`background.js` 顶层的 `orchestrator.start()` 每次冷启动都重跑，内存布尔标志因此归零。于是每次重启后 `sync*` 都会认为「alarm 不在」，再 `create` 一次同名 alarm——而 Chrome 对同名 `create` 的语义是**清除旧的、用新的替换**，即**重置计时**。开播状态轮询默认 60 秒一轮（`Math.max(1, floor(60/60)) = 1` 分钟），基本每分钟就唤醒一次 SW、把 5 分钟的取数计时重新拨到「5 分钟后」，使它永远等不到触发。表现就是今日统计与看点「十几分钟不更新」，而代码里明明写着每 5 分钟一轮。

判据改为查 `chrome.alarms.get(name)`：`get` 到的存在与否直接就是「要不要建」的答案，因此收敛天然幂等——已在跑就不碰它，计时不被打回原点。三处由 `ensurePeriodicAlarm` / `clearPeriodicAlarm` 两个助手统一承担（`lib/orchestrator.js`），端口在 `alarms: { create, clear, get }` 上补一个 `get`。`ensurePeriodicAlarm` 只在「不存在」或「周期与期望不一致」（`refreshInterval` 刚被改）时才 `create`——后者的重置计时正是期望行为。

存活边界要分清，这是本条 ADR 与「alarms.get 天然幂等」之间最容易被误读的地方：**SW 被回收重启不影响 alarm**（alarm 由浏览器持有，独立于 SW 实例），这正是 `get` 判据成立的前提；但**浏览器整个重启**后，Chrome 只「大致」保证 alarm 还在（Chrome 官方措辞是 generally persist but not guaranteed，MDN 上 Firefox 干脆「不跨浏览器会话保留」）。因此不能假设一次 `onInstalled` 建的 alarm 永远在。原先这两个**基础** alarm（`refreshRooms` / `sampleViewerCounts`）只在 `onInstalled` 里建、没有任何 `onStartup` 路径——装完扩展后浏览器重启一次，开播状态轮询就会永久停摆。更正：两个基础 alarm 与三个条件 alarm 走同一收敛（`syncBaseAlarms`），纳入 `start()`（每次 SW 启动都收敛，幂等安全），并在入口补挂 `chrome.runtime.onStartup` → `orchestrator.onStartup()`。

这不是「内存缓存优化」的取舍，而是一个正确性缺陷：靠内存标志去描述一个存活期长于本实例的外部资源，重启后必然误判。同理，凡是要对**跨 SW 实例存活的外部状态**做幂等收敛，判据都必须落在那个外部状态本身，而不是本实例的内存镜像；而**跨浏览器会话**是否存活则由平台决定，不能假定，必须有一条启动时的重建路径兜底。

## Considered Options

- **以 `alarms.get` 的存在性为准（选用）**：判据即真值、重启后天然幂等；代价是每轮多一次 `alarms.get` 异步查询（`create` / `clear` 本就异步，且这发生在轮询里，开销可忽略），以及测试 harness 的假 alarm 端口要补 `get` 并跨实例保留注册表才能测出这条。
- **保留内存布尔标志**（否决）：省一次查询；但它描述的是一份比本实例活得久的状态，SW 每次重启都会误判并重置计时，正是本 ADR 要修的 bug。
- **把标志持久化到 `chrome.storage`**（否决）：能跨重启存活，但要引入一份与 alarm 自身重复的状态，且两者会不一致（alarm 可能被浏览器清除而存储里仍记为「在」）。判据应当唯一来自 alarm 本身。
- **每次冷启动无条件 `create`**（否决）：写法最短，但 `create` 会重置计时，等价于把周期任务的节拍无限往后推。

## Consequences

- `lib/orchestrator.js` 删掉三个 `*AlarmOn` 内存标志，新增 `ensurePeriodicAlarm(name, periodInMinutes)` / `clearPeriodicAlarm(name)`；`syncHighlightAlert`、`syncTodayStats` 与 `syncDanmakuWatch` 的结算 alarm 段改用它们。`createAlarm` 改名 `syncBaseAlarms` 并改走同一收敛，纳入 `start()`；`onInstalled` 与 `PATCH_SETTINGS` 也调它。
- 新增生命周期入口 `orchestrator.onStartup()`（等同 `start()`），`background.js` 挂上 `chrome.runtime.onStartup`：浏览器整个启动时把可能被清掉的基础 alarm 补回来。
- `alarms` port 的形状从 `{ create, clear }` 变为 `{ create, clear, get }`；`background.js` 直接把 `chrome.alarms` 整体注入即可（三个方法都在），测试的两个假端口（`test/support/harness.cjs`、`test/service-worker-entry.test.cjs` 的 `createChromeStub`）需补 `get`。
- 测试 harness 的假 alarm 由「只 append 一个日志数组」改为「日志 + 一份 `Map` 活状态」：`get` 查 Map（形状对齐真实的 `chrome.alarms.Alarm`，`periodInMinutes` 在顶层）、`clear` 从 Map 删除。并新增 `harness.restart()`——换一个全新的编排实例但共享存储与 alarm 注册表，用来模拟 SW 重启。周期 alarm 各有一条「重启不重建、周期变了才重建」的回归测试，去掉修复即失败。
- 既有三条 ADR 里「照 `danmakuSurgeTick` / `syncHighlightAlert` 的收敛法」的措辞仍然成立（都是「只在需要时存在」的同一套收敛），只是收敛的**判据**由本条 ADR 更正为 `alarms.get`；不回改那几条 ADR，它们记录的是当时的设计。
