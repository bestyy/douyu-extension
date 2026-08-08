// lib/bili-bridge-channel.js — B站弹幕页面桥接通道（深 module）
//
// 单一职责：管理「B站页面桥接通道」这一个概念的全部状态与编排——
//   sync()            通道决策：观众数开关 / 房间列表有无 B站 / 登录态 / 持久化降级标记 → 产出通道状态
//   sample(roomIds)   页面通道采样：打开（或复用）桥接标签页并驱动一轮采样
//   close()           关闭桥接标签页（采样完成/超时、关开关、无 B站房间时调用）
//   enableFallback()  SW 直连采样被风控 → 置内存标记 + 持久化 + 日志（编排由 background 完成）
//   enabled getter    background 读此结果做采样分支（页面桥接 vs SW 直连）
//
// 背景：登录态（SESSDATA Cookie）下 SW 直连的弹幕 WS 握手必被 1006 风控，需桥接标签页在
// 页面上下文建连（content script：lib/bilibili-page-bridge.js，仅 URL 带 ?dyext=1 激活）。
// 两通道均为 10 分钟采样节奏：临时开页 → 拿到数据即关闭，平时零 WS 连接、无常驻页面。
//
// 依赖全部构造注入（storage / tabs / isLoggedIn），不引用 chrome 全局，可在 node 下测试。
// UMD 双兼容：SW 经 importScripts 加载（module 未定义自动跳过），node 下可 require。

class BiliBridgeChannel {
  /**
   * @param {object} options
   * @param {{ get(key): Promise<any>, set(key, value): Promise<void> }} options.storage 存储（StorageHelper 接口）
   * @param {{ query: Function, create: Function, remove: Function, reload: Function, sendMessage: Function }} options.tabs 标签页 API（chrome.tabs 接口）
   * @param {() => Promise<boolean>} options.isLoggedIn B站登录态检测（background 的 isBiliLoggedIn）
   * @param {number} [options.waitReadyAttempts=15] 等待桥接页就绪的最大重试次数
   * @param {number} [options.waitReadyInterval=1000] 等待桥接页就绪的重试间隔（ms）
   */
  constructor({ storage, tabs, isLoggedIn, waitReadyAttempts = 15, waitReadyInterval = 1000 }) {
    this._storage = storage;
    this._tabs = tabs;
    this._isLoggedIn = isLoggedIn;
    this._waitReadyAttempts = waitReadyAttempts;
    this._waitReadyInterval = waitReadyInterval;

    this._enabled = false; // 页面通道启用标记（内存态，每次 sync() 重新决策；持久化键见 sync）
    this._ensurePromise = null; // 并发去重：alarm 采样与设置变更可能同时触发创建
  }

  /** 桥接标签页标记 URL（仅此 URL 激活 content script） */
  static get BRIDGE_TAB_URL() {
    return 'https://live.bilibili.com/?dyext=1';
  }

  /** 页面通道当前是否启用（background 采样分支据此选择页面桥接 / SW 直连） */
  get enabled() {
    return this._enabled;
  }

  /**
   * 同步通道状态：查询「观众数开关 / 房间列表有无 B站 / 登录态 / 持久化降级标记」，
   * 产出通道状态（enabled）并处理副作用（清观众数 / 关桥接页 / 持久化 / 切换日志）。
   * 通道决策：
   *   - 关闭观众数开关 → 停用通道 + 清 streamers 的 vipCount/rankCount + 关桥接页
   *   - 无 B站房间 → 停用通道 + 关桥接页（但不清 streamers：斗鱼贵宾数仍有效）
   *   - 有 B站房间 → 登录态（SESSDATA）下 SW 直连握手必被 1006 风控，必须走页面桥接；
   *     未登录时 SW 直连可用，但持久化的降级标记（未登录时被风控降级过）在 SW 重启后
   *     继续生效，与登录检测共同决定通道。
   */
  async sync() {
    const settings = await this._storage.get('settings');
    const viewerEnabled = settings?.fetchViewerCount !== false;
    const rooms = (await this._storage.get('rooms')) || [];
    const hasBili = rooms.some(r => r.platform === 'bilibili');

    if (!viewerEnabled) {
      // 关闭观众数获取：清除已存观众数，停用页面通道并关闭桥接标签页
      this._enabled = false;
      await this._storage.set('biliPageChannelEnabled', false);
      await this._stripViewerCounts();
      await this.close();
      return;
    }
    if (!hasBili) {
      // 无 B站房间：停用页面通道并关闭桥接标签页（斗鱼采样不受影响）
      this._enabled = false;
      await this._storage.set('biliPageChannelEnabled', false);
      await this.close();
      return;
    }
    // 有 B站房间：通道选择 —— 登录态下 SW 直连必被风控，走页面桥接；
    // 未登录时 SW 直连可用，持久化的降级标记（未登录时被风控降级过）在 SW 重启后
    // 继续生效，与登录检测共同决定通道。
    // 两种通道均为采样节奏（每 10 分钟一次）：页面通道每次采样临时打开桥接标签页，
    // 拿到数据即关闭，不保留常驻页面与长连接（见 sample）。
    const useBridge = (await this._isLoggedIn()) ||
      (await this._storage.get('biliPageChannelEnabled')) === true;
    if (useBridge !== this._enabled) {
      this._enabled = useBridge;
      await this._storage.set('biliPageChannelEnabled', useBridge);
      console.log(`[bili] 通道切换为 ${useBridge ? '页面桥接' : 'SW 直连'}`);
    }
    if (!useBridge) {
      // 未启用页面通道：清理可能残留的桥接标签页（旧版常驻页面/采样异常遗留）
      await this.close();
    }
  }

