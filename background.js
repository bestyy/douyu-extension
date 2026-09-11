// background.js — Service Worker

importScripts('lib/storage.js');
importScripts('lib/danmaku-watch.js');
importScripts('lib/viewer-alert.js');
importScripts('lib/douyu-api.js');
importScripts('lib/bilibili-api.js');
importScripts('lib/douyu-barrage.js');
importScripts('lib/bilibili-barrage.js');
importScripts('lib/bili-bridge-channel.js');

// === 贵宾数弹幕客户端 ===
// 通过 danmuproxy WebSocket 订阅 oni 消息（贵宾数），约每 6 秒推送一次
const barrageClient = new BarrageClient({
  onVipCount: updateVipCount
});

// === B站高能榜弹幕客户端 ===
// 订阅 ONLINE_RANK_COUNT 消息（高能榜在线数），约每 4-6 秒推送一次。
// 通道由 biliBridge.sync() 按登录态决策：未登录走 SW 直连（认证参数与直播间页面
// 弹幕连接逐字对齐，见 .pi/test-bili-comet.cjs），登录态走页面桥接（SW 直连握手
// 必被 1006 风控）；两通道均为 10 分钟采样节奏，拿到数据即断开。
// 若未来 SW 直连被风控（本轮全败且快速断开），onFallback 降级到页面通道。
const bilibiliBarrageClient = new BilibiliBarrageClient({
  onRankCount: updateRankCount,
  onFallback: handleBiliChannelFallback
});

// === 弹幕检测长连接客户端（检测与采样短连并存，见 ADR-0001）===
// 检测要求秒级实时性，复用 10 分钟采样短连没有意义；因此检测用独立实例保持长连接：
// 斗鱼解析 chatmsg、B站解析 DANMU_MSG，弹幕文本统一扇入 handleDanmu。
// 连接由开播门控（syncDanmakuWatch，挂在轮询收敛点）增删，下播即断开并清空计数。
const douyuWatchClient = new BarrageClient({
  onDanmu: data => handleDanmu('douyu', data)
});

// 未登录时 B站检测走 SW 直连（登录态下由桥接页建连，弹幕经 BILI_DANMU 消息回传）
const bilibiliWatchClient = new BilibiliBarrageClient({
  onDanmu: data => handleDanmu('bilibili', data)
});

// === B站页面桥接通道（深 module） ===
// 页面通道的全部状态与编排收进 BiliBridgeChannel：sync 决策通道、sample 驱动一轮
// 采样、close 关桥接页、enableFallback 置降级标记；background 只读 enabled 做采样分支。
const biliBridge = new BiliBridgeChannel({
  storage: StorageHelper,
  tabs: chrome.tabs,
  isLoggedIn: isBiliLoggedIn
});

// === 观众数采样控制 ===
// 设置页观众数开关按平台拆分：fetchDouyuViewerCount（斗鱼贵宾数）/ fetchBilibiliViewerCount（B站高能榜在线数），
// 旧版本仅有总开关 fetchViewerCount（读取时回退兼容）；各平台采样独立受控：
// 采样模式：每 10 分钟由 chrome.alarms 驱动一次短连，拿到数据立即断开，
// 平时不保持任何 WS 连接（连接数不再随房间数增长）
const VIEWER_SAMPLE_INTERVAL = 10; // 观众数采样间隔（分钟），与 sampleViewerCounts alarm 周期一致

// 读取某平台的观众数获取开关（settings.fetchDouyuViewerCount / fetchBilibiliViewerCount，默认开启）；
// 新字段未写入时回退旧总开关 fetchViewerCount 语义（旧版本仅存有该字段）
async function isViewerFetchEnabled(platform) {
  const settings = await StorageHelper.get('settings');
  if (!settings) return true;
  const key = platform === 'bilibili' ? 'fetchBilibiliViewerCount' : 'fetchDouyuViewerCount';
  if (settings[key] !== undefined) {
    return settings[key] !== false;
  }
  return settings.fetchViewerCount !== false;
}

// 检测 B站登录态：SESSDATA Cookie 存在即视为已登录。
// 登录态下 SW 直连的弹幕 WS 握手携带登录 Cookie，实测必被 1006 风控；
// 未登录（无 Cookie）时 SW 直连可用（见 .pi/test-bili-comet.cjs）。
// 因此登录与否决定 B站采样走页面桥接还是 SW 直连。
async function isBiliLoggedIn() {
  try {
    const cookie = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'SESSDATA' });
    return !!(cookie && cookie.value);
  } catch (e) {
    return false;
  }
}

