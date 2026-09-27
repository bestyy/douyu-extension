// lib/config-backup.js — 配置备份：导出对象的构造与导入文本的解析校验（纯模块）
//
// 术语（见 CONTEXT.md）与决策（见 docs/adr/0012-config-backup-export-import.md）：
// 「配置」= rooms（房间与其 per-room 开关/参数）+ categories（分类列表）+ settings（全局设置项），
// 归房间库所有。导出把这三样写成一份带格式标识与版本号的 JSON；导入经校验后整份替换本机配置。
// 运行时观测值（streamers / todayStats / 看点水位 / 已通知 / 盯守排队 / 弹窗记忆 / 通道标记）不进文件。
//
// 本模块独占「文件长什么样」这一知识：构造导出对象、解析并校验导入文本。
// 它零依赖（照 ADR-0005：判定所需的常量自带，不引用其他 lib），identity / categoryRules 由调用方注入，
// 因此 SW、设置页与 node 单测都能直接驱动。
//
// 校验是严格口径：结构 / 类型 / 数值区间 / 未知设置键任一条不合即整份拒绝（reason 三类：
// not-backup / unsupported-version / invalid），绝不返回半套配置；缺键合法（缺的项由房间库读侧
// 既有的默认值补全）。数值区间与房间库的钳制常量同源——那些区间若调整，这里要同步。

