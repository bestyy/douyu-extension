// lib/bilibili-barrage.js — Bilibili 弹幕 WebSocket 客户端（高能榜在线数 ONLINE_RANK_COUNT）
//
// 协议逆向自 live.bilibili.com 抓包与 blfe-live-room bundle:
// - getDanmuInfo 接口返回弹幕服务器地址与 token（需 w_rid 签名）
// - 帧格式: 16B 包头(packetLen/headerLen/ver/op/seq) + body
//   op=7 认证 / op=8 认证响应 / op=2 心跳 / op=5 弹幕消息
//   ver=1 明文 JSON / ver=2 zlib 压缩（可能嵌套批量子包）/ ver=3 brotli（protover=2 时不会收到）
// - 认证后服务端推送 ONLINE_RANK_COUNT: {"cmd":"ONLINE_RANK_COUNT","data":{"count":N,"online_count":N}}
//   高能榜在线数，约每 4-6 秒推送一次
// - w_rid 签名: md5(按 key 字典序排序的 k=v&... 串 + salt)，值需 encodeURIComponent

const WBI_SALT = 'ea1db124af3c7062474693fa704f4ff8'; // w_rid 签名密钥（逆向自 bundle）
const DANMU_INFO_API = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo';
const ROOM_INIT_API = 'https://api.live.bilibili.com/room/v1/Room/room_init'; // 展示房号 → 真实弹幕房号
const DEFAULT_DANMU_SERVER = 'wss://broadcastlv.chat.bilibili.com:2245/sub'; // getDanmuInfo 失败时的兜底

const OP_AUTH = 7;              // 认证包
const OP_AUTH_RESP = 8;         // 认证响应
const OP_HEARTBEAT = 2;         // 心跳
const OP_MESSAGE = 5;           // 弹幕消息
const BILI_HEARTBEAT_INTERVAL = 30000; // 心跳间隔（服务端 60s 无消息断连）
const BILI_RECONNECT_BASE_DELAY = 2000;  // 重连最小间隔
const BILI_RECONNECT_MAX_DELAY = 60000;  // 重连最大间隔（指数退避）

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

