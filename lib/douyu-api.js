// lib/douyu-api.js — 斗鱼 API 封装

const API_BASE = 'https://www.douyu.com';

const DouyuAPI = {
  /**
   * 从 cookie 字符串解析为对象
   * @param {string} cookieString - "key1=val1; key2=val2; ..."
   * @returns {object}
   */
  _parseCookie(cookieString) {
    const result = {};
    cookieString.split(';').forEach(pair => {
      const [key, ...rest] = pair.trim().split('=');
      if (key && rest.length > 0) {
        result[key.trim()] = rest.join('=').trim();
      }
    });
    return result;
  },

  /**
   * 验证 cookie 中是否包含必要字段
   * @param {string} cookieString
   * @returns {{ valid: boolean, missing: string[] }}
   */
  validateCookie(cookieString) {
    const required = ['acf_uid', 'acf_auth', 'acf_biz', 'acf_stk', 'acf_ct', 'acf_ltkid'];
    const parsed = this._parseCookie(cookieString);
    const missing = required.filter(key => !parsed[key]);
    return {
      valid: missing.length === 0,
      missing
    };
  },

  /**
   * 获取关注列表（含直播状态）
   * @param {string} cookieString
   * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
   */
  async fetchFollowList(cookieString) {
    try {
      const response = await fetch(`${API_BASE}/wgapi/livenc/liveweb/follow/list?sort=0&cid1=0`, {
        headers: {
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      const result = await response.json();

      if (result.error !== 0) {
        if (result.error === 1004 || result.error === 1003) {
          return { success: false, error: 'cookie_expired' };
        }
        return { success: false, error: `api_error_${result.error}` };
      }

      // 标准化数据
      const streamers = (result.data?.list || []).map(item => ({
        roomId: String(item.room_id),
        nickname: item.nickname || '',
        title: item.room_name || '',
        online: item.show_status === 1,
        coverUrl: item.room_src || '',
        avatarUrl: item.avatar || '',
        viewers: item.hn || 0,
        category: item.cname2 || item.cname1 || '',
        startTime: item.show_time ? item.show_time * 1000 : 0
      }));

      return { success: true, data: streamers };
    } catch (err) {
      return { success: false, error: 'network_error', message: err.message };
    }
  },

  /**
   * 测试 Cookie 是否有效
   * @param {string} cookieString
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  async testCookie(cookieString) {
    try {
      const response = await fetch(`${API_BASE}/japi/roomuserlevel/apinc/levelInfo?rid=1`, {
        headers: {
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      const result = await response.json();

      if (result.error === 0) {
        return { valid: true };
      }
      return { valid: false, error: 'cookie_invalid' };
    } catch (err) {
      return { valid: false, error: 'network_error' };
    }
  }
};

// 通过 importScripts 加载，全局可用
