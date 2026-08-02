// lib/bilibili-barrage.js — Bilibili 弹幕 WebSocket 采样客户端（高能榜在线数 ONLINE_RANK_COUNT）
//
// 协议逆向自 live.bilibili.com 抓包与 blfe-live-room bundle:
// - getDanmuInfo 接口返回弹幕服务器地址与 token（需 w_rid 签名）
// - 帧格式: 16B 包头(packetLen/headerLen/ver/op/seq) + body
//   op=7 认证 / op=8 认证响应 / op=2 心跳 / op=5 弹幕消息
//   ver=1 明文 JSON / ver=2 zlib 压缩（可能嵌套批量子包）/ ver=3 brotli（protover=2 时不会收到）
// - 认证后服务端推送 ONLINE_RANK_COUNT: {"cmd":"ONLINE_RANK_COUNT","data":{"count":N,"online_count":N}}
//   高能榜在线数，约每 4-6 秒推送一次
// - w_rid 签名: md5(按 key 字典序排序的 k=v&... 串 + salt)，值需 encodeURIComponent
//
// 采样模式：每个房间一条连接（认证包需带 roomid），收到第一条高能榜在线数
// 立即断开；全部完成或超时后收尾，平时不保持任何 WS 连接。
// 采样由 background 的 10 分钟 alarm 驱动（chrome.alarms 唤醒 SW 时自动重连）。
//
// 风控要点（实测）:
// - 广播通道（7826）校验「握手 Cookie buvid3」与「认证包 buvid」必须一致，
//   不一致即被 1006 风控。因此 buvid 统一解析：优先复用浏览器已有 Cookie 值，
//   没有则生成 infoc 格式随机值并写入 Cookie，认证包与握手 Cookie 恒为同一值。
// - 连续采样无数据且快速断开 → 触发 onFallback 降级到页面通道（live.bilibili.com
//   页面上下文的 Origin/Cookie 与页面弹幕一致，不受 SW 直连风控影响）。

const WBI_SALT = 'ea1db124af3c7062474693fa704f4ff8'; // w_rid 签名密钥（逆向自 bundle）
const DANMU_INFO_API = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo';
const ROOM_INIT_API = 'https://api.live.bilibili.com/room/v1/Room/room_init'; // 展示房号 → 真实弹幕房号
const DEFAULT_DANMU_SERVER = 'wss://broadcastlv.chat.bilibili.com:2245/sub'; // getDanmuInfo 失败时的兜底

const OP_AUTH = 7;              // 认证包
const OP_AUTH_RESP = 8;         // 认证响应
const OP_HEARTBEAT = 2;         // 心跳
const OP_MESSAGE = 5;           // 弹幕消息
const BILI_FAST_CLOSE_MS = 15000;        // 连接建立后此时间内断开视为异常快速断开（风控特征）
const BILI_SAMPLE_TIMEOUT_MS = 20000;    // 单房间采样超时：拿不到高能榜在线数的房间到时强制断开
const BILI_FALLBACK_STREAK = 2;          // 连续 N 轮采样均快速断开 → 判定 SW 直连被风控，触发降级

// === B站 buvid 一致性 ===
// 广播通道校验「握手 Cookie buvid3」与「认证包 buvid」必须一致（不一致即 1006 风控）。
// 统一来源：优先复用浏览器已有 buvid3 Cookie（页面访问时服务端下发，格式正确），
// 没有则生成 infoc 格式随机值并写入 Cookie，保证握手与认证包恒为同一值。
let buvid3 = null;

async function resolveBuvid3() {
  if (buvid3) {
    return buvid3;
  }
  // 优先复用已有 Cookie（用户访问过 B站页面时已存在，与浏览器行为一致）
  try {
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const c = await chrome.cookies.get({ url: 'https://chat.bilibili.com', name: 'buvid3' });
      if (c && c.value) {
        buvid3 = c.value;
        return buvid3;
      }
    } else if (typeof document !== 'undefined') {
      const m = document.cookie.match(/(?:^|; )buvid3=([^;]+)/);
      if (m) {
        buvid3 = m[1];
        return buvid3;
      }
    }
  } catch (e) {
    // 读取失败则生成新值
  }
  // 无已有 Cookie → 生成 infoc 格式随机值并写入（握手 Cookie 与认证包同值）
  buvid3 = randomBuvid();
  try {
    const base = {
      url: 'https://chat.bilibili.com',
      domain: '.bilibili.com',
      path: '/',
      secure: true,
      expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600
    };
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      await Promise.all([
        chrome.cookies.set({ ...base, name: 'buvid3', value: buvid3 }),
        chrome.cookies.set({ ...base, name: 'buvid4', value: randomBuvid() })
      ]);
      console.log('[bili] 已写入 buvid3/buvid4 Cookie');
    } else if (typeof document !== 'undefined') {
      document.cookie = `buvid3=${buvid3}; domain=.bilibili.com; path=/; max-age=${31536000}; secure`;
    }
  } catch (e) {
    console.warn(`[bili] 写入 buvid Cookie 失败: ${e.message}`);
  }
  return buvid3;
}

