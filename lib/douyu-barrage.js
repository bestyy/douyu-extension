// lib/douyu-barrage.js — 斗鱼弹幕 WebSocket 客户端（贵宾数 oni 消息）
//
// 协议逆向自 common_65f59e8.js 与页面抓包:
// - 帧格式: 4B 小端长度 + 4B 小端长度 + 4B 小端类型(689) + UTF-8 body + \0,
//   长度字段 = body 字节数 + 9（两个长度字段相同）
// - 直连 danmuproxy 无需签名（仅 gateway 中转需要 vk），随机 visitor 身份即可被接受
// - 订阅流程: loginreq → loginres → joingroup → 消息流;心跳 mrkl 每 45 秒
// - 贵宾数: oni 消息的 vn 字段,约每 6 秒推送一次,按 rid 区分房间

const BARRAGE_SERVERS = [
  'wss://danmuproxy.douyu.com:8501/',
  'wss://danmuproxy.douyu.com:8502/',
  'wss://danmuproxy.douyu.com:8503/',
  'wss://danmuproxy.douyu.com:8504/',
  'wss://danmuproxy.douyu.com:8505/'
];

// 协议版本常量（取自 common_65f59e8.js loginConfig）
const LOGIN_VERSION = '20220825';
const COUNT_VERSION = '218101901';

const FRAME_TYPE = 689;             // 弹幕数据帧类型
const HEARTBEAT_INTERVAL = 45000;   // mrkl 心跳间隔（服务器 45s 无消息断连）
const RECONNECT_BASE_DELAY = 2000;  // 重连最小间隔
const RECONNECT_MAX_DELAY = 60000;  // 重连最大间隔（指数退避）

/**
 * 编码一条弹幕消息为二进制帧
 * @param {string} body 消息文本（key@=value/ 格式）
 * @returns {ArrayBuffer}
 */
function encodeFrame(body) {
  const bodyBytes = new TextEncoder().encode(body);
  const buf = new ArrayBuffer(13 + bodyBytes.length); // 12B 头 + body + \0
  const view = new DataView(buf);
  const length = bodyBytes.length + 9; // 长度 = body 字节数 + 9
  view.setUint32(0, length, true);
  view.setUint32(4, length, true);
  view.setUint32(8, FRAME_TYPE, true);
  new Uint8Array(buf, 12).set(bodyBytes);
  new Uint8Array(buf, 12 + bodyBytes.length)[0] = 0;
  return buf;
}

/**
 * 解码一帧二进制消息
 * @param {ArrayBuffer|Uint8Array|string} data
 * @returns {string} 消息文本（去掉头部与尾部 \0）
 */
function decodeFrame(data) {
  if (typeof data === 'string') {
    return data;
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // 跳过 12B 头,去掉尾部 \0
  let end = bytes.length;
  while (end > 12 && bytes[end - 1] === 0) {
    end--;
  }
  return new TextDecoder().decode(bytes.subarray(12, end));
}

/**
 * 解析弹幕消息文本为键值对象
 * 格式: key@=value/key@=value/;列表值（@AA=/@AS/@S）按原样保留
 * @param {string} body
 * @returns {object}
 */
function parseDyMessage(body) {
  const message = {};
  const regex = /([^/@]+)@=([^/]*)/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    message[match[1]] = match[2];
  }
  return message;
}

/**
 * 斗鱼弹幕客户端:每个斗鱼房间一个 danmuproxy 连接,解析 oni 推送贵宾数
 */
class BarrageClient {
  /**
   * @param {object} [options]
   * @param {(data: {roomId: string, vipCount: number}) => void} [options.onVipCount] 贵宾数回调
   */
  constructor(options = {}) {
    this.onVipCount = options.onVipCount || null;
    this.connections = new Map(); // roomId -> { ws, serverIndex, retryDelay, retryTimer, heartbeatTimer, stopped }
    this.serverIndex = 0; // 新连接的起始端口（轮换 8501-8505）
  }

  /**
   * 更新订阅的房间列表（增删房间时调用,差异重建连接）
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

  /** 建立某房间的连接 */
  _connect(roomId) {
    const state = {
      roomId,
      ws: null,
      serverIndex: this.serverIndex++,
      retryDelay: RECONNECT_BASE_DELAY,
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

  /** 打开 WebSocket 并完成登录/订阅 */
  _openSocket(state) {
    if (state.stopped) {
      return;
    }
    const url = BARRAGE_SERVERS[state.serverIndex % BARRAGE_SERVERS.length];
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      state.retryDelay = RECONNECT_BASE_DELAY; // 连接成功,重置退避

      // 随机 visitor 身份登录（无需签名）并加入房间分组
      const username = 'visitor' + String(Math.floor(Math.random() * 10000000)).padStart(7, '0');
      const uid = String(Math.floor(Math.random() * 9000000000) + 1000000000);
      ws.send(encodeFrame(`type@=loginreq/roomid@=${state.roomId}/dfl@=/username@=${username}/uid@=${uid}/ver@=${LOGIN_VERSION}/aver@=${COUNT_VERSION}/ct@=0/`));
      ws.send(encodeFrame(`type@=joingroup/rid@=${state.roomId}/gid@=1/`));

      // 45s 心跳保持连接
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeFrame('type@=mrkl/'));
        }
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = parseDyMessage(decodeFrame(event.data));
      } catch (e) {
        return;
      }
      // oni 消息携带贵宾数（vn 字段）
      if (msg.type === 'oni' && this.onVipCount) {
        const vipCount = parseInt(msg.vn, 10);
        if (!isNaN(vipCount)) {
          this.onVipCount({ roomId: state.roomId, vipCount });
        }
      }
    };

    ws.onclose = () => {
      clearInterval(state.heartbeatTimer);
      if (state.stopped) {
        return;
      }
      // 指数退避重连（2s 起,上限 60s）,失败自动轮换端口
      state.retryTimer = setTimeout(() => {
        state.serverIndex++;
        this._openSocket(state);
      }, state.retryDelay);
      state.retryDelay = Math.min(state.retryDelay * 2, RECONNECT_MAX_DELAY);
    };

    ws.onerror = () => {
      // 错误后必然触发 onclose,重连逻辑统一在 onclose 中处理
    };
  }
}
