// lib/douyu-api.js — 斗鱼 API 封装（公开 API，无需 Cookie）

const API_BASE = 'https://www.douyu.com';

const DouyuAPI = {
  /**
   * 查询单个房间的直播信息
   * 使用公开 API，不需要 Cookie
   * @param {string} roomId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async fetchRoomInfo(roomId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${API_BASE}/betard/${roomId}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      clearTimeout(timeout);

      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        return { success: false, error: 'parse_error' };
      }

      // /betard/ 返回 JSON 时，room 字段存在表示房间有效；不存在则返回 HTML
      const d = result.room;
      if (!d) {
        return { success: false, error: 'room_not_found' };
      }

      return {
        success: true,
        data: {
          roomId: String(d.room_id || roomId),
          nickname: d.owner_name || d.nickname || '',
          title: d.room_name || '',
          online: (d.show_status === 1 || d.show_status === '1') && d.videoLoop !== 1,
          coverUrl: d.room_src
            ? (d.room_src.startsWith('http') ? d.room_src
               : d.room_src.startsWith('//') ? `https:${d.room_src}`
               : `https://rpic.douyucdn.cn/${d.room_src.replace(/^\//, '')}`)
            : '',
          avatarUrl: d.owner_avatar || (typeof d.avatar === 'object' ? d.avatar.big : '') || '',
          viewers: parseInt(d.room_biz_all?.hot, 10) || 0,
          category: d.cate_name || result.game?.tag_name || result.column?.cate_name || '',
          startTime: d.show_time ? parseInt(d.show_time, 10) * 1000 : 0
        }
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { success: false, error: 'timeout' };
      }
      return { success: false, error: 'network_error', message: err.message };
    }
  },

  /**
   * 批量查询多个房间的直播状态（并行）
   * @param {string[]} roomIds
   * @returns {Promise<{success: boolean, data: Array, errors: Array}>}
   */
  async batchFetchRoomInfo(roomIds) {
    if (!roomIds || roomIds.length === 0) {
      return { success: true, data: [], errors: [] };
    }

    const results = await Promise.allSettled(
      roomIds.map(id => this.fetchRoomInfo(id))
    );

    const data = [];
    const errors = [];

    results.forEach((r, index) => {
      if (r.status === 'fulfilled' && r.value.success) {
        data.push(r.value.data);
      } else if (r.status === 'fulfilled') {
        errors.push({ roomId: roomIds[index], error: r.value.error });
      } else {
        errors.push({ roomId: roomIds[index], error: r.reason?.message || String(r.reason || 'unknown') });
      }
    });

    return { success: data.length > 0, data, errors };
  },

  /**
   * 根据房间号解析主播名（添加房间时使用）
   * @param {string} roomId
   * @returns {Promise<{success: boolean, nickname?: string, error?: string}>}
   */
  async resolveNickname(roomId) {
    const result = await this.fetchRoomInfo(roomId);
    if (result.success) {
      return { success: true, nickname: result.data.nickname };
    }
    return { success: false, error: result.error };
  }
};