// Service Worker 每次唤醒时重建内存态：观众数/B站通道状态（syncViewerSettings）
// 与检测盯守配置缓存（syncDanmakuWatch）。检测配置与计数都在内存里，SW 被回收即丢，
// 因此弹幕入口（handleDanmu）先等这一次重建，避免唤醒后首批弹幕被当成未盯守房间丢弃。
const watchReady = (async () => {
  await syncViewerSettings();
  await syncDanmakuWatch();
})().catch(e => {
  console.error('检测盯守初始化失败:', e);
});

// 收到 oni 推送 → 更新 streamers[].vipCount（写入 storage 供 popup 读取）+ 观众数提醒判定
async function updateVipCount({ roomId, vipCount }) {
  if (!(await isViewerFetchEnabled('douyu'))) {
    return;
  }
  const streamers = (await StorageHelper.get('streamers')) || [];
  const index = streamers.findIndex(s => s.platform === 'douyu' && String(s.roomId) === String(roomId));
  if (index === -1) {
    return;
  }
  const prevValue = streamers[index].vipCount;
  streamers[index] = { ...streamers[index], vipCount };
  await StorageHelper.set('streamers', streamers);
  await evaluateViewerAlert('douyu', roomId, { prevValue, nextValue: vipCount, streamer: streamers[index] });
}

// 收到 ONLINE_RANK_COUNT 推送 → 更新 streamers[].rankCount（高能榜在线数）+ 观众数提醒判定
// 页面通道为长连接模式（每 4-6 秒推送一次），仅在数值变化时写 storage 与打日志
async function updateRankCount({ roomId, rankCount }) {
  if (!(await isViewerFetchEnabled('bilibili'))) {
    return;
  }
  const streamers = (await StorageHelper.get('streamers')) || [];
  const index = streamers.findIndex(s => s.platform === 'bilibili' && String(s.roomId) === String(roomId));
  if (index === -1) {
    console.warn(`[bili] updateRankCount 未找到匹配 streamers 条目 roomId=${roomId} rankCount=${rankCount} streamers=${streamers.length}条`);
    return;
  }
  if (streamers[index].rankCount === rankCount) {
    return; // 数值未变化，跳过写入
  }
  const prevValue = streamers[index].rankCount;
  streamers[index] = { ...streamers[index], rankCount };
  await StorageHelper.set('streamers', streamers);
  console.log(`[bili] updateRankCount 已写入 ${roomId} rankCount=${rankCount}`);
  await evaluateViewerAlert('bilibili', roomId, { prevValue, nextValue: rankCount, streamer: streamers[index] });
}

// === B站弹幕页面通道（SW 直连被风控时的降级后备） ===
// SW 直连为主通道（认证参数与页面弹幕一致后实测可用，见 .pi/test-bili-comet.cjs）；
// 若未来 B站风控收紧（本轮采样全败且快速断开），onFallback 切换为页面通道：
// content script 在 live.bilibili.com 页面上下文建连（lib/bilibili-page-bridge.js），
// 通过 chrome.runtime 消息回传高能榜在线数。
// 通道状态、桥接标签页生命周期与采样编排收进 BiliBridgeChannel（lib/bili-bridge-channel.js），
// background 只保留降级编排（enableFallback → destroy → 通知）。

// SW 直连采样被风控（本轮全败且快速断开）→ 降级到页面通道
async function handleBiliChannelFallback() {
  // 模块内职责：置内存标记 + 持久化 + 日志（开关关闭/已启用时内部跳过）
  await biliBridge.enableFallback();
  // 停止 SW 直连采样，避免继续触发风控（destroy 只断开连接，不触发降级判定）；
  // 桥接标签页不在此常驻，下一次 sampleViewerCounts 采样时临时打开
  bilibiliBarrageClient.destroy();
  try {
    await chrome.notifications.create('bili_bridge_fallback', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'B站高能榜连接已切换通道',
      message: '当前浏览器拦截了扩展直连，已切换为页面通道。每次采样时会自动临时打开一个 B站标签页，获取后自动关闭。',
      priority: 1
    });
  } catch (e) {
    // 通知失败不影响功能
  }
}

