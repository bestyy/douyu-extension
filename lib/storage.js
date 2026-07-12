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
  }
};

const DEFAULT_STORAGE = {
  cookie: {
    value: '',
    lastChecked: 0
  },
  streamers: [],
  lastRefresh: 0,
  notifiedRooms: [],
  settings: {
    refreshInterval: 60,
    notificationsEnabled: true
  }
};

// 通过 importScripts 加载，全局可用