const ConfigBackup = (() => {
  const FORMAT = 'douyu-extensions-config';
  const VERSION = 1;

  // rooms 里可辨认的持久化字段（其余字段原样透传：房间库的 patchRoomConfig 也保留「尚未认识的
  // per-room 字段」，导出 / 导入因此对它们无损）。online 是轮询观测、不是配置，一律剥掉。
  const ROOM_KNOWN_FIELDS = {
    notify: 'boolean',
    surgeAlert: 'boolean',
    highlightAlert: 'boolean',
    watch: 'object',
    viewerAlert: 'object'
  };

  // settings 允许写入的键及其校验口径（房间库 ROOM_STORE_SETTINGS_KEYS 是同一批键的另一份，
  // 各自持有以维持零依赖，见 ADR-0005）。数值范围与小数位和 lib/room-store.js 的钳制常量同源——
  // 导入是一次原样写入，不像 patchSettings 会钳制，因此越界或多出小数位都要在这里拒掉，
  // 否则会落下一个「能存进去却与表单显示不一致」的值。
  const SETTINGS_SCHEMA = {
    refreshInterval: { type: 'number', min: 60, decimals: 0 },
    notificationsEnabled: { type: 'boolean' },
    danmakuWatchEnabled: { type: 'boolean' },
    viewerAlertEnabled: { type: 'boolean' },
    surgeAlertEnabled: { type: 'boolean' },
    surgeMultiple: { type: 'number', min: 1.1, max: 10, decimals: 1 },
    surgeMinBaseline: { type: 'number', min: 1, max: 999, decimals: 0 },
    surgeCooldownMinutes: { type: 'number', min: 1, max: 180, decimals: 0 },
    surgeMinBuckets: { type: 'number', min: 2, max: 30, decimals: 0 },
    highlightAlertEnabled: { type: 'boolean' },
    todayStatsEnabled: { type: 'boolean' },
    openInCurrentTab: { type: 'boolean' },
    fetchDouyuViewerCount: { type: 'boolean' },
    fetchBilibiliViewerCount: { type: 'boolean' }
  };

  /** 纯对象判断（排除 null 与数组） */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** 复制房间条目：剥掉 online，categoryId 为空值时丢弃（未分类不落字段） */
  function projectRoom(room) {
    const out = {};
    for (const [key, value] of Object.entries(room)) {
      if (key === 'online') continue;
      if (key === 'categoryId' && (value === '' || value === null || value === undefined)) continue;
      out[key] = value;
    }
    return out;
  }

  /**
   * 构造导出对象。
   * @param {{rooms?: Array, categories?: Array, settings?: object}} snapshot 房间库的只读快照
   * @param {{now?: Date}} [options] 注入时刻（测试固定 exportedAt）
   * @returns {object} 带 format / version / exportedAt / rooms / categories / settings 的对象
   */
  function buildExport(snapshot = {}, { now = new Date() } = {}) {
    const rooms = (Array.isArray(snapshot.rooms) ? snapshot.rooms : []).map(projectRoom);
    const categories = (Array.isArray(snapshot.categories) ? snapshot.categories : [])
      .map(category => ({ id: String(category.id), name: category.name }));
    const settings = {};
    for (const key of Object.keys(SETTINGS_SCHEMA)) {
      if (snapshot.settings && snapshot.settings[key] !== undefined) {
        settings[key] = snapshot.settings[key];
      }
    }
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: now.toISOString(),
      settings,
      categories,
      rooms
    };
  }

  /** 失败结果（三类 reason 之一，message 是给用户看的中文原因） */
  function fail(reason, message) {
    return { ok: false, reason, message };
  }

  /**
   * 解析并校验导入文本。
   * @param {string} text 文件内容
   * @param {{identity: object, categoryRules: object}} ports 房间标识与分类规则 module（注入以便单测）
   * @returns {{ok: true, config: {rooms: Array, categories: Array, settings: object}}
   *          | {ok: false, reason: 'not-backup'|'unsupported-version'|'invalid', message: string}}
   */
  function parseBackup(text, { identity, categoryRules } = {}) {
    if (!identity || !categoryRules) {
      throw new TypeError('ConfigBackup.parseBackup 需要 identity 与 categoryRules port');
    }
    if (typeof text !== 'string') {
      return fail('not-backup', '不是本扩展导出的配置文件');
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return fail('not-backup', '不是本扩展导出的配置文件（不是有效的 JSON）');
    }
    if (!isPlainObject(raw) || raw.format !== FORMAT) {
      return fail('not-backup', '不是本扩展导出的配置文件');
    }
    if (raw.version !== VERSION) {
      return fail('unsupported-version', `不支持的配置版本：${raw.version}（当前支持版本 ${VERSION}）`);
    }

    // === 分类（先校验，房间的 categoryId 要拿它的 id 集合来判） ===
    const rawCategories = raw.categories === undefined ? [] : raw.categories;
    if (!Array.isArray(rawCategories)) {
      return fail('invalid', 'categories 必须是数组');
    }
    const categories = [];
    const categoryIds = new Set();
    for (const entry of rawCategories) {
      if (!isPlainObject(entry)) return fail('invalid', '分类条目格式不正确');
      const id = entry.id === undefined || entry.id === null ? '' : String(entry.id);
      if (!id) return fail('invalid', '分类 id 不能为空');
      if (categoryIds.has(id)) return fail('invalid', `分类 id 重复：${id}`);
      const validated = categoryRules.validateName(entry.name, categories);
      if (!validated.ok) return fail('invalid', `分类名不合法：${validated.error}`);
      categoryIds.add(id);
      categories.push({ id, name: validated.name });
    }

    // === 房间 ===
    const rawRooms = raw.rooms === undefined ? [] : raw.rooms;
    if (!Array.isArray(rawRooms)) {
      return fail('invalid', 'rooms 必须是数组');
    }
    const rooms = [];
    const seenKeys = new Set();
    for (const entry of rawRooms) {
      if (!isPlainObject(entry)) return fail('invalid', '房间条目格式不正确');
      if (!identity.isPlatform(entry.platform)) return fail('invalid', `不支持的平台：${entry.platform}`);
      if (typeof entry.roomId !== 'string') return fail('invalid', '房间号必须是字符串');
      const roomId = entry.roomId.trim();
      if (!identity.isRoomId(roomId)) return fail('invalid', `房间号格式无效：${entry.roomId}`);

      const key = identity.roomKey({ platform: entry.platform, roomId });
      if (seenKeys.has(key)) return fail('invalid', `房间重复：${key}`);
      seenKeys.add(key);

      if (entry.categoryId !== undefined && entry.categoryId !== null && entry.categoryId !== '') {
        if (typeof entry.categoryId !== 'string' || !categoryIds.has(entry.categoryId)) {
          return fail('invalid', `房间 ${key} 的分类不存在：${entry.categoryId}`);
        }
      }

      for (const [field, expected] of Object.entries(ROOM_KNOWN_FIELDS)) {
        const value = entry[field];
        if (value === undefined) continue;
        if (expected === 'boolean' && typeof value !== 'boolean') {
          return fail('invalid', `房间 ${key} 的 ${field} 必须是布尔值`);
        }
        if (expected === 'object' && !isPlainObject(value)) {
          return fail('invalid', `房间 ${key} 的 ${field} 格式不正确`);
        }
      }

      const room = projectRoom(entry);
      room.roomId = roomId; // 带上 trim 后的规范房间号
      rooms.push(room);
    }

    // === 设置（未知键即拒） ===
    const rawSettings = raw.settings === undefined ? {} : raw.settings;
    if (!isPlainObject(rawSettings)) {
      return fail('invalid', 'settings 必须是对象');
    }
    const settings = {};
    for (const [key, value] of Object.entries(rawSettings)) {
      const schema = SETTINGS_SCHEMA[key];
      if (!schema) return fail('invalid', `不认识的设置项：${key}`);
      if (schema.type === 'boolean') {
        if (typeof value !== 'boolean') return fail('invalid', `设置项 ${key} 必须是布尔值`);
      } else {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return fail('invalid', `设置项 ${key} 必须是数值`);
        }
        if (value < schema.min || (schema.max !== undefined && value > schema.max)) {
          return fail('invalid', `设置项 ${key} 超出允许范围`);
        }
        if (schema.decimals !== undefined) {
          const factor = 10 ** schema.decimals;
          if (Math.trunc(value * factor) / factor !== value) {
            return fail('invalid', `设置项 ${key} 的小数位过多`);
          }
        }
      }
      settings[key] = value;
    }

    return { ok: true, config: { rooms, categories, settings } };
  }

  return Object.freeze({
    buildExport,
    parseBackup
  });
})();

// UMD 双兼容：导入 / 导出的入口在设置页（因此只列进 options.html 的 <script>），node 下可 require 测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ConfigBackup };
}
