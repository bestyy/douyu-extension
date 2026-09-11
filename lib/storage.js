// lib/storage.js — chrome.storage.local 封装

const StorageHelper = {
  /**
   * 获取存储的值
   * @param {string} key
   * @returns {Promise<any>}
   */
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  },

  /**
   * 设置存储的值
   * @param {string} key
   * @param {any} value
   */
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },

  /**
   * 获取全部存储数据
   * @returns {Promise<object>}
   */
  async getAll() {
    return await chrome.storage.local.get(null);
  },

  /**
   * 清空存储
   */
  async clear() {
    await chrome.storage.local.clear();
  },

  /**
   * 迁移旧格式数据到新格式
   * v1.0.0→v1.1.0: notifiedRooms 从 string[] 迁移为 {roomId, platform}[]
   *                rooms/streamers 从无 platform 字段迁移为有 platform 字段
   * @returns {Promise<boolean>} 是否进行了迁移
   */
  async migrateLegacyFormat() {
    let changed = false;
    const all = await this.getAll();

    // 迁移 rooms: 旧格式无 platform 字段
    if (Array.isArray(all.rooms)) {
      let migrated = false;
      const newRooms = all.rooms.map(r => {
        if (typeof r === 'object' && r.roomId && !r.platform) {
          migrated = true;
          return { ...r, platform: 'douyu' };
        }
        return r;
      });
      if (migrated) {
        await this.set('rooms', newRooms);
        changed = true;
      }
    }

    // 迁移 streamers: 旧格式无 platform 字段
    if (Array.isArray(all.streamers)) {
      let migrated = false;
      const newStreamers = all.streamers.map(s => {
        if (typeof s === 'object' && s.roomId && !s.platform) {
          migrated = true;
          return { ...s, platform: 'douyu' };
        }
        return s;
      });
      if (migrated) {
        await this.set('streamers', newStreamers);
        changed = true;
      }
    }

    // 迁移 notifiedRooms: 旧格式是 string[]
    if (Array.isArray(all.notifiedRooms) && all.notifiedRooms.length > 0) {
      const first = all.notifiedRooms[0];
      if (typeof first === 'string') {
        const newNotified = all.notifiedRooms.map(id => ({
          roomId: id,
          platform: 'douyu'
        }));
        await this.set('notifiedRooms', newNotified);
        changed = true;
      }
    }

    return changed;
  }
};

const DEFAULT_STORAGE = {
  // rooms[].watch 为可选的弹幕检测配置 { enabled, keywords[], threshold, windowMinutes, cooldownMinutes }，
  // 缺字段/未启用/检测词为空视为未配置（不建连接不报错，无需数据迁移）
  // rooms[].viewerAlert 为可选的观众数提醒配置 { enabled, threshold }，同理缺字段视为未配置
  rooms: [],   // { roomId, nickname, platform, notify?: boolean, watch?: object, viewerAlert?: object }
  streamers: [],
  lastRefresh: 0,
  notifiedRooms: [],
  watchQueued: [], // 因并发上限暂未盯守的在线房间（轮询重建的易失视图，供 popup 提示）
  settings: {
    refreshInterval: 60,
    notificationsEnabled: true,
    viewerAlertEnabled: true, // 观众数提醒总开关（缺字段视为开启）
    openInCurrentTab: false,
    // 观众数开关自 v1.x 起按平台拆分：新字段优先，未写入时回退旧总开关 fetchViewerCount 语义
    fetchDouyuViewerCount: true,
    fetchBilibiliViewerCount: true,
    fetchViewerCount: true   // 旧总开关（读取兼容回退，新版本保存时删除）
  }
};

// 通过 importScripts 加载，全局可用