  /**
   * 页面通道采样：打开（或复用）桥接标签页并驱动一轮采样。
   * fire-and-forget 语义：_ensureTab → _waitReady → sendMessage BILI_SAMPLE_ROOMS；
   * 未就绪或发送失败 → 日志 + close()。不等待完成信号（采样完成/超时由桥接页发
   * BILI_SAMPLE_DONE，background 收到后调 close）。
   */
  async sample(roomIds) {
    const tabId = await this._ensureTab();
    const ready = await this._waitReady(tabId);
    if (!ready) {
      console.warn('[bili] 桥接页长时间未就绪, 本轮跳过');
      await this.close();
      return;
    }
    try {
      await this._tabs.sendMessage(tabId, { type: 'BILI_SAMPLE_ROOMS', roomIds });
    } catch (e) {
      console.warn('[bili] 驱动桥接页采样失败, 本轮跳过');
      await this.close();
    }
  }

  /** 关闭桥接标签页（只关 dyext=1 标记页，用户自己打开的 B站页面不动） */
  async close() {
    const tabs = await this._tabs.query({ url: 'https://live.bilibili.com/*' });
    for (const tab of tabs) {
      if (tab.url && tab.url.includes('dyext=1')) {
        this._tabs.remove(tab.id).catch(() => {});
      }
    }
  }

  /**
   * SW 直连采样被风控（本轮全败且快速断开）→ 降级到页面通道。
   * 只做模块内职责：置内存标记 + 持久化 + 日志；停止 SW 直连客户端与发通知
   * 属 background 编排（onFallback 回调），不在此处理。
   */
  async enableFallback() {
    const settings = await this._storage.get('settings');
    if (this._enabled || settings?.fetchViewerCount === false) {
      return;
    }
    this._enabled = true;
    await this._storage.set('biliPageChannelEnabled', true); // 持久化，SW 重启后仍走页面通道
    console.warn('[bili] SW 直连采样被风控，切换到页面通道');
  }

  // 清除 streamers 中的观众数字段（关闭开关时调用，避免 popup 显示过期数据）
  async _stripViewerCounts() {
    const streamers = (await this._storage.get('streamers')) || [];
    if (!streamers.some(s => 'vipCount' in s || 'rankCount' in s)) {
      return;
    }
    const cleaned = streamers.map(s => {
      const { vipCount, rankCount, ...rest } = s;
      return rest;
    });
    await this._storage.set('streamers', cleaned);
  }

  // 确保桥接标签页存在（优先复用已打开的，否则自动创建，不抢焦点）
  async _ensureTab() {
    if (this._ensurePromise) {
      return this._ensurePromise; // 进行中的创建/检测共享同一次结果，避免重复弹出标签页
    }
    this._ensurePromise = this._ensureTabInner().finally(() => { this._ensurePromise = null; });
    return this._ensurePromise;
  }

  async _ensureTabInner() {
    const tabs = await this._tabs.query({ url: 'https://live.bilibili.com/*' });
    const existing = tabs.find(t => t.url && t.url.includes('dyext=1'));
    if (existing) {
      // 扩展重载后旧页面的 content script 会失效（chrome.runtime 断开），消息无人响应；
      // ping 检测存活，无响应则刷新页面重新注入
      try {
        await this._tabs.sendMessage(existing.id, { type: 'BILI_PING' });
      } catch (e) {
        console.warn('[bili] 桥接页 content script 未响应, 刷新重新注入');
        await this._tabs.reload(existing.id);
      }
      await this._dedupeTabs();
      return existing.id;
    }
    const tab = await this._tabs.create({ url: BiliBridgeChannel.BRIDGE_TAB_URL, active: false });
    await this._dedupeTabs();
    return tab.id;
  }

  // 清理多余的桥接标签页：扩展重载瞬间新旧 SW 交替时，旧 SW 的创建请求可能已经发出，
  // 导致残留两个 dyext=1 页面（内存锁无法跨 SW 实例生效），统一保留第一个
  async _dedupeTabs() {
    const tabs = await this._tabs.query({ url: 'https://live.bilibili.com/*' });
    const bridges = tabs.filter(t => t.url && t.url.includes('dyext=1'));
    for (const extra of bridges.slice(1)) {
      console.warn(`[bili] 发现多余桥接标签页 tabId=${extra.id}, 关闭`);
      this._tabs.remove(extra.id).catch(() => {});
    }
  }

  // 等待桥接页 content script 就绪（新建/刷新后注入需要时间），返回是否就绪
  async _waitReady(tabId) {
    for (let i = 0; i < this._waitReadyAttempts; i++) {
      try {
        await this._tabs.sendMessage(tabId, { type: 'BILI_PING' });
        return true;
      } catch (e) {
        await new Promise(resolve => setTimeout(resolve, this._waitReadyInterval));
      }
    }
    return false;
  }
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BiliBridgeChannel };
}