// === 初始化 ===
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await StorageHelper.getAll();

  // 数据迁移（旧版本→新版本）
  await StorageHelper.migrateLegacyFormat();

  if (Object.keys(existing).length === 0) {
    await chrome.storage.local.set({
      ...DEFAULT_STORAGE,
      _firstRun: true
    });
  }

  // 通道选择（页面桥接 vs SW 直连）统一由 biliBridge.sync() 按登录态/降级标记决策，
  // 这里不再重置标记或关闭桥接页，避免与顶层 biliBridge.sync() 竞态覆盖。
  // （登录用户：桥接页由 _ensureTab 的 ping 存活检测，重载后失效的页面自动刷新重注入）
  await syncViewerSettings();

  await createAlarm();
});

// === 定时器管理 ===
async function createAlarm() {
  const settings = await StorageHelper.get('settings');
  const interval = settings?.refreshInterval || 60;
  const minutes = Math.max(1, Math.floor(interval / 60));
  chrome.alarms.create('refreshRooms', { periodInMinutes: minutes });
  // 观众数采样 alarm：10 分钟短连一次，平时不保持 WS 连接
  chrome.alarms.create('sampleViewerCounts', { periodInMinutes: VIEWER_SAMPLE_INTERVAL });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refreshRooms') {
    await refreshRooms();
  } else if (alarm.name === 'sampleViewerCounts') {
    await sampleViewerCounts();
  }
});

// === 观众数定时采样 ===
// 每 10 分钟短连一次：斗鱼单连接订阅全部房间，B站每房间一条连接；
// 拿到数据立即断开，平时零 WS 连接（由 chrome.alarms 驱动，SW 休眠后自动恢复）。
// B站登录态（SESSDATA）下 SW 直连握手必被 1006 风控，改为页面通道：临时打开
// 桥接标签页，在页面上下文建立长连接（登录态下短连同样被风控），拿到高能榜
// 在线数即断开并关闭页面，节奏与斗鱼一致。
async function sampleViewerCounts() {
  const rooms = (await StorageHelper.get('rooms')) || [];
  const douyuIds = rooms.filter(r => r.platform === 'douyu').map(r => String(r.roomId));
  const bilibiliIds = rooms.filter(r => r.platform === 'bilibili').map(r => String(r.roomId));

  // 斗鱼分支：由斗鱼开关独立控制
  if (douyuIds.length > 0 && (await isViewerFetchEnabled('douyu'))) {
    barrageClient.sample(douyuIds);
  }
  // B站分支：由 B站开关独立控制
  if (bilibiliIds.length > 0 && (await isViewerFetchEnabled('bilibili'))) {
    if (biliBridge.enabled) {
      // 页面通道（登录态主通道/降级后备）：临时开页 → 长连接采样 → 桥接页发
      // BILI_SAMPLE_DONE 后由 SW 关闭页面（不在此长时间等待，消息事件可靠唤醒
      // 休眠中的 SW 完成关页，避免等待期间 SW 空闲被终止）
      await biliBridge.sample(bilibiliIds);
    } else {
      // SW 直连主通道（未登录）：每个房间一条短连，收到高能榜在线数即断开（认证参数与页面弹幕一致）
      bilibiliBarrageClient.sample(bilibiliIds);
    }
  }
}

// 按平台开关清理过期的观众数字段（关闭斗鱼开关 → 清 vipCount；关闭 B站开关 → 清 rankCount），
// 避免 popup 显示关闭前残留的旧数据；B站通道侧的清理见 biliBridge.sync
async function pruneStaleViewerCounts() {
  const [douyuOn, biliOn] = await Promise.all([
    isViewerFetchEnabled('douyu'),
    isViewerFetchEnabled('bilibili')
  ]);
  if (douyuOn && biliOn) return;
  const streamers = (await StorageHelper.get('streamers')) || [];
  if (!streamers.some(s => (!douyuOn && 'vipCount' in s) || (!biliOn && 'rankCount' in s))) {
    return;
  }
  const cleaned = streamers.map(s => {
    const next = { ...s };
    if (!douyuOn) delete next.vipCount;
    if (!biliOn) delete next.rankCount;
    return next;
  });
  await StorageHelper.set('streamers', cleaned);
}

