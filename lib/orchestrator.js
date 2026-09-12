// lib/orchestrator.js — 直播状态编排：轮询 / 观众数采样 / 弹幕检测盯守 / 三类通知
//
// 依赖全部注入，chrome 只在入口（background.js）出现一次：
//   store     房间库（lib/room-store.js）：三个键的形状与全部变更，见 ADR-0003
//   keyValue  单键键值 port：编排自己的键（notifiedRooms / _firstRun / lastRefresh / watchQueued）
//   apis      { douyu: { batchFetchRoomInfo, resolveNickname }, bilibili: {...} } 平台 API
//   clients   { douyuSample, douyuWatch, bilibiliSample, bilibiliWatch } 弹幕客户端
//   bridge    BiliBridgeChannel（B站页面桥接通道）
//   notifier  { create(notificationId, content) -> Promise<boolean>, setBadge(count) }
//   rules     纯规则：lib/viewer-alert.js + lib/danmaku-watch.js 的导出
//   alarms    { create(name, info) }
//   tabs      { create({ url }) }（通知点击进入直播间）
//
// 事件注册留在入口；名字/消息到域操作的映射在这里（onAlarm / onMessage），因而可测。
// 阈值判定（观众数提醒）与命中判定（弹幕检测）留在两个纯规则 module；本 module 只负责
// 「什么时候问、拿到结果做什么」。通知 ID 与直播间 URL 的对应也在本 module（见 CONTEXT.md「通知」）。
// UMD 双兼容：SW 经 importScripts 加载，node 下可 require。

const ORCHESTRATOR_PLATFORMS = ['douyu', 'bilibili'];
const ORCHESTRATOR_REFRESH_ALARM = 'refreshRooms';
const ORCHESTRATOR_SAMPLE_ALARM = 'sampleViewerCounts';
const ORCHESTRATOR_VIEWER_SAMPLE_INTERVAL = 10; // 观众数采样间隔（分钟），与 sampleViewerCounts alarm 周期一致
const ORCHESTRATOR_WATCH_SUFFIX = '_watch';           // 检测通知 ID 后缀（与开播通知互不覆盖）
const ORCHESTRATOR_VIEWER_ALERT_SUFFIX = '_viewer';   // 观众数提醒 ID 后缀（同样与开播通知互不覆盖）
// 派生通知 ID 的后缀表（liveUrlFromNotificationId 据此还原房间复合键）
const ORCHESTRATOR_NOTIFICATION_SUFFIXES = [ORCHESTRATOR_WATCH_SUFFIX, ORCHESTRATOR_VIEWER_ALERT_SUFFIX];

