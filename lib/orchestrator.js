// lib/orchestrator.js — 直播状态编排：轮询 / 观众数采样 / 弹幕盯守 / 看点轮询 / 订阅 / 六类通知
//
// 依赖全部注入，chrome 只在入口（background.js）出现一次：
//   store     房间库（lib/room-store.js）：五个键的形状与全部变更，见 ADR-0003
//   keyValue  单键键值 port：编排自己的键（notifiedRooms / _firstRun / lastRefresh / watchQueued /
//             highlightWatermarks 看点水位 / popupCategoryId 弹窗分类栏选中项）。
//             配置导入时 ORCHESTRATOR_RUNTIME_KEYS 里除 notifiedRooms 外的这些键会被清空（见 ADR-0012）；
//             biliPageChannelEnabled 归桥接通道所有，不由编排清。
//   apis      { douyu: { batchFetchRoomInfo, resolveNickname, fetchHighlights }, bilibili: {...} } 平台 API
//   clients   { douyuSample, douyuWatch, bilibiliSample, bilibiliWatch } 弹幕客户端
//   bridge    BiliBridgeChannel（B站页面桥接通道）
//   notifier  { create(notificationId, content) -> Promise<boolean>, setBadge(count) }
//   rules     纯规则：lib/viewer-alert.js + lib/danmaku-watch.js + lib/danmaku-surge.js +
//             lib/highlight-alert.js + lib/subscription-alert.js 的导出
//   identity  房间标识 module（lib/room-identity.js）：复合键 / 直播间 URL / 平台标签与观众数指标
//   notifications 通知 module（lib/notifications.js）：六类通知的 ID 与文案（通知外形全在它内部）
//   alarms    { create(name, info), clear(name), get(name) -> Promise<Alarm|undefined> }
//             get 查的是跨 SW 重启存活的那份真值，是周期 alarm 幂等收敛的依据（见 ensurePeriodicAlarm）
//   tabs      { create({ url }) }（通知点击进入直播间）
//   now       可选，返回当前绝对时刻毫秒数，默认 Date.now；订阅的到点裁决与 alarm 排期用它（测试注入可控时钟）
//
// 事件注册留在入口；名字/消息到域操作的映射在这里（onAlarm / onMessage），因而可测。
// 阈值判定（观众数提醒）、命中判定（弹幕检测）、激增裁决（弹幕激增）、「什么算新看点」（看点通知）、
// 「订阅该不该发 / 错过宽限期」（订阅提醒）留在五个纯规则 module；本 module 只负责「什么时候问、拿到结果做什么」。
// 「通知长什么样、ID 是什么」全在通知 module（lib/notifications.js，见 CONTEXT.md「通知种类」/「通知 module」）：
// 六个 notify 函数只做取值与发送，ID 的构造与解析、标题 / 正文 / 上下文行都交给它。
// UMD 双兼容：SW 经 importScripts 加载，node 下可 require。

const ORCHESTRATOR_REFRESH_ALARM = 'refreshRooms';
const ORCHESTRATOR_SAMPLE_ALARM = 'sampleViewerCounts';
const ORCHESTRATOR_SURGE_ALARM = 'danmakuSurgeTick'; // 弹幕激增的结算节拍（1 分钟 = 桶宽）
const ORCHESTRATOR_HIGHLIGHT_ALARM = 'highlightPoll'; // 看点取数的节拍（5 分钟一轮）
const ORCHESTRATOR_SUBSCRIPTION_ALARM = 'subscriptionReminder'; // 订阅的一次性 alarm（排在最早一条待触发订阅的 at）
const ORCHESTRATOR_VIEWER_SAMPLE_INTERVAL = 10; // 观众数采样间隔（分钟），与 sampleViewerCounts alarm 周期一致
const ORCHESTRATOR_HIGHLIGHT_INTERVAL = 5; // 看点取数间隔（分钟）：平台自己的发布节奏就是节流阀，见 ADR-0006
// 配置导入时要清空的运行时键（见 ADR-0012）：它们记的是「本机观察到什么」——看点水位、
// 盯守排队、弹窗分类栏选中项、首启标记、上次刷新时刻。换配置后都不再成立，整份清掉由新配置在新机器上
// 重新积累。这些键都属编排（见文件头的键归属声明），故由编排清。
// `biliPageChannelEnabled` 不在此列：它是桥接通道的降级标记（归 bili-bridge-channel），
// 且 syncViewerSettings 会立刻按最新配置重写它，清掉只会白丢一次「未登录时被风控降级过」的记忆。
const ORCHESTRATOR_RUNTIME_KEYS = [
  'highlightWatermarks',
  'watchQueued',
  'popupCategoryId',
  '_firstRun',
  'lastRefresh'
];

// 已退役的存储键：随「今日统计」功能一起下线（数据源 doseeing 已于 2026-09-30 停止服务，
// 见 ADR-0013）。onInstalled 在升级时清一次，避免旧记录永远留在用户存储里。
const ORCHESTRATOR_RETIRED_KEYS = [
  'todayStats'
];