// 观众数设置同步入口：B站页面通道决策（biliBridge.sync）+ 按开关清理过期观众数字段。
// biliBridge 只负责 B站相关状态；斗鱼字段（vipCount）清理由本入口统一处理
async function syncViewerSettings() {
  // 检测需求并入 B站通道决策：只开了弹幕检测（未开观众数）的房间一样需要 B站弹幕通道；
  // 检测总开关关闭时不算检测需求（不再为盯守常驻桥接页）
  const [rooms, settings] = await Promise.all([
    StorageHelper.get('rooms'),
    StorageHelper.get('settings')
  ]);
  await biliBridge.sync({ danmakuWatch: hasConfiguredBiliWatch(rooms || [], isDanmakuWatchEnabled(settings)) });
  await pruneStaleViewerCounts();
}

// === 弹幕检测（开播门控长连接，见 ADR-0001）===
// 检测词命中在滑动窗口内达到阈值 → 发一条检测通知（派生 ID，按房间覆盖）→ 进冷却。
// 计数与冷却是内存态（与检测长连接同生命周期）：下播断开即清空，SW 重启归零；
// 盯守配置缓存同样在内存里，但 SW 唤醒时会按存储中的开播快照立即重建（见 watchReady）。
const WATCH_NOTIFICATION_SUFFIX = '_watch'; // 检测通知 ID 后缀（与开播通知互不覆盖）
const VIEWER_ALERT_NOTIFICATION_SUFFIX = '_viewer'; // 观众数提醒 ID 后缀（同样与开播通知互不覆盖）
// 派生通知 ID 的后缀表（getLiveUrlFromNotificationId 据此还原房间复合键）
const NOTIFICATION_ID_SUFFIXES = [WATCH_NOTIFICATION_SUFFIX, VIEWER_ALERT_NOTIFICATION_SUFFIX];
const watchCounter = new DanmakuWatchCounter();
const watchedConfigs = new Map(); // 房间复合键 -> { key, platform, roomId, nickname, config }（每轮轮询重建）
let watchedKeys = new Set();      // 上一轮盯守的房间复合键（用于识别下播/停用边沿）

/**
 * 弹幕检测的轮询收敛点（写回开播快照之后调用，添加/移除房间同样经此入口）：
 * - 按房间列表顺序取前 5 个「在线且已配置检测」的房间为盯守对象，其余在线房间排队
 * - 连接按盯守集合幂等收敛：开播建长连接、下播断开（SW 被回收后同样由这里重连）
 * - 下播/停用边沿清空该房计数（含冷却与锁定）
 */
