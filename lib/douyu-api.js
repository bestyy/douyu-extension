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
   * 查询单个房间的看点列表（平台 AI 切出的精彩片段，整场全量）
   * sort:0 = 时间排序；匿名可用、不需要 Cookie，与 fetchRoomInfo 同一套超时与错误模型。
   * 字段收敛在本层完成：只留判定与通知要用的五个字段，编号非有限数字的条目直接丢弃
   * （规则 module 也不认这类条目，见 lib/highlight-alert.js）。
   * @param {string} roomId
   * @returns {Promise<{success: boolean, data?: {highlights: Array}, error?: string}>}
   *          highlights 每项 { highlightId, title, startTime, endTime, heat }
   */
  async fetchHighlights(roomId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${API_BASE}/wgapi/vodnc/center/ailive/getHighlightDetail`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({ rid: parseInt(roomId, 10), sort: 0 })
      });
      clearTimeout(timeout);

      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        return { success: false, error: 'parse_error' };
      }

      // error 非 0 或没有 data：拿不到「整场全量列表」这个前提，一律当失败（不写水位）
      if (result.error !== 0 || !result.data) {
        return { success: false, error: 'room_unavailable' };
      }

      const list = Array.isArray(result.data.highlightList) ? result.data.highlightList : [];
      return {
        success: true,
        data: {
          highlights: list.filter(item => item && Number.isFinite(item.highlightId)).map(item => ({
            highlightId: item.highlightId,
            title: String(item.title ?? ''),
            startTime: Number(item.startTime) || 0,
            endTime: Number(item.endTime) || 0,
            heat: Number(item.heat) || 0
          }))
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
