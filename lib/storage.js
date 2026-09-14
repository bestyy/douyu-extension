// lib/storage.js — chrome.storage.local 的两个 adapter
//
// 房间库（lib/room-store.js）要的是**多键存储 port** `{ get(keys), set(entries) }`；
// 编排（lib/orchestrator.js）与桥接通道（lib/bili-bridge-channel.js）要的是**单键键值 port**
// `{ get(key), set(key, value) }`，各自只写自己声明的键（见 ADR-0003）。
//
// rooms / streamers / settings 三个键的形状、默认值与迁移不在这里——那是房间库的事
// （RoomStore.DEFAULTS）。本文件只剩 chrome 的一层薄适配，便于测试用内存实现替换。
// UMD 双兼容：SW 经 importScripts 加载，node 下可 require（设置页/弹窗按需加载）。

/** 多键存储 port（房间库用）：一次读写多个键 */
const chromeStoragePort = {
  async get(keys) {
    return await chrome.storage.local.get(keys);
  },
  async set(entries) {
    await chrome.storage.local.set(entries);
  }
};

/** 单键键值 port（编排的非房间键、桥接通道的通道标记用） */
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
  }
};

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StorageHelper, chromeStoragePort };
}