function createOrchestrator({ store, keyValue, apis, clients, bridge, notifier, rules, alarms, tabs }) {
  // 内存态（与检测长连接同生命周期，SW 被回收即丢，start() 时按存储中的快照重建）
  const watchCounter = new rules.DanmakuWatchCounter();
  const watchedConfigs = new Map(); // 房间复合键 -> { key, platform, roomId, nickname, config }（每轮轮询重建）
  let watchedKeys = new Set();      // 上一轮盯守的房间复合键（用于识别下播/停用边沿）
  let watchReady = null;            // start() 的重建 Promise：弹幕入口先等它，避免首批弹幕被丢弃

  // === 通知 ===

  /** 通知标题的平台前缀（与 popup / 设置页的平台标签一致） */
  function platformLabel(platform) {
    return platform === 'bilibili' ? '[B站]' : '[斗鱼]';
  }

  /** 通知正文里的弹幕文本截断（过长会被系统截断成不可读） */
  function truncateDanmu(text) {
    const str = String(text || '');
    return str.length > 60 ? `${str.slice(0, 60)}…` : str;
  }

  /** 数字格式化：>= 1 万显示 x.x万，否则原样（与 popup 保持一致） */
  function formatNumber(num) {
    if (num >= 10000) {
      return (num / 10000).toFixed(1) + '万';
    }
    return String(num);
  }

  /**
   * 房间通知的统一创建入口：开播 / 弹幕命中 / 观众数提醒三种通知外形一致，
   * 只有 ID、标题与正文不同。同 ID 重复触发即覆盖，不堆积。
   */
  async function createRoomNotification(notificationId, { title, message, contextMessage }) {
    try {
      return await notifier.create(notificationId, { title, message, contextMessage });
    } catch (e) {
      console.error('通知创建失败:', notificationId, e);
      return false;
    }
  }

  /** 通知 ID 与直播间的对应（开播通知为 `platform_roomId`，另两种带后缀；房间号恒为纯数字） */
  function liveUrlFromNotificationId(notificationId) {
    let baseId = String(notificationId || '');
    for (const suffix of ORCHESTRATOR_NOTIFICATION_SUFFIXES) {
      if (baseId.endsWith(suffix)) {
        baseId = baseId.slice(0, -suffix.length);
        break;
      }
    }
    const [platform, ...rest] = baseId.split('_');
    const roomId = rest.join('_');
    if (platform === 'bilibili') {
      return `https://live.bilibili.com/${roomId}`;
    }
    return `https://www.douyu.com/${roomId}`;
  }

  /** 通知点击/按钮点击 → 打开直播间 */
  async function onNotificationClicked(notificationId) {
    const url = liveUrlFromNotificationId(notificationId);
    if (url) await tabs.create({ url });
  }

  // === 定时器 ===

  async function createAlarm() {
    const snapshot = await store.snapshot();
    const interval = snapshot.settings.refreshInterval || 60;
    alarms.create(ORCHESTRATOR_REFRESH_ALARM, { periodInMinutes: Math.max(1, Math.floor(interval / 60)) });
    // 观众数采样 alarm：10 分钟短连一次，平时不保持 WS 连接
    alarms.create(ORCHESTRATOR_SAMPLE_ALARM, { periodInMinutes: ORCHESTRATOR_VIEWER_SAMPLE_INTERVAL });
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
    // 检测需求并入 B站通道决策：只开了弹幕检测（未开观众数）的房间一样需要 B站弹幕通道；
    // 检测总开关关闭时不算检测需求（不再为盯守常驻桥接页）
    const facts = await store.reconcileViewerGates();
    await bridge.sync({
      danmakuWatch: rules.hasConfiguredBiliWatch(snapshot.rooms, rules.isDanmakuWatchEnabled(snapshot.settings)),
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
   * 观众数提醒判定：依次全通过才发提醒——全局总开关 → 该房 viewerAlert 配置 → 上升边沿。
   * 该平台观众数开关已在写入处（房间库）把关：关闭时不写、不判定。
   */
  async function evaluateViewerAlert(platform, result) {
    if (!rules.VIEWER_METRICS[platform]) {
      return false;
    }
    if (!rules.isViewerAlertEnabled(result.settings)) {
      return false; // 总开关关闭：配置保留、不判定
    }
    const config = rules.normalizeViewerAlert(result.room && result.room.viewerAlert);
    if (!config) {
      return false; // 该房未启用观众数提醒
    }
    if (!rules.isViewerAlertCrossed(result.prevValue, result.nextValue, config.threshold)) {
      return false;
    }
    await notifyViewerAlert(
      platform,
      { roomId: result.roomId, nickname: (result.room && result.room.nickname) || '' },
      result.nextValue,
      config.threshold,
      result.streamer
    );
    return true;
  }

  /**
   * 观众数提醒通知：ID 为派生 ID（房间复合键 + _viewer 后缀），同房重复触发复用同一 ID → 覆盖不堆积。
   * 不受开播通知总开关影响：只受自己的总开关与该平台观众数开关约束。
   */
  async function notifyViewerAlert(platform, { roomId, nickname }, value, threshold, streamer) {
    const meta = rules.VIEWER_METRICS[platform];
    await createRoomNotification(`${platform}_${roomId}${ORCHESTRATOR_VIEWER_ALERT_SUFFIX}`, {
      title: `${platformLabel(platform)} ${nickname} ${meta.label}超过 ${threshold}！`,
      message: (streamer && streamer.title) || '正在直播',
      contextMessage: `当前 ${formatNumber(value)} ${meta.shortLabel}`
    });
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

  // === 弹幕检测（开播门控长连接，见 ADR-0001）===
  // 检测词命中在滑动窗口内达到阈值 → 发一条检测通知（派生 ID，按房间覆盖）→ 进冷却。
  // 计数与冷却是内存态（与检测长连接同生命周期）：下播断开即清空，SW 重启归零。

  /**
   * 弹幕检测的轮询收敛点（写回开播快照之后调用，添加/移除房间同样经此入口）：
   * - 按房间列表顺序取前 5 个「在线且已配置检测」的房间为盯守对象，其余在线房间排队
   * - 连接按盯守集合幂等收敛：开播建长连接、下播断开（SW 被回收后同样由这里重连）
   * - 下播/停用边沿清空该房计数（含冷却与锁定）
   */
  async function syncDanmakuWatch() {
    const snapshot = await store.snapshot();
    const onlineKeys = new Set(
      snapshot.streamers.filter(s => s.online).map(s => `${s.platform || 'douyu'}_${s.roomId}`)
    );
    // 总开关关闭 → 空计划：连接收敛为 0、排队清空、计数按边沿清空（各房配好的检测词仍留在存储里）
    const plan = rules.selectWatchPlan(snapshot.rooms, onlineKeys, {
      enabled: rules.isDanmakuWatchEnabled(snapshot.settings)
    });

    // 下播/停用边沿：清空计数与冷却（下一场重新计数，冷却 0 的锁定同时解除）
    const nextKeys = new Set(plan.active.map(e => e.key));
    for (const key of watchedKeys) {
      if (!nextKeys.has(key)) {
        watchCounter.reset(key);
      }
    }
    const hadBiliWatch = [...watchedConfigs.values()].some(e => e.platform === 'bilibili');
    watchedKeys = nextKeys;
    watchedConfigs.clear();
    for (const entry of plan.active) {
      watchedConfigs.set(entry.key, entry);
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
  }

  /** 排队提示（popup 读取）：超过并发上限暂未盯守的在线房间，仅在变化时写入 */
  async function syncWatchQueue(queued) {
    const next = queued.map(e => ({ roomId: e.roomId, platform: e.platform, nickname: e.nickname }));
    const prev = (await keyValue.get('watchQueued')) || [];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      await keyValue.set('watchQueued', next);
    }
  }

  /** 当前是否有 B站房间在盯守（桥接页检测长连接常驻期间不得被采样收尾关页） */
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
   * 命中检测词 → 窗口计数 → 达阈值发检测通知（未在盯守的房间直接忽略）
   */
  async function handleDanmu(platform, { roomId, text, user }) {
    if (watchReady) {
      await watchReady; // SW 唤醒后先等内存里的盯守配置重建完成
    }
    const key = `${platform}_${roomId}`;
    const entry = watchedConfigs.get(key);
    if (!entry) {
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
   * 检测通知：ID 为派生 ID（房间复合键 + _watch 后缀），与开播通知并存、同一房间重复触发复用同一 ID。
   * 不受开播通知总开关影响：检测有独立的启用开关与检测词配置，开了检测就是要这条通知。
   */
  async function notifyDanmakuHit(entry, { keyword, text, user, count }) {
    const body = user ? `${user}：${truncateDanmu(text)}` : truncateDanmu(text);
    await createRoomNotification(`${entry.key}${ORCHESTRATOR_WATCH_SUFFIX}`, {
      title: `${platformLabel(entry.platform)} ${entry.nickname} 弹幕命中！`,
      message: body,
      contextMessage: `${entry.config.windowMinutes} 分钟内「${keyword}」命中 ${count} 次`
    });
  }

  // === 核心轮询 ===

  async function refreshRooms() {
    const snapshot = await store.snapshot();
    if (snapshot.rooms.length === 0) {
      await syncDanmakuWatch(); // 房间清空 → 断开全部检测连接
      return; // 未配置房间号，跳过
    }

    const results = {};
    await Promise.all(ORCHESTRATOR_PLATFORMS.map(async platform => {
      const ids = snapshot.rooms
        .filter(room => (room.platform || 'douyu') === platform)
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
      if (settings.notificationsEnabled !== false) {
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
    const notifiedMap = new Set(rawNotified.map(n => `${n.platform}_${n.roomId}`));

    for (const streamer of wentLive) {
      if (streamer.notify !== true) continue; // 跳过用户设置了不通知的房间

      const compositeKey = `${streamer.platform}_${streamer.roomId}`;
      if (notifiedMap.has(compositeKey)) continue;

      // 统计文案按平台区分：斗鱼显示贵宾数，B站显示高能榜在线数（都是弹幕推送的采样值）
      const statText = streamer.platform === 'bilibili'
        ? (typeof streamer.rankCount === 'number' && streamer.rankCount > 0
          ? `${formatNumber(streamer.rankCount)} 高能榜`
          : '')
        : (typeof streamer.vipCount === 'number' && streamer.vipCount > 0
          ? `${formatNumber(streamer.vipCount)} 贵宾`
          : '');
      const created = await createRoomNotification(compositeKey, {
        title: `${platformLabel(streamer.platform)} ${streamer.nickname} 开播了！`,
        message: streamer.title || '正在直播',
        contextMessage: [streamer.category, statText].filter(Boolean).join(' · ')
      });
      if (created) {
        notifiedMap.add(compositeKey);
      }
    }

    const onlineKeys = new Set(
      streamers
        .filter(s => s.online && s.notify === true)
        .map(s => `${s.platform}_${s.roomId}`)
    );
    await keyValue.set('notifiedRooms', rawNotified.filter(n => onlineKeys.has(`${n.platform}_${n.roomId}`)));
  }

  // === 初始化 ===

  /**
   * onInstalled：房间库初始化（首启写默认值 + 旧格式迁移）+ 迁移编排自己的 notifiedRooms 旧格式
   * （string[] → {roomId, platform}）+ 通道决策 + 建 alarm。
   */
  async function onInstalled() {
    const { seeded } = await store.init();
    if (seeded) {
      await keyValue.set('_firstRun', true); // 首启：只记录当前在线房间，不发开播通知
    }
    await migrateLegacyNotifiedRooms();
    await syncViewerSettings();
    await createAlarm();
  }

  /** notifiedRooms 的旧格式（string[]）迁移为 {roomId, platform}；不归房间库，随编排的键走 */
  async function migrateLegacyNotifiedRooms() {
    const raw = await keyValue.get('notifiedRooms');
    if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== 'string') {
      return false;
    }
    await keyValue.set('notifiedRooms', raw.map(id => ({ roomId: id, platform: 'douyu' })));
    return true;
  }

  /** SW 唤醒时重建内存态：观众数/B站通道状态 + 检测盯守配置（检测配置与计数都在内存里） */
  function start() {
    watchReady = (async () => {
      await syncViewerSettings();
      await syncDanmakuWatch();
    })().catch(e => {
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
        // 设置变更：落盘（房间库）+ 重建轮询 alarm + 重新同步通道 + 收敛盯守连接。
        // 观众数开关变化要立刻生效（否则要等下一个 10 分钟采样周期），其余设置等下一个周期。
        const patch = message.patch || {};
        await store.patchSettings(patch);
        await createAlarm();
        await syncViewerSettings();
        await syncDanmakuWatch();
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
        return patched.ok ? { ok: true, room: patched.room } : { ok: false, error: patched.reason };
      }

      case 'REORDER_ROOMS': {
        const reordered = await store.reorderRooms(message.order);
        return reordered.ok ? { ok: true } : { ok: false, error: reordered.reason };
      }

      case 'ADD_ROOM':
        return await handleAddRoom(message.roomId, message.platform);

      case 'REMOVE_ROOM':
        return await handleRemoveRoom(message.roomId, message.platform);

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

  async function handleAddRoom(rawRoomId, platform) {
    // 校验、昵称解析（跨平台兜底）、去重都在房间库内；新加入的房间先记为「已通知」，
    // 避免它在添加后的第一轮轮询里被当成新开播（与首启行为一致）
    const added = await store.addRoom({ roomId: rawRoomId, platform });
    if (!added.ok) {
      return { ok: false, error: added.error };
    }
    const room = added.room;
    const notified = (await keyValue.get('notifiedRooms')) || [];
    if (!notified.some(n => n.roomId === room.roomId && (n.platform || 'douyu') === room.platform)) {
      await keyValue.set('notifiedRooms', notified.concat([{ roomId: room.roomId, platform: room.platform }]));
    }

    await refreshRooms();
    await syncViewerSettings();
    // 立即采样一次观众数，不用等下一个 10 分钟周期
    await sampleViewerCounts();

    return { ok: true, nickname: room.nickname };
  }

  async function handleRemoveRoom(roomId, platform) {
    const removed = await store.removeRoom({ platform: platform || 'douyu', roomId });
    const snapshot = await store.snapshot();
    notifier.setBadge(snapshot.streamers.filter(s => s.online).length);

    // 移除房间后重新收敛检测连接（该房若在盯守则断开并清空计数）
    await syncDanmakuWatch();
    await syncViewerSettings();
    // 移除房间后立即采样，刷新剩余房间的观众数
    await sampleViewerCounts();

    return { ok: true, removed: removed.removed };
  }

  // === 事件入口 ===

  async function onAlarm(name) {
    if (name === ORCHESTRATOR_REFRESH_ALARM) {
      await refreshRooms();
    } else if (name === ORCHESTRATOR_SAMPLE_ALARM) {
      await sampleViewerCounts();
    }
  }

  return {
    // 生命周期
    start,
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