/** 生成随机 buvid（UUID 风格 + infoc 后缀，认证包需要） */
function randomBuvid() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}infoc`;
}

/**
 * Bilibili 弹幕客户端：每个 B 站房间一条 WebSocket，解析 ONLINE_RANK_COUNT 推送高能榜在线数
 */
class BilibiliBarrageClient {
  /**
   * @param {object} [options]
   * @param {(data: {roomId: string, rankCount: number}) => void} [options.onRankCount] 高能榜在线数回调
   */
  constructor(options = {}) {
    this.onRankCount = options.onRankCount || null;
    this.connections = new Map(); // roomId -> { ws, retryDelay, retryTimer, heartbeatTimer, stopped }
    this.realRoomIds = new Map(); // 展示房号 -> 真实弹幕房号（room_init 解析结果缓存，成功后不再变化）
  }

  /**
   * 更新订阅的房间列表（增删房间时调用，差异重建连接）
   * @param {string[]} roomIds
   */
  setRooms(roomIds) {
    const nextIds = [...new Set(roomIds.map(String))];
    // 断开已取消订阅的房间
    for (const roomId of [...this.connections.keys()]) {
      if (!nextIds.includes(roomId)) {
        this._disconnect(roomId);
      }
    }
    // 建立新订阅
    for (const roomId of nextIds) {
      if (!this.connections.has(roomId)) {
        this._connect(roomId);
      }
    }
  }

  /** 断开全部连接 */
  destroy() {
    for (const roomId of [...this.connections.keys()]) {
      this._disconnect(roomId);
    }
  }

  /** 建立某房间的连接（先取弹幕服务器，再连 WebSocket） */
  _connect(roomId) {
    const state = {
      roomId,
      danmuRoomId: null, // 真实弹幕房号（认证用），连接时由 room_init 解析
      ws: null,
      retryDelay: BILI_RECONNECT_BASE_DELAY,
      retryTimer: null,
      heartbeatTimer: null,
      stopped: false
    };
    this.connections.set(roomId, state);
    this._openSocket(state);
  }

  /** 断开某房间的连接并清理 */
  _disconnect(roomId) {
    const state = this.connections.get(roomId);
    if (!state) {
      return;
    }
    state.stopped = true;
    clearTimeout(state.retryTimer);
    clearInterval(state.heartbeatTimer);
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

  /** 获取弹幕服务器地址与 token（getDanmuInfo 需要 w_rid 签名） */
  async _fetchDanmuInfo(roomId) {
    const { query, w_rid } = signWbi({ id: roomId, type: 0, web_location: '444.8' });
    // query 已包含排序后的 wts 参数,直接追加 w_rid
    const resp = await fetch(
      `${DANMU_INFO_API}?${query}&w_rid=${w_rid}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
    const host = (json.data.host_list || [])[0];
    const baseUrl = host
      ? `wss://${host.host}:${host.wss_port || host.port}/sub`
      : DEFAULT_DANMU_SERVER;
    const token = json.data.token || '';
    return { url: `${baseUrl}?token=${encodeURIComponent(token)}`, token };
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

  /** 打开 WebSocket 并完成认证/心跳 */
  async _openSocket(state) {
    if (state.stopped) {
      return;
    }
    let danmuInfo;
    try {
      const danmuRoomId = await this._resolveRealRoomId(state.roomId);
      state.danmuRoomId = danmuRoomId;
      danmuInfo = await this._fetchDanmuInfo(danmuRoomId);
    } catch (e) {
      // 拿不到服务器信息，退避后重试
      this._scheduleRetry(state);
      return;
    }

    const ws = new WebSocket(danmuInfo.url);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      state.retryDelay = BILI_RECONNECT_BASE_DELAY; // 连接成功,重置退避

      // 发送认证包（protover=2 让服务端用 zlib 而非 brotli 压缩;roomid 必须用真实房号）
      ws.send(this._encodePacket(OP_AUTH, {
        uid: 0,
        roomid: Number(state.danmuRoomId),
        protover: 2,
        buvid: randomBuvid(),
        platform: 'web',
        type: 2,
        key: danmuInfo.token
      }));

      // 30s 心跳保持连接
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(this._encodePacket(OP_HEARTBEAT, '[object Object]'));
        }
      }, BILI_HEARTBEAT_INTERVAL);
    };

    ws.onmessage = async (event) => {
      const bytes = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : new Uint8Array(event.data.buffer || event.data);
      let messages;
      try {
        messages = await parseFrameBytes(bytes);
      } catch (e) {
        return;
      }
      for (const msg of messages) {
        // ONLINE_RANK_COUNT 携带高能榜在线数（online_count）
        if (msg.cmd === 'ONLINE_RANK_COUNT' && msg.data && this.onRankCount) {
          const rankCount = parseInt(msg.data.online_count ?? msg.data.count, 10);
          if (!isNaN(rankCount)) {
            this.onRankCount({ roomId: state.roomId, rankCount });
          }
        }
      }
    };

    ws.onclose = () => {
      clearInterval(state.heartbeatTimer);
      if (state.stopped) {
        return;
      }
      // 指数退避重连（2s 起,上限 60s）
      this._scheduleRetry(state);
    };

    ws.onerror = () => {
      // 错误后必然触发 onclose,重连逻辑统一在 onclose 中处理
    };
  }

  /** 安排重连（指数退避） */
  _scheduleRetry(state) {
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => {
      if (!state.stopped) {
        this._openSocket(state);
      }
    }, state.retryDelay);
    state.retryDelay = Math.min(state.retryDelay * 2, BILI_RECONNECT_MAX_DELAY);
  }
}