function createOrchestrator({ store, keyValue, apis, clients, bridge, notifier, rules, identity, notifications, alarms, tabs, now }) {
  const nowMs = typeof now === 'function' ? now : () => Date.now();
  // 内存态（与盯守长连接同生命周期，SW 被回收即丢，start() 时按存储中的快照重建）
  const watchCounter = new rules.DanmakuWatchCounter();
  const surgeMeter = new rules.SurgeMeter(); // 弹幕激增的分钟桶（同样只在内存里）
  const watchedConfigs = new Map(); // 房间复合键 -> { key, platform, roomId, nickname, config, surge }（每轮轮询重建）
  let watchedKeys = new Set();      // 上一轮盯守的房间复合键（用于识别下播/停用边沿）
  let surgeKeys = new Set();        // 上一轮「开了激增且在盯守」的房间（用于识别停用激增边沿）
  let watchReady = null;            // start() 的重建 Promise：弹幕入口先等它，避免首批弹幕被丢弃

  // === 周期 alarm 的收敛（看点 / 激增两处共用）===

  /**
   * 确保一个周期 alarm 存在且**不重置它已在跑的计时**。以 `alarms.get` 查到的存在性为准，而不是本
   * 实例的内存布尔量：MV3 的 SW 会被反复回收重启，内存标志活不过重启，靠它判断就会在每次冷启动后
   * 再 create 一次同名 alarm——而 Chrome 对同名 create 的语义是「清除旧的、用新的替换」，即**重置计时**。
   * 开播轮询默认 1 分钟就唤醒一次 SW，于是每次重启都把 5 分钟的取数节拍往后拨，永远等不到触发（这就是
   * 「一个房 10 多分钟没更新」的成因）。alarms.get 查的是活在 SW 实例之外的那份真值，因此这里天然幂等；
   * 只有「不存在」或「周期与期望不一致」（refreshInterval 刚被改）才 create，后者重置计时正是期望行为。
   * 存活边界要分清：SW 被回收重启不影响 alarm（这正是本判据依赖的），但**浏览器整个重启**后 Chrome
   * 只「大致」保证 alarm 还在（MDN 上 Firefox 干脆不跨会话保留，Chrome 官方也建议在 SW 启动时按需重建）。
   * 所以 start() 每次都把基础 alarm 也收敛一遍，入口再挂 onStartup 唤醒——重启后不会永久停摆。
   * @param {string} name alarm 名
   * @param {number} periodInMinutes 周期（分钟）
   */
  async function ensurePeriodicAlarm(name, periodInMinutes) {
    const existing = await alarms.get(name);
    if (existing && existing.periodInMinutes === periodInMinutes) {
      return; // 已在跑且周期一致：不碰它（create 会重置计时）
    }
    alarms.create(name, { periodInMinutes }); // 不存在、或周期被改：建 / 重建
  }

  /** 清掉不再需要的周期 alarm：只在它真的存在时才 clear（与 ensurePeriodicAlarm 同一存在性口径） */
  async function clearPeriodicAlarm(name) {
    if (await alarms.get(name)) {
      alarms.clear(name);
    }
  }

  // === 通知 ===

  /**
   * 房间通知的统一创建入口：六种通知外形一致，只有 ID、标题与正文不同（外形由通知 module 构造）。
   * 同 ID 重复触发即覆盖，不堆积。
   */
  async function createRoomNotification(notificationId, { title, message, contextMessage }) {
    try {
      return await notifier.create(notificationId, { title, message, contextMessage });
    } catch (e) {
      console.error('通知创建失败:', notificationId, e);
      return false;
    }
  }

  /**
   * 通知点击/按钮点击 → 打开直播间：ID 的种类与房间身份由通知 module 解析，未知 ID 与非房间通知
   * （如渠道降级提示）解析为 null，静默无操作、不跳错误页面。
   */
  async function onNotificationClicked(notificationId) {
    const parsed = notifications.parse(notificationId);
    if (!parsed) {
      return;
    }
    const url = identity.liveUrl(parsed);
    if (url) {
      await tabs.create({ url });
    }
  }

  // === 定时器 ===

  /**
   * 两个基础 alarm 的收敛点（onInstalled / 浏览器启动 / 设置变更都经过）：开播状态轮询按设置间隔、
   * 观众数采样固定 10 分钟。与三个条件 alarm 同一存在性口径（见 ensurePeriodicAlarm）——alarm 活在
   * SW 实例之外，SW 反复回收重启不该重建它；只有浏览器整个重启把 alarm 清掉、或 refreshInterval 被改
   * 时才 create。因此可安全地在每次 SW 启动时调用，不会把已在跑的计时打回原点。
   */
  async function syncBaseAlarms() {
    const snapshot = await store.snapshot();
    const interval = snapshot.settings.refreshInterval || 60;
    await ensurePeriodicAlarm(ORCHESTRATOR_REFRESH_ALARM, Math.max(1, Math.floor(interval / 60)));
    // 观众数采样 alarm：10 分钟短连一次，平时不保持 WS 连接
    await ensurePeriodicAlarm(ORCHESTRATOR_SAMPLE_ALARM, ORCHESTRATOR_VIEWER_SAMPLE_INTERVAL);
  }

  /**
   * 按当前存储把运行时状态收敛到位：基础 alarm + 观众数/B站通道 + 检测盯守 + 看点取数 + 订阅。
   * 这是「设置变更」「SW 唤醒」「配置导入」三处的同一条序列——都要求拿最新配置把内存态与 alarm 重建，
   * 抽此一处以免新增一个收敛项时三处各改一遍。
   */
  async function convergeRuntime() {
    await syncBaseAlarms();
    await syncViewerSettings();
    await syncDanmakuWatch();
    await syncHighlightAlert();
    await syncSubscriptionAlarm();
  }

  // === 观众数定时采样 ===
  // 每 10 分钟短连一次：斗鱼单连接订阅全部房间，B站每房间一条连接（登录态走页面桥接），
  // 拿到数据立即断开，平时零 WS 连接（由 chrome.alarms 驱动，SW 休眠后自动恢复）。
  async function sampleViewerCounts() {
    const plan = await store.viewerSamplePlan();
    if (plan.douyu.roomIds.length > 0 && plan.douyu.enabled) {
      clients.douyuSample.sample(plan.douyu.roomIds);
    }
    if (plan.bilibili.roomIds.length > 0 && plan.bilibili.enabled) {
      if (bridge.enabled) {
        // 页面通道（登录态主通道/降级后备）：临时开页 → 长连接采样 → 桥接页发
        // BILI_SAMPLE_DONE 后由 SW 关闭页面（不在此长时间等待，避免等待期间 SW 空闲被终止）
        await bridge.sample(plan.bilibili.roomIds);
      } else {
        // SW 直连主通道（未登录）：每个房间一条短连，收到高能榜在线数即断开
        clients.bilibiliSample.sample(plan.bilibili.roomIds);
      }
    }
  }

  async function syncViewerSettings() {
    const snapshot = await store.snapshot();
    // 盯守需求并入 B站通道决策：检测与激增任一存在就需要 B站弹幕通道（只开激增、未配检测词的
    // B站房间也要备好通道）；对应总开关关闭时该需求不算（不再为盯守常驻桥接页）
    const facts = await store.reconcileViewerGates();
    await bridge.sync({
      watchNeed: rules.hasBiliWatchNeed(snapshot.rooms, {
        watchEnabled: rules.isDanmakuWatchEnabled(snapshot.settings),
        surgeEnabled: rules.isSurgeAlertEnabled(snapshot.settings)
      }),
      viewerEnabled: facts.viewerFetch.bilibili,
      hasBiliRoom: facts.hasPlatform.bilibili
    });
  }

  // === 值到达 → 观众数写入 + 观众数提醒判定（判定点在值到达处，见 ADR-0002）===

  /**
   * @param {'douyu'|'bilibili'} platform
   * @param {{roomId: string, value: number}} data 弹幕推送里的观众数（斗鱼贵宾数 / B站高能榜在线数）
   * @returns {Promise<boolean>} 是否发了提醒
   */
  async function onViewerCount(platform, { roomId, value }) {
    const result = await store.recordViewerCount({ platform, roomId, value });
    if (!result.changed) {
      if (!result.matched && platform === 'bilibili') {
        console.warn(`[bili] 观众数到达但未找到房间 roomId=${roomId} value=${value}`);
      }
      return false;
    }
    return await evaluateViewerAlert(platform, result);
  }

  /**
   * 观众数提醒：整条判定链（全局总开关 → 该房 viewerAlert 配置 → 上升边沿）在纯裁决
   * `rules.decideViewerAlert` 里，本处只负责「什么时候问、拿到结果做什么」。
   * 该平台观众数开关已在写入处（房间库）把关：关闭时不写、判定端看不到它（见 ADR-0002）。
   */
  async function evaluateViewerAlert(platform, result) {
    const decision = rules.decideViewerAlert({
      settings: result.settings,
      roomConfig: result.room && result.room.viewerAlert,
      prevValue: result.prevValue,
      nextValue: result.nextValue
    });
    if (!decision.notify) {
      return false;
    }
    await notifyViewerAlert(
      platform,
      { roomId: result.roomId, nickname: (result.room && result.room.nickname) || '' },
      result.nextValue,
      decision.threshold,
      result.streamer
    );
    return true;
  }

  /**
   * 观众数提醒通知：ID 与文案由通知 module 按 `viewer` 种类构造（同房重复触发复用同一 ID → 覆盖不堆积）。
   * 不受开播通知总开关影响：只受自己的总开关与该平台观众数开关约束。
   */
  async function notifyViewerAlert(platform, { roomId, nickname }, value, threshold, streamer) {
    const { id, content } = notifications.build('viewer', {
      platform,
      roomId,
      nickname,
      value,
      threshold,
      streamerTitle: streamer && streamer.title
    });
    await createRoomNotification(id, content);
  }

  // === B站页面通道降级（SW 直连被风控时）===
  // SW 直连为主通道（未登录），若本轮采样全败且快速断开 → onFallback 切换为页面通道：
  // content script 在 live.bilibili.com 页面上下文建连，通过 chrome.runtime 消息回传高能榜在线数。

  async function handleBiliChannelFallback() {
    const plan = await store.viewerSamplePlan();
    // 模块内职责：置内存标记 + 持久化 + 日志（开关关闭/已启用时内部跳过）
    await bridge.enableFallback({ viewerEnabled: plan.bilibili.enabled });
    // 停止 SW 直连采样，避免继续触发风控（destroy 只断开连接，不触发降级判定）
    clients.bilibiliSample.destroy();
    try {
      await notifier.create('bili_bridge_fallback', {
        title: 'B站高能榜连接已切换通道',
        message: '当前浏览器拦截了扩展直连，已切换为页面通道。每次采样时会自动临时打开一个B站标签页，获取后自动关闭。',
        priority: 1,
        buttons: []
      });
    } catch (e) {
      // 通知失败不影响功能
    }
  }

  // === 弹幕盯守（开播门控长连接，见 ADR-0001）===
  // 同一条长连接供给两个功能（见 ADR-0004）：检测词命中在滑动窗口内达到阈值 → 发一条检测通知
  // （派生 ID，按房间覆盖）→ 进冷却；弹幕条数按分钟计入激增的桶，跨桶结算时裁决是否发激增通知。
  // 计数、桶与冷却都是内存态（与长连接同生命周期）：下播断开即清空，SW 重启归零。

  /**
   * 弹幕盯守的轮询收敛点（写回开播快照之后调用，添加/移除房间同样经此入口）：
   * - 按房间列表顺序取前 5 个「有盯守需求（检测或激增）且开播」的房间为盯守对象，其余在线房间排队
   * - 连接按盯守集合幂等收敛：开播建长连接、下播断开（SW 被回收后同样由这里重连）
   * - 下播/停用边沿清空该房计数与桶；结算 alarm 按有无激增盯守房间收敛
   */
  async function syncDanmakuWatch() {
    const snapshot = await store.snapshot();
    const onlineKeys = new Set(
      snapshot.streamers.filter(s => s.online).map(s => identity.roomKey(s))
    );
    // 两个总开关互不牵连：检测关只停检测、激增关只停激增，连接为另一个需求保留
    const plan = rules.selectWatchPlan(snapshot.rooms, onlineKeys, {
      watchEnabled: rules.isDanmakuWatchEnabled(snapshot.settings),
      surgeEnabled: rules.isSurgeAlertEnabled(snapshot.settings)
    });

    // 下播/停用边沿：清空计数与冷却（下一场重新计数，冷却 0 的锁定同时解除）
    const nextKeys = new Set(plan.active.map(e => e.key));
    for (const key of watchedKeys) {
      if (!nextKeys.has(key)) {
        watchCounter.reset(key);
      }
    }
    // 激增边沿：下播、或仍盯检测但关掉了该房激增 → 清空该房的桶与冷却（下一场重新积累基线）
    const nextSurgeKeys = new Set(plan.active.filter(e => e.surge).map(e => e.key));
    for (const key of surgeKeys) {
      if (!nextSurgeKeys.has(key)) {
        surgeMeter.reset(key);
      }
    }
    const hadBiliWatch = [...watchedConfigs.values()].some(e => e.platform === 'bilibili');
    watchedKeys = nextKeys;
    surgeKeys = nextSurgeKeys;
    watchedConfigs.clear();
    for (const entry of plan.active) {
      watchedConfigs.set(entry.key, entry);
    }

    // 结算 alarm：只在「有打开激增的盯守房间」时存在（没有就清掉，不给 SW 留无用唤醒）；
    // 存在性以 alarms.get 为准，已在跑不重建——create 会重置计时，每轮（含 SW 每次冷启动）重建
    // 都会把结算一直往后推（见 ensurePeriodicAlarm）
    if (nextSurgeKeys.size > 0) {
      await ensurePeriodicAlarm(ORCHESTRATOR_SURGE_ALARM, 1); // 1 分钟 = 桶宽，不受轮询间隔影响
    } else {
      await clearPeriodicAlarm(ORCHESTRATOR_SURGE_ALARM);
    }

    // 斗鱼：检测长连接独立实例（与采样短连并存，属有意设计）
    clients.douyuWatch.setRooms(plan.active.filter(e => e.platform === 'douyu').map(e => e.roomId));

    // B站：通道决策沿用观众数封装（登录态页面桥接 / 未登录 SW 直连）
    const biliIds = plan.active.filter(e => e.platform === 'bilibili').map(e => e.roomId);
    if (bridge.enabled) {
      // 全量下发（含空列表）：桥接页按最新列表收敛，SW 重启后内存态丢失也能清掉残留连接
      await bridge.watch(biliIds);
      if (biliIds.length === 0 && hadBiliWatch) {
        await bridge.close(); // 本 SW 生命周期内的盯守结束：释放常驻桥接页（采样会按需再开）
      }
      clients.bilibiliWatch.setRooms([]); // 页面通道启用时不留 SW 直连检测连接
    } else {
      clients.bilibiliWatch.setRooms(biliIds);
    }

    await syncWatchQueue(plan.queued);
    // 兜底结算一次：alarm 节拍之外（SW 刚唤醒、轮询正好跨桶）也不漏；结算幂等，冷却挡住重复触发
    await settleDanmakuSurge();
  }

  /**
   * 弹幕激增的结算：对每个打开激增的盯守房间结算刚归档的那一桶（跨桶才裁决）。
   * 触发时按房间复合键 + _surge 后缀发通知（同 ID 覆盖不堆积）；只受激增自己的总开关约束，
   * 不受开播通知总开关影响（沿用观众数提醒的惯例）。
   */
  async function settleDanmakuSurge() {
    if (surgeKeys.size === 0) {
      return;
    }
    const snapshot = await store.snapshot();
    if (!rules.isSurgeAlertEnabled(snapshot.settings)) {
      return; // 总开关刚被关掉（与设置变更交错）：这一次不判定
    }
    const config = rules.normalizeSurgeSettings(snapshot.settings);
    const now = surgeMeter.now(); // 同批房间共用同一时刻
    for (const key of surgeKeys) {
      const entry = watchedConfigs.get(key);
      if (!entry) {
        continue;
      }
      const { triggered, bucketCount, baseline, sample } = surgeMeter.tick(key, now, config);
      if (triggered) {
        await notifySurgeAlert(entry, { bucketCount, baseline, sample });
      }
    }
  }

  /**
   * 激增通知：ID 与文案由通知 module 按 `surge` 种类构造（同房反复触发复用同一 ID → 覆盖不堆积）。
   * 触发时现读一次最新快照，房间标题开场后可能变化。
   */
  async function notifySurgeAlert(entry, { bucketCount, baseline, sample }) {
    const snapshot = await store.snapshot();
    const streamer = snapshot.streamers.find(s =>
      s.platform === entry.platform && identity.sameRoomId(s.roomId, entry.roomId)
    );
    const { id, content } = notifications.build('surge', {
      platform: entry.platform,
      roomId: entry.roomId,
      nickname: entry.nickname,
      bucketCount,
      baseline,
      sample,
      streamerTitle: streamer && streamer.title
    });
    await createRoomNotification(id, content);
  }

  /** 排队提示（popup 读取）：超过并发上限暂未盯守的在线房间，仅在变化时写入 */
  async function syncWatchQueue(queued) {
    const next = queued.map(e => ({ roomId: e.roomId, platform: e.platform, nickname: e.nickname }));
    const prev = (await keyValue.get('watchQueued')) || [];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      await keyValue.set('watchQueued', next);
    }
  }

  /** 当前是否有 B站房间在盯守（桥接页盯守长连接常驻期间不得被采样收尾关页） */
  function hasBiliWatch() {
    for (const entry of watchedConfigs.values()) {
      if (entry.platform === 'bilibili') {
        return true;
      }
    }
    return false;
  }

  /**
   * 弹幕文本入口：两个平台的检测长连接与桥接页回传都收敛到这里。
   * 房间在盯守集合内就计入激增条数；配了检测词才走命中计数（两条路互不影响，见 ADR-0004）
   */
  async function handleDanmu(platform, { roomId, text, user }) {
    if (watchReady) {
      await watchReady; // SW 唤醒后先等内存里的盯守配置重建完成
    }
    const key = identity.roomKey({ platform, roomId });
    const entry = watchedConfigs.get(key);
    if (!entry) {
      return false;
    }
    if (entry.surge) {
      // 只为激增盯守的房间（未配检测词）也计数；文本一并留下，供触发时挑一条样本弹幕
      surgeMeter.recordDanmu(key, { text });
    }
    if (!entry.config) {
      return false;
    }
    const keyword = rules.matchKeyword(text, entry.config);
    if (!keyword) {
      return false;
    }
    const { triggered, count } = watchCounter.recordHit(key, entry.config);
    if (!triggered) {
      return false;
    }
    await notifyDanmakuHit(entry, { keyword, text, user, count });
    return true;
  }

  /**
   * 检测通知：ID 与文案由通知 module 按 `watch` 种类构造（同房重复触发复用同一 ID）。
   * 不受开播通知总开关影响：检测有独立的启用开关与检测词配置，开了检测就是要这条通知。
   */
  async function notifyDanmakuHit(entry, { keyword, text, user, count }) {
    const { id, content } = notifications.build('watch', {
      platform: entry.platform,
      roomId: entry.roomId,
      nickname: entry.nickname,
      keyword,
      text,
      user,
      count,
      windowMinutes: entry.config.windowMinutes
    });
    await createRoomNotification(id, content);
  }

  // === 看点通知（每 5 分钟轮询斗鱼看点接口，见 ADR-0006）===
  // 取数与开播状态轮询分开：周期写死 5 分钟、不受「轮询间隔」设置影响（看点由平台事后切出，
  // 通知本来就晚于画面几分钟，压到 1 分钟换不来体感、请求量却是 5 倍）。
  // 「什么算新看点」全在 lib/highlight-alert.js（按每房看点水位判定）；本 module 只管取数、
  // 水位落盘与发通知。水位是编排自己的键（`{ "douyu_9999": 60412 }`，照 notifiedRooms），不进房间库。

  /** 该房是否有看点取数需求：平台门 + 该房开关（是否开播由调用方各自判断） */
  function isHighlightRoom(room) {
    return rules.HIGHLIGHT_PLATFORMS.includes(room.platform) && room.highlightAlert === true;
  }

  /**
   * 看点取数 alarm 的收敛点（房间增删、设置变更与每轮轮询都经过）：只在「总开关开启 且 至少一个
   * 斗鱼房间开了看点」时存在，全关掉即清除（不给 SW 留无用唤醒）；已在跑不重建——create 会重置计时，
   * 每轮重建（含 SW 每次冷启动）会把取数一直往后推（见 ensurePeriodicAlarm）。
   */
  async function syncHighlightAlert() {
    const snapshot = await store.snapshot();
    const wanted = rules.isHighlightAlertEnabled(snapshot.settings) && snapshot.rooms.some(isHighlightRoom);
    if (wanted) {
      await ensurePeriodicAlarm(ORCHESTRATOR_HIGHLIGHT_ALARM, ORCHESTRATOR_HIGHLIGHT_INTERVAL);
    } else {
      await clearPeriodicAlarm(ORCHESTRATOR_HIGHLIGHT_ALARM);
    }
  }

  /**
   * 看点取数与通知：只取「总开关开启 + 该房开了看点 + 当前开播」的斗鱼房间（实测未开播房间的
   * 看点列表为空，因此不请求既省请求也不漏东西），逐房按水位挑出新看点。
   * 接口失败或返回空列表时不写水位（值原地不动），只记日志——一次接口抖动不该吃掉一条看点，
   * 下次成功时仍会通知最新那一条。
   */
  async function pollHighlights() {
    const snapshot = await store.snapshot();
    if (!rules.isHighlightAlertEnabled(snapshot.settings)) {
      return; // 总开关关闭：不请求、不判定（各房开关保留）
    }
    const targets = snapshot.rooms.filter(room => isHighlightRoom(room) && room.online === true);
    if (targets.length === 0) {
      return;
    }

    const watermarks = (await keyValue.get('highlightWatermarks')) || {};
    // 并行取数（fetchHighlights 自带 try/catch，不会抛）：SW 生命周期有限，
    // 逐房串行会把每房的 10 秒超时叠起来
    const fetched = await Promise.all(targets.map(async room => ({
      room,
      // 看点接口只认内部号（见 ADR-0017）：传该房条目的 internalRoomId，尚未补齐时回退房间号
      // （缓存未预热的冷 SW 也不受影响——内部号来自存储而非内存）
      result: await apis[room.platform].fetchHighlights(room.internalRoomId || room.roomId)
    })));

    let changed = false;
    for (const { room, result } of fetched) {
      const key = identity.roomKey(room);
      if (!result || result.success !== true) {
        console.warn(`看点取数失败: ${key}`, (result && result.error) || 'unknown');
        continue;
      }
      const { newest, count, watermark } = rules.selectNewHighlights(
        result.data && result.data.highlights,
        watermarks[key]
      );
      if (watermark !== undefined && watermark !== watermarks[key]) {
        watermarks[key] = watermark;
        changed = true;
      }
      if (newest) {
        await notifyHighlight(room, newest, count);
      }
    }
    if (changed) {
      await keyValue.set('highlightWatermarks', watermarks);
    }
  }

  /**
   * 看点通知：ID 与文案由通知 module 按 `highlight` 种类构造（同房反复触发复用同一 ID，覆盖不堆积）。
   * 只受看点自己的总开关与该房开关约束，不受开播通知总开关影响（沿用观众数提醒的惯例）。
   * 触发时现读一次最新快照，房间标题开场后可能变化。
   */
  async function notifyHighlight(room, highlight, count) {
    const snapshot = await store.snapshot();
    const streamer = snapshot.streamers.find(s =>
      s.platform === room.platform && identity.sameRoomId(s.roomId, room.roomId)
    );
    const { id, content } = notifications.build('highlight', {
      platform: room.platform,
      roomId: room.roomId,
      nickname: room.nickname,
      highlightTitle: highlight.title,
      count,
      streamerTitle: streamer && streamer.title
    });
    await createRoomNotification(id, content);
  }

  /** 清掉某房看点水位（房间移除 / 重新添加）：与 notifiedRooms 的处理挨在同一处 */
  async function clearHighlightWatermark(ref) {
    const watermarks = (await keyValue.get('highlightWatermarks')) || {};
    const key = identity.roomKey(ref);
    if (!(key in watermarks)) {
      return; // 该房没有水位：不必白写一次存储
    }
    delete watermarks[key];
    await keyValue.set('highlightWatermarks', watermarks);
  }

  // === 订阅（用户排定的一次性绝对时刻，见 ADR-0016）===
  // 单个一次性 alarm 承载全部订阅，排在「最早一条待触发订阅的 at」；没有待触发订阅就没有这个 alarm。
  // 「此刻该发哪些」（错过宽限期判定）在 lib/subscription-alert.js；通知 ID 与文案在通知 module；
  // 本 module 只管读快照、发通知、删除、重排。

  /**
   * 订阅 alarm 的收敛点（SW 唤醒 / 安装 / 订阅增删 / 一次触发之后都经过）：从存储重排到最早待触发时刻。
   * 一次性 alarm 与周期 alarm 不同——它记的是绝对时刻，同名 create 用同一个 when 覆盖不产生漂移，
   * 因此每次都从存储重排是安全且必要的（扩展更新会清 alarm，浏览器重启也只被「大致」保证，见
   * ensurePeriodicAlarm 的存活边界说明）。没有待触发订阅时清掉它，不给 SW 留无用唤醒。
   *
   * 有「已到点且仍在宽限期内」的订阅时（SW 休眠 / 浏览器关闭期间错过了触发）排一次立即触发的 alarm，
   * 让触发分支按宽限期补发——这正是不依赖「Chrome 会不会补触发」的兜底（见 ADR-0016 第三条）。
   * 补发不可能无限循环：触发后那些订阅即被删除，下次收敛不再把它们算作到点。
   */
  async function syncSubscriptionAlarm() {
    const snapshot = await store.snapshot();
    const { notify, nextAt } = rules.decideSubscriptions(snapshot.subscriptions, nowMs());
    if (nextAt === undefined && notify.length === 0) {
      if (await alarms.get(ORCHESTRATOR_SUBSCRIPTION_ALARM)) {
        alarms.clear(ORCHESTRATOR_SUBSCRIPTION_ALARM);
      }
      return;
    }
    alarms.create(ORCHESTRATOR_SUBSCRIPTION_ALARM, { when: notify.length > 0 ? nowMs() : nextAt });
  }

  /**
   * 订阅到点：读订阅快照 → 纯裁决分组 → 对「照发」组逐条发通知并删除 → 对「丢弃」组直接删除 →
   * 按剩下的最早 at 重排 alarm。
   * 到点无条件发（像闹钟），开播状态只进正文；全局关闭通知时照样消费掉到点的订阅（否则会永远留在
   * 列表里），只是不弹通知——重新打开后未来的订阅照常提醒。
   */
  async function handleSubscriptionReminder() {
    const snapshot = await store.snapshot();
    const { notify, dropped } = rules.decideSubscriptions(snapshot.subscriptions, nowMs());
    const enabled = notifications.isMasterSwitchOn('subscription', snapshot.settings);

    for (const subscription of notify) {
      if (enabled) {
        await notifySubscription(subscription, snapshot);
      }
      await store.removeSubscription(subscription.id);
    }
    for (const subscription of dropped) {
      await store.removeSubscription(subscription.id); // 错过超过宽限期：安静丢弃
    }

    await syncSubscriptionAlarm();
  }

  /**
   * 订阅通知：ID 为 `<房间复合键>_sub_<订阅 id>`（前缀让点击进直播间，`_sub_<id>` 保证同一房间的多条
   * 订阅各弹各的，不像另五种「按房间复用 ID 覆盖」），文案报触发时的开播状态。两者都由通知 module 按
   * `subscription` 种类构造；开播快照取自主播快照。
   */
  async function notifySubscription(subscription, snapshot) {
    const streamer = snapshot.streamers.find(s =>
      s.platform === subscription.platform && identity.sameRoomId(s.roomId, subscription.roomId)
    );
    const { id, content } = notifications.build('subscription', {
      platform: subscription.platform,
      roomId: subscription.roomId,
      subscriptionId: subscription.id,
      nickname: streamer && streamer.nickname,
      online: !!streamer && streamer.online === true,
      title: streamer && streamer.title
    });
    await createRoomNotification(id, content);
  }

  // === 核心轮询 ===

  async function refreshRooms() {
    const snapshot = await store.snapshot();
    if (snapshot.rooms.length === 0) {
      await syncDanmakuWatch(); // 房间清空 → 断开全部检测连接
      await syncHighlightAlert(); // 房间清空 → 清掉看点取数 alarm
      notifier.setBadge(0); // 房间清空 → 徽标归零（导入空配置后不残留上一份配置的在播数）
      return; // 未配置房间号，跳过
    }
    // 看点取数 alarm 只看房间与开关，与开播状态无关：每轮都收敛一次，开关变更后不留无用唤醒
    await syncHighlightAlert();

    const results = {};
    await Promise.all(identity.PLATFORM_IDS.map(async platform => {
      const ids = snapshot.rooms
        .filter(room => room.platform === platform)
        .map(room => room.roomId);
      results[platform] = ids.length > 0
        ? await apis[platform].batchFetchRoomInfo(ids)
        : { success: true, data: [] };
    }));

    // 合并口径（成功取新、失败留旧、观众数透传、两轮离线清空）在房间库内部
    const merged = await store.mergePollResults({ results });
    if (!merged.changed) {
      await syncDanmakuWatch();
      return;
    }
    await keyValue.set('lastRefresh', Date.now());
    notifier.setBadge(merged.onlineCount);

    // 开播门控：按刚写回的开播快照收敛检测长连接（开播建连、下播断开并清空计数）
    await syncDanmakuWatch();

    const isFirstRun = (await keyValue.get('_firstRun')) === true;
    if (isFirstRun) {
      const onlineEntries = merged.streamers.filter(s => s.online).map(s => ({
        roomId: s.roomId,
        platform: s.platform
      }));
      await keyValue.set('notifiedRooms', onlineEntries);
      await keyValue.set('_firstRun', null);
    } else {
      const settings = (await store.snapshot()).settings;
      if (notifications.isMasterSwitchOn('live', settings)) {
        await checkNewLiveStreams(merged);
      }
    }
  }

  // === 新开播通知 ===

  /**
   * @param {{wentLive: Array, streamers: Array}} merged 房间库的合并结果：
   *        wentLive 是本轮「上一轮非在线 → 在线」的主播快照（开播边沿）
   */
  async function checkNewLiveStreams({ wentLive, streamers }) {
    const rawNotified = (await keyValue.get('notifiedRooms')) || [];
    const notifiedMap = new Set(rawNotified.map(n => identity.roomKey(n)));

    for (const streamer of wentLive) {
      if (streamer.notify !== true) continue; // 跳过用户设置了不通知的房间

      const compositeKey = identity.roomKey(streamer);
      if (notifiedMap.has(compositeKey)) continue;

      // 观众数统计进上下文行：数值字段取自房间标识 module（斗鱼贵宾 / B站高能榜），
      // 指标文案与数字格式化在通知 module 内完成
      const field = identity.viewerField(streamer.platform);
      const { id, content } = notifications.build('live', {
        platform: streamer.platform,
        roomId: streamer.roomId,
        nickname: streamer.nickname,
        title: streamer.title,
        category: streamer.category,
        viewerCount: field ? streamer[field] : undefined
      });
      const created = await createRoomNotification(id, content);
      if (created) {
        notifiedMap.add(compositeKey);
      }
    }

    const onlineKeys = new Set(
      streamers
        .filter(s => s.online && s.notify === true)
        .map(s => identity.roomKey(s))
    );
    await keyValue.set('notifiedRooms', rawNotified.filter(n => onlineKeys.has(identity.roomKey(n))));
  }

  // === 初始化 ===

  /**
   * onInstalled：房间库初始化（首启写默认值 + 旧格式迁移）+ 迁移编排自己的 notifiedRooms 旧格式
   * （string[] → {roomId, platform}）+ 通道决策 + 基础 alarm 收敛。
   */
  async function onInstalled() {
    const { seeded } = await store.init();
    if (seeded) {
      await keyValue.set('_firstRun', true); // 首启：只记录当前在线房间，不发开播通知
    }
    await migrateLegacyNotifiedRooms();
    await retireLegacyKeys();
    await syncViewerSettings();
    await syncBaseAlarms();
    await syncSubscriptionAlarm(); // 已排定的订阅在安装 / 升级后照响（更新会清 alarm）
  }

  /** 清掉已退役功能的存储键（见 ORCHESTRATOR_RETIRED_KEYS）；置 null 即视为不存在，幂等 */
  async function retireLegacyKeys() {
    for (const key of ORCHESTRATOR_RETIRED_KEYS) {
      await keyValue.set(key, null);
    }
  }

  /** notifiedRooms 的旧格式（string[]）迁移为 {roomId, platform}；不归房间库，随编排的键走 */
  async function migrateLegacyNotifiedRooms() {
    const raw = await keyValue.get('notifiedRooms');
    if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== 'string') {
      return false;
    }
    await keyValue.set('notifiedRooms', raw.map(id => ({ roomId: id, platform: identity.DEFAULT_PLATFORM })));
    return true;
  }

  /**
   * SW 唤醒时重建内存态：基础 alarm 收敛（浏览器重启后 Chrome 不保证 alarm 还在，见 ensurePeriodicAlarm）
   * + 观众数/B站通道状态 + 检测盯守配置 + 看点取数收敛（检测配置与计数都在内存里）。
   */
  function start() {
    watchReady = convergeRuntime().catch(e => {
      console.error('检测盯守初始化失败:', e);
    });
    return watchReady;
  }

  // === 消息入口（页面不再直写 storage，变更请求经这里落到房间库，见 ADR-0003）===

  async function onMessage(message) {
    switch (message && message.type) {
      case 'MANUAL_REFRESH':
        await refreshRooms();
        return { ok: true };

      case 'PATCH_SETTINGS': {
        // 设置变更：落盘（房间库）+ 收敛基础 alarm + 重新同步通道 + 收敛盯守连接。
        // 观众数开关变化要立刻生效（否则要等下一个 10 分钟采样周期），其余设置等下一个周期。
        const patch = message.patch || {};
        await store.patchSettings(patch);
        await convergeRuntime(); // refreshInterval / 各总开关可能刚被改过
        if ('fetchDouyuViewerCount' in patch || 'fetchBilibiliViewerCount' in patch) {
          await sampleViewerCounts();
        }
        return { ok: true };
      }

      case 'PATCH_ROOM_CONFIG': {
        const patched = await store.patchRoomConfig(
          { platform: message.platform, roomId: message.roomId },
          message.patch || {}
        );
        // 检测配置变更要重做通道决策（B站页面桥接 / SW 直连）再收敛盯守连接：
        // 只开检测、观众数开关关闭时也要走对通道
        await syncViewerSettings();
        await syncDanmakuWatch();
        await syncHighlightAlert(); // 该房看点开关可能刚被改过
        return patched.ok ? { ok: true, room: patched.room } : { ok: false, error: patched.reason };
      }

      case 'REORDER_ROOMS': {
        // 拖拽只在某个分类段内生效：请求带所在分类（空值即未分类），房间库只置换该分类成员所占的槽位
        const reordered = await store.reorderRooms({ categoryId: message.categoryId, order: message.order });
        return reordered.ok ? { ok: true } : { ok: false, error: reordered.reason };
      }

      // 分类与归类：纯组织（见 ADR-0008），不触发任何 alarm / 通知 / 采样收敛，因此路由是直通的
      case 'ADD_CATEGORY': {
        const created = await store.addCategory(message.name);
        return created.ok ? { ok: true, category: created.category } : { ok: false, error: created.error };
      }

      case 'RENAME_CATEGORY': {
        const renamed = await store.renameCategory(message.id, message.name);
        return renamed.ok ? { ok: true } : { ok: false, error: renamed.error };
      }

      case 'REMOVE_CATEGORY': {
        const removed = await store.removeCategory(message.id);
        return { ok: true, affected: removed.affected };
      }

      case 'REORDER_CATEGORIES': {
        const reordered = await store.reorderCategories(message.order);
        return reordered.ok ? { ok: true } : { ok: false, error: reordered.reason };
      }

      case 'SET_ROOM_CATEGORY': {
        const moved = await store.setRoomCategory(
          { platform: message.platform, roomId: message.roomId },
          message.categoryId
        );
        return moved.ok ? { ok: true } : { ok: false, error: moved.reason };
      }

      // 弹窗分类栏的选中项：纯 UI 状态（不增删房间、不改分类、不写房间库的键），因此与分类的
      // 组织操作一样是直通路由——不触发任何 alarm / 通知 / 采样。编排只原样落盘，不做分类存在性
      // 校验：「这个 id 现在还成不成立」是读取侧（弹窗）的回落判定（见 ADR-0009）
      case 'SET_POPUP_CATEGORY': {
        if (typeof message.categoryId !== 'string') {
          return { ok: false };
        }
        await keyValue.set('popupCategoryId', message.categoryId);
        return { ok: true };
      }

      case 'ADD_ROOM':
        return await handleAddRoom(message.roomId, message.platform, message.categoryId);

      case 'REMOVE_ROOM':
        return await handleRemoveRoom(message.roomId, message.platform);

      // 订阅（见 ADR-0016）：校验与 id 生成在房间库内；成功 / 删除后都要重排订阅 alarm。
      // 失败回传明确的 reason（时刻已过 / 房间不存在 / 平台不支持），页面就地报错。
      case 'ADD_SUBSCRIPTION': {
        const added = await store.addSubscription({
          platform: message.platform,
          roomId: message.roomId,
          at: message.at
        });
        if (!added.ok) {
          return { ok: false, error: added.error };
        }
        await syncSubscriptionAlarm();
        return { ok: true, subscription: added.subscription };
      }

      case 'REMOVE_SUBSCRIPTION': {
        await store.removeSubscription(message.id);
        await syncSubscriptionAlarm();
        return { ok: true };
      }

      // 配置导入（配置备份，见 ADR-0012）：请求体是设置页用 lib/config-backup.js 校验后的配置对象
      case 'IMPORT_CONFIG':
        return await handleImportConfig(message.config);

      // 页面通道（content script）回传的高能榜在线数
      case 'BILI_RANK_COUNT':
        await onViewerCount('bilibili', { roomId: message.roomId, value: message.rankCount });
        return { ok: true };

      // 页面通道（content script）回传的弹幕文本 → 检测计数
      case 'BILI_DANMU':
        await handleDanmu('bilibili', { roomId: message.roomId, text: message.text, user: message.user });
        return { ok: true };

      // 桥接页本轮采样完成/超时 → 关闭桥接标签页（消息事件可靠唤醒休眠中的 SW）；
      // 检测长连接常驻在桥接页时不得关页（采样完成只结束采样，盯守继续）
      case 'BILI_SAMPLE_DONE':
        if (!hasBiliWatch()) {
          await bridge.close().catch(() => { });
        }
        return { ok: true };

      default:
        return { ok: false };
    }
  }

  // === 房间管理 ===

  async function handleAddRoom(rawRoomId, platform, categoryId) {
    // 校验、昵称解析（跨平台兜底）、去重都在房间库内；新加入的房间先记为「已通知」，
    // 避免它在添加后的第一轮轮询里被当成新开播（与首启行为一致）
    const added = await store.addRoom({ roomId: rawRoomId, platform, categoryId });
    if (!added.ok) {
      return { ok: false, error: added.error };
    }
    const room = added.room;
    const notified = (await keyValue.get('notifiedRooms')) || [];
    if (!notified.some(n => identity.sameRoomId(n.roomId, room.roomId) && n.platform === room.platform)) {
      await keyValue.set('notifiedRooms', notified.concat([{ roomId: room.roomId, platform: room.platform }]));
    }
    // 重新添加的房间：清掉上一轮留下的看点水位，第一轮只记水位、不把该场已有的看点补报一遍
    await clearHighlightWatermark(room);

    await refreshRooms();
    await syncViewerSettings();
    // 立即采样一次观众数，不用等下一个 10 分钟周期
    await sampleViewerCounts();

    return { ok: true, nickname: room.nickname };
  }

  async function handleRemoveRoom(roomId, platform) {
    const removed = await store.removeRoom({ platform, roomId });
    const snapshot = await store.snapshot();
    notifier.setBadge(snapshot.streamers.filter(s => s.online).length);

    // 移除房间后重新收敛检测连接（该房若在盯守则断开并清空计数）
    await syncDanmakuWatch();
    await syncViewerSettings();
    // 移除房间顺手清掉看点水位：重新添加时从此刻起算（不清会在第一轮就把该场已有的看点报出来）
    await clearHighlightWatermark({ platform, roomId });
    await syncHighlightAlert();
    // 移除房间后立即采样，刷新剩余房间的观众数
    await sampleViewerCounts();

    return { ok: true, removed: removed.removed };
  }

  /**
   * 配置导入（配置备份，见 ADR-0012）：请求体是设置页用 lib/config-backup.js 校验后的配置对象
   * （解析与拒绝口径都在那个纯模块，本函数只落盘与收敛）。
   *
   * 三件事：
   * 1. 房间库一次写入完成三键替换 + streamers 对齐（形状不变量在它内部保持）。
   * 2. 清空编排持有的运行时键——它们记的是「本机观察到什么」，换配置后不再成立，
   *    由新配置在新机器上重新积累（键归属边界不变：谁拥有键谁清）。
   * 3. 预记新房间为「已通知」并完整收敛（基础 alarm / 通道 / 盯守 / 看点 + 立即轮询一轮），
   *    否则最坏要等一个轮询周期才看到正确状态，且第一次轮询会把在播房间当新开播推一屏通知。
   */
  async function handleImportConfig(config) {
    if (!config || typeof config !== 'object') {
      return { ok: false, error: 'invalid-config' };
    }

    await store.importConfig(config);

    // 清空运行时键：置 null 即视为不存在（各消费方本就以 `|| {}` / `|| []` 兜底）
    for (const key of ORCHESTRATOR_RUNTIME_KEYS) {
      await keyValue.set(key, null);
    }
    // 新配置里的房间预记入已通知（与手动添加房间同一套做法）：本轮轮询不把它们当成新开播
    const snapshot = await store.snapshot();
    await keyValue.set('notifiedRooms', snapshot.rooms.map(room => ({ roomId: room.roomId, platform: room.platform })));

    // 完整收敛（沿用设置变更那一套 + 立即轮询一轮）
    await convergeRuntime();
    await refreshRooms();

    const next = await store.snapshot();
    return { ok: true, rooms: next.rooms.length, categories: next.categories.length };
  }

  // === 事件入口 ===

  async function onAlarm(name) {
    if (name === ORCHESTRATOR_REFRESH_ALARM) {
      await refreshRooms();
    } else if (name === ORCHESTRATOR_SAMPLE_ALARM) {
      await sampleViewerCounts();
    } else if (name === ORCHESTRATOR_SURGE_ALARM) {
      await settleDanmakuSurge();
    } else if (name === ORCHESTRATOR_HIGHLIGHT_ALARM) {
      await pollHighlights();
    } else if (name === ORCHESTRATOR_SUBSCRIPTION_ALARM) {
      await handleSubscriptionReminder();
    }
  }

  /**
   * 浏览器整个启动时重建：与 start() 同一件事（基础 alarm 收敛 + 内存态重建），只是入口时机不同。
   * Chrome 不保证 alarm 跨浏览器重启存活（见 ensurePeriodicAlarm），而 onInstalled 只在安装/更新时触发，
   * 单靠它会让「装完扩展后一直挂着的浏览器重启一次」把开播轮询永久停摆——onStartup 就是补这个缺口。
   */
  function onStartup() {
    return start();
  }

  return {
    // 生命周期
    start,
    onStartup,
    onInstalled,
    onAlarm,
    onMessage,
    onNotificationClicked,
    // 域操作（测试与入口都可直接驱动）
    refreshRooms,
    sampleViewerCounts,
    syncViewerSettings,
    syncDanmakuWatch,
    handleDanmu,
    onViewerCount,
    handleBiliChannelFallback,
    handleAddRoom,
    handleRemoveRoom
  };
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createOrchestrator };
}
