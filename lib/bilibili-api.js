// lib/bilibili-api.js — Bilibili 公开 API 封装

const BILIBILI_LIVE_API = 'https://api.live.bilibili.com';

const BilibiliAPI = {
  /**
   * 查询单个房间的直播信息
   * 使用 Bilibili 公开 API，无需 Cookie
   * @param {string} roomId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async fetchRoomInfo(roomId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      // Step 1: 获取房间基本信息
      const roomResp = await fetch(
        `${BILIBILI_LIVE_API}/room/v1/Room/get_info?room_id=${roomId}`,
        {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }
      );

      if (!roomResp.ok) {
        clearTimeout(timeout);
        return { success: false, error: 'http_error' };
      }

      const roomData = await roomResp.json();
      clearTimeout(timeout);

      if (roomData.code !== 0 || !roomData.data) {
        return { success: false, error: 'room_not_found' };
      }

      const d = roomData.data;
      const uid = d.uid;

      // Step 2: 获取主播个人信息（昵称、头像）
      let nickname = '';
      let avatarUrl = '';

      if (uid) {
        try {
          const userResp = await fetch(
            `${BILIBILI_LIVE_API}/live_user/v1/UserInfo/get_uid_info?uid=${uid}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
              }
            }
          );
          if (userResp.ok) {
            const userData = await userResp.json();
            if (userData.code === 0 && userData.data) {
              nickname = userData.data.uname || '';
              avatarUrl = userData.data.face || '';
            }
          }
        } catch (e) {
          // 用户信息获取失败时，使用 room info 中的字段兜底
        }
      }

      // 兜底：从 room info 拿主播名
      if (!nickname) {
        nickname = d.uname || '';
      }

      return {
        success: true,
        data: {
          roomId: String(d.room_id || roomId),
          nickname: nickname,
          platform: 'bilibili',
          title: d.title || '',
          online: d.live_status === 1,
          coverUrl: d.user_cover || d.keyframe || '',
          avatarUrl: avatarUrl || d.face || '',
          viewers: d.online || 0,
          category: d.parent_area_name || d.area_name || '',
          startTime: d.live_time ? new Date(d.live_time).getTime() : 0
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
