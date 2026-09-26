// background.js — Service Worker 入口：装配（composition root）+ chrome 事件接线
//
// 编排在 lib/orchestrator.js（轮询 / 采样 / 盯守 / 通知），四个键的形状与全部变更在
// lib/room-store.js（单写者，见 docs/adr/0003-room-store-single-writer.md）。
// 本文件只做三件事：把 chrome 适配成注入依赖、注册事件、把事件与消息交给编排。

importScripts(
  'lib/room-identity.js',
  'lib/storage.js',
  'lib/danmaku-watch.js',
  'lib/viewer-alert.js',
  'lib/danmaku-surge.js',
  'lib/highlight-alert.js',
  'lib/today-stats.js',
  'lib/room-categories.js',
  'lib/douyu-api.js',
  'lib/bilibili-api.js',
  'lib/doseeing-api.js',
  'lib/douyu-barrage.js',
  'lib/bilibili-barrage.js',
  'lib/bili-bridge-channel.js',
  'lib/room-store.js',
  'lib/orchestrator.js'
);

// === 平台 API adapter（轮询取房间信息 + 新增房间时解析昵称 + 看点取数）===
const apis = {
  douyu: {
    batchFetchRoomInfo: ids => DouyuAPI.batchFetchRoomInfo(ids),
    resolveNickname: id => DouyuAPI.resolveNickname(id),
    // 看点只有斗鱼有这个形态（HIGHLIGHT_PLATFORMS），B站 adapter 不带这个方法
    fetchHighlights: id => DouyuAPI.fetchHighlights(id)
  },
  bilibili: {
    batchFetchRoomInfo: ids => BilibiliAPI.batchFetchRoomInfo(ids),
    resolveNickname: id => BilibiliAPI.resolveNickname(id)
  }
};

// === 今日统计取数 port（第三方数据站 doseeing）===
// 一个模块对一个接口提供方，因此独立成 port，不与 apis.douyu 合并（见 ADR-0007）
const todayStatsApi = {
  fetchTodayStats: id => DoseeingAPI.fetchTodayStats(id)
};

// === 房间库（rooms / streamers / settings / categories 的形状与全部变更）===
const roomStore = new RoomStore({
  storage: chromeStoragePort,
  // 房间标识 module：复合键 / 房间号校验 / 平台事实（零依赖，故它排在所有使用它的 lib 之前）
  identity: RoomIdentity,
  // 分类规则 module：名称校验 / 「未分类」保留名 / 分组回落（房间库只判名与定组，落盘与 id 由它自己生成）
  categoryRules: RoomCategories,
  // 昵称解析 port：把平台 API 的 { success, nickname } 收敛成 { ok, nickname }
  resolveNickname: async (platform, roomId) => {
    const result = await apis[platform].resolveNickname(roomId);
    return result && result.success ? { ok: true, nickname: result.nickname } : { ok: false };
  }
});

// === B站登录态：SESSDATA Cookie 存在即视为已登录 ===
// 登录态下 SW 直连的弹幕 WS 握手携带登录 Cookie，实测必被 1006 风控（未登录时可用），
// 因此登录与否决定 B站采样与检测走页面桥接还是 SW 直连。
async function isBiliLoggedIn() {
  try {
    const cookie = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'SESSDATA' });
    return !!(cookie && cookie.value);
  } catch (e) {
    return false;
  }
}

// === B站页面桥接通道（页面通道的全部状态与编排收在 module 内）===
const biliBridge = new BiliBridgeChannel({
  storage: StorageHelper,
  tabs: chrome.tabs,
  isLoggedIn: isBiliLoggedIn
});

// === 通知 adapter：四种房间通知外形一致（同图标、同「进入直播间」按钮、同优先级）===
const notifier = {
  async create(notificationId, content) {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: content.title,
      message: content.message,
      contextMessage: content.contextMessage,
      buttons: content.buttons === undefined ? [{ title: '进入直播间' }] : content.buttons,
      priority: content.priority === undefined ? 2 : content.priority
    });
    return true;
  },
  setBadge(count) {
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF4400' });
  }
};

// === 弹幕客户端 ===
// 采样短连与盯守长连接各用独立实例（并存属有意设计，见 ADR-0001）：
// 采样模式解析 oni / ONLINE_RANK_COUNT（观众数），盯守模式解析 chatmsg / DANMU_MSG（弹幕文本，
// 同一条长连接同时供给弹幕检测与弹幕激增，见 ADR-0004）。
// 客户端回调指向编排，故先建 clients 壳、构造编排，再回填实例。
// 斗鱼客户端另需一个开播状态 port：采样超时兜底要问一次「该房是否开播」，这个平台事实的
// 唯一实现在 douyu-api（见 CONTEXT.md「开播状态」），此处只做形状收敛（{success, data} → 三态布尔），
// 与 resolveNickname 的收敛位置一致。两个实例共用同一个 port（盯守走长连接、不会走到超时兜底）。
const probeDouyuOnline = async roomId => {
  const result = await DouyuAPI.fetchRoomInfo(roomId);
  return result && result.success ? result.data.online : undefined;
};
const clients = {};
const orchestrator = createOrchestrator({
  store: roomStore,
  keyValue: StorageHelper,
  apis,
  todayStatsApi,
  clients,
  bridge: biliBridge,
  notifier,
  rules: {
    decideViewerAlert,
    isDanmakuWatchEnabled,
    matchKeyword,
    selectWatchPlan,
    hasBiliWatchNeed,
    DanmakuWatchCounter,
    isSurgeAlertEnabled,
    normalizeSurgeSettings,
    SurgeMeter,
    HIGHLIGHT_PLATFORMS,
    isHighlightAlertEnabled,
    selectNewHighlights,
    STATS_PLATFORMS,
    isTodayStatsEnabled,
    selectTodayStatsTargets,
    statsDateKey
  },
  identity: RoomIdentity,
  alarms: chrome.alarms,
  tabs: { create: props => chrome.tabs.create(props) }
});

clients.douyuSample = new BarrageClient({
  probeOnline: probeDouyuOnline,
  onVipCount: data => orchestrator.onViewerCount('douyu', { roomId: data.roomId, value: data.vipCount })
});
clients.bilibiliSample = new BilibiliBarrageClient({
  onRankCount: data => orchestrator.onViewerCount('bilibili', { roomId: data.roomId, value: data.rankCount }),
  onFallback: () => orchestrator.handleBiliChannelFallback()
});
clients.douyuWatch = new BarrageClient({
  probeOnline: probeDouyuOnline,
  onDanmu: data => orchestrator.handleDanmu('douyu', data)
});
clients.bilibiliWatch = new BilibiliBarrageClient({
  onDanmu: data => orchestrator.handleDanmu('bilibili', data)
});

// === chrome 事件接线（事件注册留在这里，名字/消息到域操作的映射在编排里）===
chrome.runtime.onInstalled.addListener(() => {
  orchestrator.onInstalled().catch(e => console.error('初始化失败:', e));
});

chrome.alarms.onAlarm.addListener(alarm => {
  orchestrator.onAlarm(alarm.name).catch(e => console.error('alarm 处理失败:', alarm.name, e));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  orchestrator.onMessage(message)
    .then(sendResponse)
    .catch(e => {
      console.error('消息处理失败:', message && message.type, e);
      sendResponse({ ok: false });
    });
  return true;
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    orchestrator.onNotificationClicked(notificationId);
  }
});

chrome.notifications.onClicked.addListener(notificationId => {
  orchestrator.onNotificationClicked(notificationId);
});

// === 启动：SW 每次唤醒都要重建内存态（通道状态 + 盯守配置）===
orchestrator.start();