async function syncDanmakuWatch() {
  const [roomsRaw, streamersRaw, settings] = await Promise.all([
    StorageHelper.get('rooms'),
    StorageHelper.get('streamers'),
    StorageHelper.get('settings')
  ]);
  const onlineKeys = new Set(
    (streamersRaw || []).filter(s => s.online).map(s => `${s.platform}_${s.roomId}`)
  );
  // 总开关关闭 → 空计划：连接收敛为 0、排队清空、计数按边沿清空（各房配好的检测词仍留在存储里）
  const plan = selectWatchPlan(roomsRaw || [], onlineKeys, {
    enabled: isDanmakuWatchEnabled(settings)
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
  douyuWatchClient.setRooms(plan.active.filter(e => e.platform === 'douyu').map(e => e.roomId));

  // B站：通道决策沿用观众数封装（登录态页面桥接 / 未登录 SW 直连）
  const biliIds = plan.active.filter(e => e.platform === 'bilibili').map(e => e.roomId);
  if (biliBridge.enabled) {
    // 全量下发（含空列表）：桥接页按最新列表收敛，SW 重启后内存态丢失也能清掉残留连接
    await biliBridge.watch(biliIds);
    if (biliIds.length === 0 && hadBiliWatch) {
      await biliBridge.close(); // 本 SW 生命周期内的盯守结束：释放常驻桥接页（采样会按需再开）
    }
    bilibiliWatchClient.setRooms([]); // 页面通道启用时不留 SW 直连检测连接
  } else {
    bilibiliWatchClient.setRooms(biliIds);
  }

  await syncWatchQueue(plan.queued);
}

// 排队提示（popup 读取）：超过并发上限暂未盯守的在线房间，仅在变化时写入
async function syncWatchQueue(queued) {
  const next = queued.map(e => ({ roomId: e.roomId, platform: e.platform, nickname: e.nickname }));
  const prev = (await StorageHelper.get('watchQueued')) || [];
  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    await StorageHelper.set('watchQueued', next);
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
  await watchReady; // SW 唤醒后先等内存里的盯守配置重建完成
  const key = `${platform}_${roomId}`;
  const entry = watchedConfigs.get(key);
  if (!entry) {
    return;
  }
  const keyword = matchKeyword(text, entry.config);
  if (!keyword) {
    return;
  }
  const { triggered, count } = watchCounter.recordHit(key, entry.config);
  if (!triggered) {
    return;
  }
  await notifyDanmakuHit(entry, { keyword, text, user, count });
}

/**
 * 检测通知：ID 为派生 ID（房间复合键 + _watch 后缀），与开播通知并存、同一房间重复触发
 * 复用同一 ID → 通知中心覆盖而非堆积；点击进入直播间（沿用开播通知行为，
 * ID 解析见 getLiveUrlFromNotificationId）。
 * 不受开播通知总开关（settings.notificationsEnabled）影响：检测有独立的启用开关与检测词配置，
 * 开了检测就是要这条通知。
 */
async function notifyDanmakuHit(entry, { keyword, text, user, count }) {
  const body = user ? `${user}：${truncateDanmu(text)}` : truncateDanmu(text);
  try {
    await chrome.notifications.create(`${entry.key}${WATCH_NOTIFICATION_SUFFIX}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${platformLabel(entry.platform)} ${entry.nickname} 弹幕命中！`,
      message: body,
      contextMessage: `${entry.config.windowMinutes} 分钟内「${keyword}」命中 ${count} 次`,
      buttons: [{ title: '进入直播间' }],
      priority: 2
    });
  } catch (e) {
    console.error('检测通知创建失败:', e);
  }
}

/** 通知标题的平台前缀（与 popup / 设置页的平台标签一致） */
function platformLabel(platform) {
  return platform === 'bilibili' ? '[B站]' : '[斗鱼]';
}

/** 通知正文里的弹幕文本截断（过长会被系统截断成不可读） */
function truncateDanmu(text) {
  const str = String(text || '');
  return str.length > 60 ? `${str.slice(0, 60)}…` : str;
}

// === 核心轮询逻辑 ===
async function refreshRooms() {
  const rooms = await StorageHelper.get('rooms');
  if (!rooms || rooms.length === 0) {
    await syncDanmakuWatch(); // 房间清空 → 断开全部检测连接
    return; // 未配置房间号，跳过
  }

  const douyuRooms = rooms.filter(r => r.platform === 'douyu');
  const bilibiliRooms = rooms.filter(r => r.platform === 'bilibili');
  const douyuIds = douyuRooms.map(r => r.roomId);
  const bilibiliIds = bilibiliRooms.map(r => r.roomId);

  const [douyuResult, bilibiliResult] = await Promise.all([
    douyuIds.length > 0
      ? DouyuAPI.batchFetchRoomInfo(douyuIds)
      : { success: true, data: [] },
    bilibiliIds.length > 0
      ? BilibiliAPI.batchFetchRoomInfo(bilibiliIds)
      : { success: true, data: [] }
  ]);

  // 合并 API 成功数据与上一次状态（API 失败的房间保留旧数据）
  const prevStreamers = (await StorageHelper.get('streamers')) || [];
  const prevMap = {};
  prevStreamers.forEach(s => {
    prevMap[`${s.platform}_${s.roomId}`] = s;
  });
  const prevOnline = new Set(
    prevStreamers.filter(s => s.online).map(s => `${s.platform}_${s.roomId}`)
  );

  // 按 roomId 索引 API 成功返回的结果
  const apiData = new Map();
  douyuResult.data.forEach(d => apiData.set(`douyu_${d.roomId}`, { ...d, platform: 'douyu' }));
  bilibiliResult.data.forEach(d => apiData.set(`bilibili_${d.roomId}`, { ...d, platform: 'bilibili' }));

  // 逐个房间合并：API 成功取新数据，失败保留旧数据
  const mergedData = [];
  for (const room of rooms) {
    const key = `${room.platform}_${room.roomId}`;
    const fresh = apiData.get(key);
    let item;
    if (fresh) {
      item = { ...fresh };
    } else if (prevMap[key]) {
      item = { ...prevMap[key] };
    } else {
      continue;
    }
    // 传递 per-room 通知标记
    item.notify = room.notify === true;
    // 透传弹幕推送的贵宾数/高能榜在线数（API 不返回该字段，避免被轮询覆盖）
    if (prevMap[key] && typeof prevMap[key].vipCount === 'number') {
      item.vipCount = prevMap[key].vipCount;
    }
    if (prevMap[key] && typeof prevMap[key].rankCount === 'number') {
      item.rankCount = prevMap[key].rankCount;
    }
    // 连续两轮确认离线 → 清空上一场的观众数存量：popup 不再显示旧值，
    // 观众数提醒也随之重新武装（B站未开播不上报高能榜，不清空则下一场旧值仍 ≥ 阈值，
    // 永远没有上升边沿）。两轮而非一轮：防单次 API 抖动误判离线导致同场重复提醒。
    if (item.online === false && prevMap[key] && prevMap[key].online === false) {
      delete item.vipCount;
      delete item.rankCount;
    }
    mergedData.push(item);
  }

  if (mergedData.length === 0) {
    await syncDanmakuWatch();
    return;
  }

  await StorageHelper.set('streamers', mergedData);
  await StorageHelper.set('lastRefresh', Date.now());

  const onlineCount = mergedData.filter(s => s.online).length;
  chrome.action.setBadgeText({ text: onlineCount > 0 ? String(onlineCount) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF4400' });

  // 开播门控：按刚写回的开播快照收敛检测长连接（开播建连、下播断开并清空计数）
  await syncDanmakuWatch();

  const isFirstRun = (await StorageHelper.get('_firstRun')) === true;
  if (isFirstRun) {
    const onlineEntries = mergedData.filter(s => s.online).map(s => ({
      roomId: s.roomId,
      platform: s.platform
    }));
    await StorageHelper.set('notifiedRooms', onlineEntries);
    await StorageHelper.set('_firstRun', null);
  } else {
    const settings = await StorageHelper.get('settings');
    if (settings?.notificationsEnabled !== false) {
      await checkNewLiveStreams(mergedData, prevOnline);
    }
  }
}

// 数字格式化：>= 1 万显示 x.x万，否则原样（与 popup 保持一致）
function formatNumber(num) {
  if (num >= 10000) {
    return (num / 10000).toFixed(1) + '万';
  }
  return String(num);
}

// === 观众数提醒（复用 10 分钟采样的上升边沿，见 ADR-0002）===
// 判定时机是「值到达时」（updateVipCount / updateRankCount），零新增连接——数据就是采样结果本身。
// 依次全通过才发提醒：全局总开关 → 该平台观众数开关（联动：关闭即不判定，配置保留）
// → 该房 viewerAlert 配置 → 上升边沿（值从阈值以下升到阈值以上）。

/**
 * 观众数提醒判定入口（两个平台的值到达处共用）
 * @param {'douyu'|'bilibili'} platform
 * @param {string} roomId
 * @param {{prevValue?: number, nextValue: number, streamer?: object}} data 上一次/本次观众数与房间快照
 * @returns {Promise<boolean>} 是否发了提醒
 */
async function evaluateViewerAlert(platform, roomId, { prevValue, nextValue, streamer }) {
  if (!VIEWER_METRICS[platform]) {
    return false;
  }
  const [settings, rooms] = await Promise.all([
    StorageHelper.get('settings'),
    StorageHelper.get('rooms')
  ]);
  if (!isViewerAlertEnabled(settings)) {
    return false; // 总开关关闭：配置保留、不判定
  }
  if (!(await isViewerFetchEnabled(platform))) {
    return false; // 平台观众数开关关闭：拿不到数值，配置保留、不判定
  }
  const room = (rooms || []).find(r => r.platform === platform && String(r.roomId) === String(roomId));
  const config = normalizeViewerAlert(room?.viewerAlert);
  if (!config) {
    return false; // 该房未启用观众数提醒
  }
  if (!isViewerAlertCrossed(prevValue, nextValue, config.threshold)) {
    return false;
  }
  await notifyViewerAlert(platform, { roomId: String(roomId), nickname: room.nickname || '' }, nextValue, config.threshold, streamer);
  return true;
}

/**
 * 观众数提醒：ID 为派生 ID（房间复合键 + _viewer 后缀），与开播通知 / 检测通知并存，
 * 同一房间重复触发复用同一 ID → 通知中心覆盖而非堆积；点击进入直播间
 * （ID 解析见 getLiveUrlFromNotificationId）。
 * 不受开播通知总开关（settings.notificationsEnabled）影响：只受自己的总开关
 * （settings.viewerAlertEnabled）与该平台观众数开关约束。
 */
async function notifyViewerAlert(platform, { roomId, nickname }, value, threshold, streamer) {
  const meta = VIEWER_METRICS[platform];
  try {
    await chrome.notifications.create(`${platform}_${roomId}${VIEWER_ALERT_NOTIFICATION_SUFFIX}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${platformLabel(platform)} ${nickname} ${meta.label}超过 ${threshold}！`,
      message: streamer?.title || '正在直播',
      contextMessage: `当前 ${formatNumber(value)} ${meta.shortLabel}`,
      buttons: [{ title: '进入直播间' }],
      priority: 2
    });
  } catch (e) {
    console.error('观众数提醒创建失败:', e);
  }
}

// === 新开播通知 ===
async function checkNewLiveStreams(currentStreamers, prevOnlineSet) {
  const rawNotified = (await StorageHelper.get('notifiedRooms')) || [];
  const notifiedMap = new Set(
    rawNotified.map(n => `${n.platform}_${n.roomId}`)
  );

  for (const streamer of currentStreamers) {
    if (!streamer.online) continue;
    if (streamer.notify !== true) continue;  // 跳过用户设置了不通知的房间

    const compositeKey = `${streamer.platform}_${streamer.roomId}`;
    const isNewlyLive = !prevOnlineSet.has(compositeKey);
    const alreadyNotified = notifiedMap.has(compositeKey);

    if (isNewlyLive && !alreadyNotified) {
      const platformPrefix = platformLabel(streamer.platform);
      // 统计文案按平台区分：斗鱼显示贵宾数（弹幕推送），B站显示高能榜在线数（弹幕推送）
      const statText = streamer.platform === 'bilibili'
        ? (typeof streamer.rankCount === 'number' && streamer.rankCount > 0
          ? `${formatNumber(streamer.rankCount)} 高能榜`
          : '')
        : (typeof streamer.vipCount === 'number' && streamer.vipCount > 0
          ? `${formatNumber(streamer.vipCount)} 贵宾`
          : '');
      try {
        await chrome.notifications.create(compositeKey, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: `${platformPrefix} ${streamer.nickname} 开播了！`,
          message: streamer.title || '正在直播',
          contextMessage: [streamer.category, statText].filter(Boolean).join(' · '),
          buttons: [{ title: '进入直播间' }],
          priority: 2
        });
        notifiedMap.add(compositeKey);
      } catch (e) {
        console.error('通知创建失败:', e);
      }
    }
  }

  const onlineKeys = new Set(
    currentStreamers
      .filter(s => s.online && s.notify === true)
      .map(s => `${s.platform}_${s.roomId}`)
  );
  const updatedNotified = rawNotified.filter(n =>
    onlineKeys.has(`${n.platform}_${n.roomId}`)
  );
  await StorageHelper.set('notifiedRooms', updatedNotified);
}

// === 通知按钮点击 ===
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    const url = getLiveUrlFromNotificationId(notificationId);
    if (url) chrome.tabs.create({ url });
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const url = getLiveUrlFromNotificationId(notificationId);
  if (url) chrome.tabs.create({ url });
});

