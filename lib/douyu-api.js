// lib/douyu-api.js — 斗鱼 API 封装（公开 API，无需 Cookie）
//
// 房间号：斗鱼有两种——内部 room_id（接口认的那个）与「靓号」（用户在
// https://www.douyu.com/<号> 地址栏里看到的短号，页面内嵌数据里叫 vipId）。
// betard 接口只认内部 room_id，拿靓号去查会回一页 HTML（被判成 room_not_found）。
// 因此 fetchRoomInfo 直查失败时会把输入号当靓号解析一次（拉房间页取内嵌的 room_id，见 ADR-0015）。
// 对外返回的 data.roomId 始终是调用方传入的那个号（靓号或内部号），不是解析出的内部号：
// 存储与轮询合并都以调用方传入的号为复合键，两者必须对齐（否则快照挂不到房间上）。

const API_BASE = 'https://www.douyu.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 输入号 → 内部 room_id 的解析缓存（只缓存解析成功的映射，SW 实例内有效）。
// 失败不缓存：偶发的网络/风控失败不该把靓号永久判死，下一轮重试即可。
const VANITY_ROOM_ID_CACHE = new Map();

/**
 * 从斗鱼房间页内嵌数据里提取内部 room_id（纯函数，可单测）。
 * 有效房间页内嵌 `{"roomInfo":{"room":{"room_id":<内部号>,"vipId":<靓号或 0>,...`；
 * 无效号页没有 roomInfo。仅当内嵌的内部号或靓号与输入号一致时才认，
 * 免得从无效号页里内嵌的推荐房间数据错取一个别的房间。
 * @param {string} html 房间页 HTML
 * @param {string} enteredId 用户输入的房间号
 * @returns {string|null} 内部 room_id；页面里没有可对应的房间时 null
 */
function extractInternalRoomId(html, enteredId) {
  const match = String(html ?? '').match(
    /"roomInfo\\?"\s*:\s*\{\\?"room\\?"\s*:\s*\{\\?"room_id\\?"\s*:\s*(\d+)\s*,\\?"vipId\\?"\s*:\s*(\d+)/
  );
  if (!match) {
    return null;
  }
  const wanted = String(enteredId);
  const [, roomId, vipId] = match;
  return roomId === wanted || vipId === wanted ? roomId : null;
}

const DouyuAPI = {
  /**
   * 查询单个房间的直播信息
   * 使用公开 API，不需要 Cookie。输入号可以是内部 room_id 或靓号（见文件头）。
   * @param {string} roomId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async fetchRoomInfo(roomId) {
    const requested = String(roomId);
    const cachedInternal = VANITY_ROOM_ID_CACHE.get(requested);
    let result = await this._requestRoomInfo(cachedInternal || requested);
    if (result.success) {
      return this._withRequestedRoomId(result, requested);
    }

    // 直查失败：输入号可能是靓号（betard 只认内部 room_id），解析出内部号后再查一次
    if (!cachedInternal) {
      const internal = await this._resolveInternalRoomId(requested);
      if (internal && internal !== requested) {
        result = await this._requestRoomInfo(internal);
        if (result.success) {
          VANITY_ROOM_ID_CACHE.set(requested, internal);
          return this._withRequestedRoomId(result, requested);
        }
      }
    }
    return result;
  },

  /** 把返回里的 roomId 换成调用方传入的号（复合键对齐，见文件头） */
  _withRequestedRoomId(result, requested) {
    return { ...result, data: { ...result.data, roomId: requested } };
  },

  /**
   * betard 直查（只认内部 room_id），返回解析后的原始字段
   * @param {string} roomId 内部 room_id
   */
  async _requestRoomInfo(roomId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${API_BASE}/betard/${roomId}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT
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
          roomId: String(roomId),
          // 平台按 HTML 渲染标题 / 昵称 / 分类，接口吐编码后的文本（如标题里的 `&nbsp;`），
          // 在收敛处统一还原成纯文本，存储与界面只面对纯文本（见 lib/html-entities.js）
          nickname: HtmlEntities.decode(d.owner_name || d.nickname || ''),
          title: HtmlEntities.decode(d.room_name || ''),
          // 「什么算开播」的唯一口径（见 CONTEXT.md「开播状态」）：字符串 '1' 也是开播，
          // 轮播 / 回放（videoLoop === 1）不算。轮询合并与斗鱼弹幕客户端的采样超时兜底
          // 都消费这个结论，不各自再判一次（采样侧的裁决见 lib/douyu-barrage.js）。
          online: (d.show_status === 1 || d.show_status === '1') && d.videoLoop !== 1,
          coverUrl: d.room_src
            ? (d.room_src.startsWith('http') ? d.room_src
               : d.room_src.startsWith('//') ? `https:${d.room_src}`
               : `https://rpic.douyucdn.cn/${d.room_src.replace(/^\//, '')}`)
            : '',
          avatarUrl: d.owner_avatar || (typeof d.avatar === 'object' ? d.avatar.big : '') || '',
          viewers: parseInt(d.room_biz_all?.hot, 10) || 0,
          category: HtmlEntities.decode(d.cate_name || result.game?.tag_name || result.column?.cate_name || ''),
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
   * 把输入号当靓号解析成内部 room_id：拉一次房间页，从内嵌数据里取（见文件头）。
   * 不是靓号、页面拿不到、或页面里没有对应的房间时返回 null，调用方保持原错误。
   * @param {string} roomId 用户输入的号
   * @returns {Promise<string|null>}
   */
  async _resolveInternalRoomId(roomId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${API_BASE}/${encodeURIComponent(roomId)}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT
        }
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }
      return extractInternalRoomId(await response.text(), roomId);
    } catch (err) {
      return null;
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

      // 看点接口的 rid 只认内部 room_id（与 betard 同）；轮询已把靓号映射写进缓存，
      // 这里用缓存换算（缓存未命中就按原号试，最坏是这一轮取不到，不额外拉页面）
      const rid = VANITY_ROOM_ID_CACHE.get(String(roomId)) || roomId;

      const response = await fetch(`${API_BASE}/wgapi/vodnc/center/ailive/getHighlightDetail`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT
        },
        body: JSON.stringify({ rid: parseInt(rid, 10), sort: 0 })
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
            title: HtmlEntities.decode(String(item.title ?? '')),
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

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试
// （页面解析是零依赖纯函数，导出后可在单测里单独驱动）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DouyuAPI, extractInternalRoomId };
}