// === MD5 实现（Service Worker 无内置 MD5，crypto.subtle 不支持）===
// 标准 RFC 1321，小端字节序
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
);

function md5(str) {
  const utf8 = new TextEncoder().encode(str);
  const paddedLen = (((utf8.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(utf8);
  buf[utf8.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 8, utf8.length * 8, true); // 位长度（低 32 位）
  dv.setUint32(paddedLen - 4, 0, true);               // 高 32 位（消息很短恒为 0）

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < paddedLen; off += 64) {
    const M = new Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] = dv.getUint32(off + i * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  // 小端序输出 hex
  const words = [a0, b0, c0, d0];
  let hex = '';
  for (const w of words) {
    hex +=
      (w & 0xff).toString(16).padStart(2, '0') +
      ((w >>> 8) & 0xff).toString(16).padStart(2, '0') +
      ((w >>> 16) & 0xff).toString(16).padStart(2, '0') +
      ((w >>> 24) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * 生成 w_rid 签名参数
 * @param {object} params 请求参数（不含 w_rid/wts）
 * @returns {{query: string, w_rid: string, wts: number}} 排序拼接串 / 签名 / 时间戳
 */
function signWbi(params) {
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map(k => `${k}=${encodeURIComponent(all[k])}`)
    .join('&');
  return { query, w_rid: md5(query + WBI_SALT), wts };
}

// === 二进制帧解析 ===

/** 切分一帧为若干子包（16B 头 + body） */
function splitPackets(buf) {
  const packets = [];
  let off = 0;
  while (off + 16 <= buf.length) {
    const packetLen = buf[off] * 0x1000000 + buf[off + 1] * 0x10000 + buf[off + 2] * 0x100 + buf[off + 3];
    if (packetLen < 16 || off + packetLen > buf.length) {
      break; // 残包/坏包，丢弃
    }
    packets.push({
      ver: (buf[off + 6] << 8) | buf[off + 7],
      op: (buf[off + 8] << 24) | (buf[off + 9] << 16) | (buf[off + 10] << 8) | buf[off + 11],
      body: buf.subarray(off + 16, off + packetLen)
    });
    off += packetLen;
  }
  return packets;
}

/** zlib 解压（ver=2），DecompressionStream 的 'deflate' 即 zlib 格式 */
async function inflateZlib(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const result = await new Response(stream).arrayBuffer();
  return new Uint8Array(result);
}

/** 判断解压后的数据是否为嵌套子包流（首个 packetLen 字段合理） */
function looksLikePackets(bytes) {
  if (bytes.length < 16) {
    return false;
  }
  const packetLen = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
  return packetLen >= 16 && packetLen <= bytes.length;
}

/** 将 body 文本解析为消息对象（单个 JSON 或 JSON 数组展开） */
function parseJsonBody(bytes) {
  let text;
  try {
    text = new TextDecoder().decode(bytes).replace(/\x00+$/, '');
  } catch (e) {
    return [];
  }
  const messages = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        messages.push(...parsed);
      } else if (parsed && typeof parsed === 'object') {
        messages.push(parsed);
      }
    } catch (e) {
      // 跳过非 JSON 片段（如二进制残留）
    }
  }
  return messages;
}

/** 递归解析一帧二进制数据，返回 {op, msg} 消息列表 */
async function parseFrameBytes(buf) {
  const results = [];
  for (const packet of splitPackets(buf)) {
    if (packet.op === OP_MESSAGE) {
      // ver=0/1: 明文 JSON（解压后的嵌套子包同样以 ver=0 明文出现）
      if (packet.ver === 0 || packet.ver === 1) {
        results.push(...parseJsonBody(packet.body));
      } else if (packet.ver === 2) {
        let inflated;
        try {
          inflated = await inflateZlib(packet.body);
        } catch (e) {
          continue; // 解压失败，丢弃该包
        }
        if (looksLikePackets(inflated)) {
          results.push(...await parseFrameBytes(inflated));
        } else {
          results.push(...parseJsonBody(inflated));
        }
      }
      // ver=3: brotli（protover=2 时不会收到），忽略
    }
  }
  return results;
}

/** 生成随机 buvid（UUID 风格 + infoc 后缀，与 B站下发格式一致） */
function randomBuvid() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}infoc`;
}

/**
 * Bilibili 弹幕采样客户端：每个 B 站房间一条 WebSocket，解析 ONLINE_RANK_COUNT 推送高能榜在线数
 */
class BilibiliBarrageClient {
  /**
   * @param {object} [options]
   * @param {(data: {roomId: string, rankCount: number}) => void} [options.onRankCount] 高能榜在线数回调
   * @param {() => void} [options.onFallback] SW 直连被风控（快速断开无数据）时的降级回调
   */
  constructor(options = {}) {
    this.onRankCount = options.onRankCount || null;
    this.onFallback = options.onFallback || null;
    this.connections = new Map(); // roomId -> { ws, timeoutTimer, buvid3, danmuInfo, stopped }
    this.realRoomIds = new Map(); // 展示房号 -> 真实弹幕房号（room_init 解析结果缓存，成功后不再变化）
    this.remaining = null;        // 本轮采样剩余房间
    this.roundTimer = null;       // 本轮总超时定时器（兜底）
    this.roundFastClose = false;  // 本轮是否出现过异常快速断开（风控特征）
    this.successCount = 0;        // 本轮成功拿到数据的房间数
    this.fastCloseStreak = 0;     // 连续出现快速断开的轮数（跨轮累计）
  }

  /**
   * 采样：每个房间一条连接，收到第一条高能榜在线数即断开；全部完成或超时后收尾
   * @param {string[]} roomIds
   */
  sample(roomIds) {
    const ids = [...new Set(roomIds.map(String))];
    this._finishSampling(); // 上一轮收尾（断开剩余连接）
    if (ids.length === 0) {
      return;
    }
    this.remaining = new Set(ids);
    this.roundFastClose = false;
    this.successCount = 0;
    // 本轮总超时兜底（单房间超时由各连接自行处理）
    this.roundTimer = setTimeout(() => this._finishSampling(), BILI_SAMPLE_TIMEOUT_MS + 10000);
    for (const roomId of ids) {
      this._connect(roomId);
    }
  }

  /** 本轮采样收尾：清理定时器与剩余连接；快速断开达到阈值 → 触发降级 */
  _finishSampling() {
    clearTimeout(this.roundTimer);
    this.roundTimer = null;
    for (const roomId of [...this.connections.keys()]) {
      this._disconnect(roomId);
    }
    this.remaining = null;
    if (this.roundFastClose) {
      this.fastCloseStreak++;
    } else {
      this.fastCloseStreak = 0;
    }
    // 本轮采样无任何数据且出现快速断开（风控特征明显）→ 立即降级，不等下一轮
    if (this.roundFastClose && this.successCount === 0 && this.onFallback) {
      console.warn('[bili] 本轮采样全部失败且快速断开,立即触发页面通道降级');
      this.fastCloseStreak = 0;
      this.onFallback();
      return;
    }
    // 兜底：连续多轮出现快速断开 → 降级
    if (this.fastCloseStreak >= BILI_FALLBACK_STREAK && this.onFallback) {
      console.warn('[bili] SW 直连连续快速断开,触发页面通道降级');
      this.fastCloseStreak = 0;
      this.onFallback();
    }
  }

  /** 断开全部连接（扩展卸载等场景） */
  destroy() {
    for (const roomId of [...this.connections.keys()]) {
      this._disconnect(roomId);
    }
  }

  /** 建立某房间的采样连接 */
  _connect(roomId) {
    const state = {
      roomId,
      danmuRoomId: null, // 真实弹幕房号（认证用），连接时由 room_init 解析
      danmuInfo: null,   // getDanmuInfo 结果 { hosts, token }
      buvid3: null,      // 认证包 buvid（与握手 Cookie 同值）
      ws: null,
      timeoutTimer: setTimeout(() => this._handleTimeout(roomId), BILI_SAMPLE_TIMEOUT_MS),
      stopped: false
    };
    this.connections.set(roomId, state);
    this._openSocket(state);
  }

  /** 单房间采样超时：断开并收尾（未开播/无高能榜推送的房间会走到这里） */
  _handleTimeout(roomId) {
    this._disconnect(roomId);
    if (this.remaining) {
      this.remaining.delete(roomId);
      if (this.remaining.size === 0) {
        this._finishSampling();
      }
    }
  }

  /** 断开某房间的连接并清理 */
  _disconnect(roomId) {
    const state = this.connections.get(roomId);
    if (!state) {
      return;
    }
    state.stopped = true;
    clearTimeout(state.timeoutTimer);
    if (state.ws) {
      try {
        state.ws.close();
      } catch (e) {
        // 忽略关闭异常
      }
      state.ws = null;
    }
    this.connections.delete(roomId);
  }

  /**
   * 解析真实弹幕房号
   * 直播间存在短房号（如 7777 的短号映射真实房号 545068），弹幕认证必须用真实房号，
   * 否则收不到任何消息推送。room_init 返回 data.room_id（真实房号）。
   * @param {string} roomId 展示房号
   * @returns {Promise<string>} 真实弹幕房号（解析失败时回退原房号）
   */
  async _resolveRealRoomId(roomId) {
    if (this.realRoomIds.has(roomId)) {
      return this.realRoomIds.get(roomId);
    }
    try {
      const resp = await fetch(
        `${ROOM_INIT_API}?id=${encodeURIComponent(roomId)}`,
        {
          headers: {
            'User-Agent': navigator.userAgent,
            'Referer': 'https://live.bilibili.com/'
          }
        }
      );
      if (!resp.ok) {
        throw new Error('room_init http ' + resp.status);
      }
      const json = await resp.json();
      if (json.code !== 0 || !json.data || !json.data.room_id) {
        throw new Error('room_init code ' + json.code);
      }
      const realRoomId = String(json.data.room_id);
      this.realRoomIds.set(roomId, realRoomId);
      return realRoomId;
    } catch (e) {
      // 解析失败不缓存，按原房号继续尝试（多数房间展示号即真实号）
      return roomId;
    }
  }

  /** 获取弹幕服务器地址与 token（getDanmuInfo 需要 w_rid 签名），broadcast 主通道 + comet 后备 */
  async _fetchDanmuInfo(roomId) {
    const { query, w_rid } = signWbi({ id: roomId, type: 0, web_location: '444.8' });
    const resp = await fetch(
      `${DANMU_INFO_API}?${query}&w_rid=${w_rid}`,
      {
        headers: {
          'User-Agent': navigator.userAgent,
          'Referer': 'https://live.bilibili.com/'
        }
      }
    );
    if (!resp.ok) {
      throw new Error('getDanmuInfo http ' + resp.status);
    }
    const json = await resp.json();
    if (json.code !== 0 || !json.data) {
      throw new Error('getDanmuInfo code ' + json.code);
    }
    // broadcast 新通道（7826 + proto 子协议）优先：直播间页面使用的新弹幕服务器，
    // 部分浏览器（如豆包）对旧 comet 通道的扩展连接握手后即 RST，broadcast 通道放行。
    const hosts = ['wss://broadcast.chat.bilibili.com:7826/sub'];
    for (const h of (json.data.host_list || [])) {
      const url = `wss://${h.host}:${h.wss_port || h.port}/sub`;
      if (!hosts.includes(url)) {
        hosts.push(url);
      }
    }
    if (hosts.length === 1) {
      hosts.push(DEFAULT_DANMU_SERVER);
    }
    console.log(`[bili] ${roomId} getDanmuInfo 成功, ${hosts.length} 个服务器`);
    return { hosts, token: json.data.token || '' };
  }

  /** 编码一条 JSON 消息为协议帧（op/ver 字段,小端 seq 恒 0） */
  _encodePacket(op, obj) {
    const body = new TextEncoder().encode(JSON.stringify(obj));
    const buf = new ArrayBuffer(16 + body.length);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const packetLen = 16 + body.length;
    view.setUint32(0, packetLen, false);   // packetLen
    view.setUint16(4, 16, false);          // headerLen
    view.setUint16(6, 1, false);           // ver
    view.setUint32(8, op, false);          // op
    view.setUint32(12, 0, false);          // seq
    bytes.set(body, 16);
    return buf;
  }

  /** 打开 WebSocket 并完成认证（采样模式：无心跳无重连） */
  async _openSocket(state) {
    if (state.stopped) {
      return;
    }
    // 认证包 buvid 必须与握手 Cookie buvid3 一致（否则 1006 风控），先解析统一值
    try {
      state.buvid3 = await resolveBuvid3();
    } catch (e) {
      state.buvid3 = randomBuvid();
    }
    // 无缓存时获取真实房号与服务器列表
    if (!state.danmuInfo) {
      try {
        const danmuRoomId = await this._resolveRealRoomId(state.roomId);
        state.danmuRoomId = danmuRoomId;
        state.danmuInfo = await this._fetchDanmuInfo(danmuRoomId);
      } catch (e) {
        console.warn(`[bili] ${state.roomId} 获取弹幕服务器失败: ${e.message}, 本轮跳过`);
        this._handleTimeout(state.roomId);
        return;
      }
    }

    const host = state.danmuInfo.hosts[0]; // broadcast 主通道（风控时由降级逻辑接管）
    const url = `${host}?token=${encodeURIComponent(state.danmuInfo.token)}`;
    const ws = new WebSocket(url, 'proto'); // broadcast 通道要求 proto 子协议
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    state.connectAt = Date.now(); // 记录连接建立时刻,用于判定异常快速断开

    ws.onopen = () => {
      console.log(`[bili] ${state.roomId} WS 已连接 (real=${state.danmuRoomId}, buvid=${state.buvid3})`);
      // 发送认证包（protover=2 让服务端用 zlib 而非 brotli 压缩;roomid 必须用真实房号）
      ws.send(this._encodePacket(OP_AUTH, {
        uid: 0,
        roomid: Number(state.danmuRoomId),
        protover: 2,
        buvid: state.buvid3,
        platform: 'web',
        type: 2,
        key: state.danmuInfo.token
      }));
    };

    ws.onmessage = async (event) => {
      const bytes = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : new Uint8Array(event.data.buffer || event.data);
      // 认证响应（op=8）是独立明文包，parseFrameBytes 不处理，这里单独解析用于排查
      if (bytes.length >= 16) {
        const op8 = (bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11];
        if (op8 === 8) {
          try {
            const auth = JSON.parse(new TextDecoder().decode(bytes.subarray(16)).replace(/\x00+$/, ''));
            if (auth.code === 0) {
              console.log(`[bili] ${state.roomId} 认证成功`);
            } else {
              console.warn(`[bili] ${state.roomId} 认证失败 code=${auth.code} msg=${auth.msg}`);
            }
          } catch (e) {
            // 解析失败忽略
          }
        }
      }
      let messages;
      try {
        messages = await parseFrameBytes(bytes);
      } catch (e) {
        console.warn(`[bili] ${state.roomId} 解析消息失败: ${e.message}`);
        return;
      }
      for (const msg of messages) {
        // ONLINE_RANK_COUNT 携带高能榜在线数（online_count）
        if (msg.cmd === 'ONLINE_RANK_COUNT' && msg.data && this.onRankCount) {
          const rankCount = parseInt(msg.data.online_count ?? msg.data.count, 10);
          if (!isNaN(rankCount)) {
            console.log(`[bili] ${state.roomId} 高能榜在线数=${rankCount}`);
            this.successCount++;
            this.onRankCount({ roomId: state.roomId, rankCount });
            this._disconnect(state.roomId); // 采样模式：拿到即断开
            if (this.remaining) {
              this.remaining.delete(state.roomId);
              if (this.remaining.size === 0) {
                this._finishSampling();
              }
            }
          }
        }
      }
    };

    ws.onclose = (e) => {
      clearTimeout(state.timeoutTimer);
      if (state.stopped) {
        return; // 主动断开（已拿到数据/超时收尾）
      }
      // 连接建立后短时间内异常断开（1006 无 close 帧）→ 风控特征，标记本轮
      const fastClose = e.code === 1006 && Date.now() - state.connectAt < BILI_FAST_CLOSE_MS;
      console.log(`[bili] ${state.roomId} WS 异常关闭 code=${e.code} fast=${fastClose}`);
      if (fastClose) {
        this.roundFastClose = true;
      }
      this.connections.delete(state.roomId);
      if (this.remaining) {
        this.remaining.delete(state.roomId);
        if (this.remaining.size === 0) {
          this._finishSampling();
        }
      }
    };

    ws.onerror = () => {
      // 错误后必然触发 onclose,收尾逻辑统一在 onclose 中处理
    };
  }
}