// 通知 ID 与直播间的对应：开播通知为 `platform_roomId`，检测通知 `_watch`、
// 观众数提醒 `_viewer` 为派生 ID（房间号恒为纯数字，去掉后缀后复用同一套 URL 规则）
function getLiveUrlFromNotificationId(notificationId) {
  let baseId = notificationId;
  for (const suffix of NOTIFICATION_ID_SUFFIXES) {
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

// === 消息处理 ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'MANUAL_REFRESH':
      refreshRooms().then(() => sendResponse({ ok: true }));
      return true;

    case 'SETTINGS_UPDATED':
      // 重建轮询 alarm，重新同步弹幕客户端状态，并立即采样一次（开关即时生效）
      createAlarm().then(() => syncViewerSettings()).then(() => sampleViewerCounts())
        .then(() => sendResponse({ ok: true }));
      return true;

    case 'ADD_ROOM':
      handleAddRoom(message.roomId, message.platform).then(sendResponse);
      return true;

    case 'REMOVE_ROOM':
      handleRemoveRoom(message.roomId, message.platform).then(sendResponse);
      return true;

    // 页面通道（content script）回传的高能榜在线数
    case 'BILI_RANK_COUNT':
      updateRankCount({ roomId: message.roomId, rankCount: message.rankCount })
        .then(() => sendResponse({ ok: true }));
      return true;

    // 页面通道（content script）回传的弹幕文本 → 检测计数
    case 'BILI_DANMU':
      handleDanmu('bilibili', { roomId: message.roomId, text: message.text, user: message.user })
        .then(() => sendResponse({ ok: true }));
      return true;

    // 房间检测配置变更（设置页行内面板）→ 先重做通道决策（B站页面桥接 / SW 直连），
    // 再按最新配置收敛盯守连接：只开检测、观众数开关关闭时也要走对通道
    case 'WATCH_CONFIG_UPDATED':
      syncViewerSettings().then(() => syncDanmakuWatch()).then(() => sendResponse({ ok: true }));
      return true;

    // 桥接页本轮采样完成/超时 → 关闭桥接标签页（消息事件可靠唤醒休眠中的 SW，
    // 避免采样流程在 SW 侧长时间等待导致空闲被终止）；
    // 检测长连接常驻在桥接页时不得关页（采样完成只结束采样，盯守继续）
    case 'BILI_SAMPLE_DONE':
      if (!hasBiliWatch()) {
        biliBridge.close().catch(() => { });
      }
      sendResponse({ ok: true });
      return true;

    default:
      sendResponse({ ok: false });
  }
});

// === 房间管理 ===
async function handleAddRoom(rawRoomId, platform) {
  const roomId = rawRoomId?.trim();
  if (!roomId || !/^\d+$/.test(roomId)) {
    return { ok: false, error: '房间号格式无效' };
  }
  platform = platform || 'douyu';

  // 检查是否已存在（同平台+同房间号）
  const rooms = (await StorageHelper.get('rooms')) || [];
  if (rooms.some(r => r.roomId === roomId && r.platform === platform)) {
    return { ok: false, error: '该房间已在监控列表中' };
  }

  // 根据平台选择 API
  let api = platform === 'bilibili' ? BilibiliAPI : DouyuAPI;
  let resolveResult = await api.resolveNickname(roomId);

  // 如果所选平台解析失败，自动尝试另一个平台（兜底）
  if (!resolveResult.success) {
    const otherPlatform = platform === 'bilibili' ? 'douyu' : 'bilibili';
    const otherApi = otherPlatform === 'bilibili' ? BilibiliAPI : DouyuAPI;
    const otherResult = await otherApi.resolveNickname(roomId);
    if (otherResult.success) {
      platform = otherPlatform;
      resolveResult = otherResult;
    }
  }

  if (!resolveResult.success) {
    return { ok: false, error: '房间号不存在或无法访问' };
  }

  // 添加到列表
  rooms.push({ roomId, nickname: resolveResult.nickname, platform, notify: false });
  await StorageHelper.set('rooms', rooms);

  const notified = (await StorageHelper.get('notifiedRooms')) || [];
  if (!notified.some(n => n.roomId === roomId && n.platform === platform)) {
    notified.push({ roomId, platform });
    await StorageHelper.set('notifiedRooms', notified);
  }

  await refreshRooms();
  await syncViewerSettings();
  // 立即采样一次观众数，不用等下一个 10 分钟周期
  await sampleViewerCounts();

  return { ok: true, nickname: resolveResult.nickname };
}

async function handleRemoveRoom(roomId, platform) {
  platform = platform || 'douyu';
  let rooms = (await StorageHelper.get('rooms')) || [];
  rooms = rooms.filter(r => !(r.roomId === roomId && r.platform === platform));
  await StorageHelper.set('rooms', rooms);

  // 也从 streamers 中移除
  let streamers = (await StorageHelper.get('streamers')) || [];
  streamers = streamers.filter(s => !(s.roomId === roomId && s.platform === platform));
  await StorageHelper.set('streamers', streamers);

  // Update badge
  const onlineCount = streamers.filter(s => s.online).length;
  chrome.action.setBadgeText({ text: onlineCount > 0 ? String(onlineCount) : '' });

  // 移除房间后重新收敛检测连接（该房若在盯守则断开并清空计数）
  await syncDanmakuWatch();

  await syncViewerSettings();
  // 移除房间后立即采样，刷新剩余房间的观众数
  await sampleViewerCounts();

  return { ok: true };
}
