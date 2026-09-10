// lib/douyu-barrage.js — 斗鱼弹幕 WebSocket 采样客户端（贵宾数 oni 消息）
//
// 协议逆向自 common_65f59e8.js 与页面抓包:
// - 帧格式: 4B 小端长度 + 4B 小端长度 + 4B 小端类型(689) + UTF-8 body + \0,
//   长度字段 = body 字节数 + 9（两个长度字段相同）
// - 直连 danmuproxy 无需签名（仅 gateway 中转需要 vk），随机 visitor 身份即可被接受
// - 订阅流程: loginreq → loginres → joingroup → 消息流
// - 贵宾数: oni 消息的 vn 字段（带 rid 字段），约每 6 秒推送一次
//
// 采样模式：每个房间一条连接（实测 danmuproxy 单连接多 joingroup 只响应第一个房间，
// 见 .pi/test-douyu-multiroom.cjs），收到该房间的贵宾数或超时后立即断开。
// 连接仅存在于采样窗口（约 15 秒）内，平时零 WS 连接。
// 采样由 background 的 10 分钟 alarm 驱动（chrome.alarms 唤醒 SW 时自动重连）。
//
// 检测模式（长连接，见 ADR-0005）：斗鱼在现有 oni（贵宾数）分支旁解析 chatmsg（弹幕文本
// txt / 发送者 nn），经 onDanmu 回调扇入 background 的弹幕检测。长连接由开播门控驱动
// （setRooms() 按盯守房间列表增删连接），keepalive 心跳保活 + 断开指数退避重连。
// 采样短连与检测长连接为两个独立实例（连接互不干扰，见 ADR-0005）。

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

const FRAME_TYPE = 689;          // 弹幕数据帧类型
const SAMPLE_TIMEOUT_MS = 20000; // 采样超时：未开播房间无 oni 推送，到时查开播状态兜底上报 0
const KEEPALIVE_INTERVAL = 30000;    // 检测长连接心跳间隔（服务端约 45 秒无消息即断连）
const RECONNECT_BASE_DELAY = 2000;   // 检测长连接重连最小间隔
const RECONNECT_MAX_DELAY = 60000;   // 检测长连接重连最大间隔（指数退避）

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
 * 斗鱼弹幕客户端:采样模式每个房间一条短连解析 oni 推送贵宾数;检测模式保持长连接解析
 * chatmsg 推送弹幕文本（两种模式用不同实例，互不影响各自的连接）
 */
class BarrageClient {
  /**
   * @param {object} [options]
   * @param {(data: {roomId: string, vipCount: number}) => void} [options.onVipCount] 贵宾数回调（采样）
   * @param {(data: {roomId: string, text: string, user: string}) => void} [options.onDanmu] 弹幕文本回调（检测长连接）
   */
  constructor(options = {}) {
    this.onVipCount = options.onVipCount || null;
    this.onDanmu = options.onDanmu || null;
    this.connections = new Map(); // roomId -> { ws, timeoutTimer, retryTimer, keepaliveTimer, stopped }
    this.serverIndex = 0; // 采样端口轮换（8501-8505）
  }

  /**
   * 采样:每个房间一条连接,全部拿到贵宾数或超时后断开
   * @param {string[]} roomIds
   */
  sample(roomIds) {
    const ids = [...new Set(roomIds.map(String))];
    // 上一轮采样收尾
    for (const roomId of [...this.connections.keys()]) {
      this._disconnect(roomId);
    }
    if (ids.length === 0) {
      return;
    }
    for (const roomId of ids) {
      this._connect(roomId);
    }
  }

  /** 断开全部连接（测试/扩展卸载场景） */
  destroy() {
    for (const roomId of [...this.connections.keys()]) {
      this._disconnect(roomId);
    }
  }

  /** 建立某房间的采样连接（retried=true 表示这是超时后的重试连接） */
  _connect(roomId, retried = false) {
    const state = {
      roomId,
      ws: null,
      reported: false, // 已上报贵宾数（防止超时兜底重复上报）
      retried,         // 已因超时重试过一次（重试后仍超时则本轮跳过）
      timeoutTimer: setTimeout(() => this._handleTimeout(state), SAMPLE_TIMEOUT_MS),
      stopped: false
    };
    this.connections.set(roomId, state);
    this._openSocket(state);
  }

  /**
   * 采样超时：未开播房间不推送 oni，查房间开播状态兜底上报 0
   * 开播中但没收到 oni（网络抖动等）→ 立即重连重试一次，避免本轮漏采
   * （斗鱼页面未开播同样显示贵宾 0，不显示会让用户误以为漏采）
   */
  async _handleTimeout(state) {
    if (state.reported || state.stopped) {
      return;
    }
    this._disconnect(state.roomId);
    try {
      const resp = await fetch(`https://www.douyu.com/betard/${state.roomId}`);
      if (!resp.ok) {
        return;
      }
      const json = await resp.json();
      const showStatus = json && json.room ? json.room.show_status : undefined;
      if (showStatus !== 1) {
        console.log(`[dy] ${state.roomId} 未开播(show_status=${showStatus}), 按贵宾数 0 上报`);
        state.reported = true;
        this.onVipCount({ roomId: state.roomId, vipCount: 0 });
      } else if (!state.retried) {
        // 开播中但超时未收到 oni → 立即重试一次（重试连接有独立超时，仍超时则走下方跳过）
        console.warn(`[dy] ${state.roomId} 首次超时未收到 oni 但房间开播中, 立即重连重试一次`);
        this._connect(state.roomId, true);
      } else {
        console.warn(`[dy] ${state.roomId} 重试后仍超时未收到 oni 但房间开播中, 本轮跳过`);
      }
    } catch (e) {
      console.warn(`[dy] ${state.roomId} 查询开播状态失败: ${e.message}`);
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
    clearTimeout(state.retryTimer);
    clearInterval(state.keepaliveTimer);
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
   * 检测长连接模式（与 BilibiliBarrageClient.setRooms 同形）：对给定房间保持连接，
   * 持续回调 chatmsg 弹幕文本。
   * 幂等：已有的连接保留、多出的断开，供开播门控每轮轮询按盯守房间列表收敛
   * （SW 被回收后重连、下播断开都走同一个入口）。
   * @param {string[]} roomIds
   */
  setRooms(roomIds) {
    const ids = [...new Set(roomIds.map(String))];
    for (const roomId of [...this.connections.keys()]) {
      if (!ids.includes(roomId)) {
        this._disconnect(roomId);
      }
    }
    for (const roomId of ids) {
      if (!this.connections.has(roomId)) {
        this._connectLong(roomId);
      }
    }
  }

  /** 建立某房间的检测长连接 */
  _connectLong(roomId) {
    const state = {
      roomId,
      ws: null,
      retryDelay: RECONNECT_BASE_DELAY,
      retryTimer: null,
      keepaliveTimer: null,
      stopped: false
    };
    this.connections.set(roomId, state);
    this._openLongSocket(state);
  }

  /** 打开检测长连接：登录/订阅 + 心跳保活，断开按指数退避重连 */
  _openLongSocket(state) {
    if (state.stopped) {
      return;
    }
    const url = BARRAGE_SERVERS[this.serverIndex++ % BARRAGE_SERVERS.length];
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      console.log(`[dy] ${state.roomId} 检测长连接已建立, 发送 loginreq + joingroup`);
      state.retryDelay = RECONNECT_BASE_DELAY;
      this._sendJoin(ws, state.roomId);
      // 心跳保活：服务端长时间无消息会主动断开，检测需要长时间在线
      clearInterval(state.keepaliveTimer);
      state.keepaliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeFrame(`type@=keeplive/tick@=${Math.floor(Date.now() / 1000)}/`));
        }
      }, KEEPALIVE_INTERVAL);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = parseDyMessage(decodeFrame(event.data));
      } catch (e) {
        return;
      }
      // chatmsg 携带弹幕文本（txt）与发送者昵称（nn），交给检测计数
      if (msg.type === 'chatmsg') {
        this._emitDanmu(state, msg);
      }
    };

    ws.onclose = (e) => {
      clearInterval(state.keepaliveTimer);
      if (state.stopped) {
        return; // 主动断开（下播/停止盯守）
      }
      console.warn(`[dy] ${state.roomId} 检测长连接断开 code=${e.code}, ${state.retryDelay}ms 后重连`);
      this._scheduleRetryLong(state);
    };

    ws.onerror = () => {
      // 错误后必然触发 onclose,重连逻辑统一在 onclose 中处理
    };
  }

  /** 安排检测长连接重连（指数退避） */
  _scheduleRetryLong(state) {
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => {
      if (!state.stopped) {
        this._openLongSocket(state);
      }
    }, state.retryDelay);
    state.retryDelay = Math.min(state.retryDelay * 2, RECONNECT_MAX_DELAY);
  }

  /** 发送登录 + 加入房间分组（采样与长连接共用） */
  _sendJoin(ws, roomId) {
    const username = 'visitor' + String(Math.floor(Math.random() * 10000000)).padStart(7, '0');
    const uid = String(Math.floor(Math.random() * 9000000000) + 1000000000);
    ws.send(encodeFrame(`type@=loginreq/roomid@=${roomId}/dfl@=/username@=${username}/uid@=${uid}/ver@=${LOGIN_VERSION}/aver@=${COUNT_VERSION}/ct@=0/`));
    ws.send(encodeFrame(`type@=joingroup/rid@=${roomId}/gid@=1/`));
  }

  /** chatmsg 命中：把弹幕文本与发送者交给检测（无 onDanmu 回调时忽略） */
  _emitDanmu(state, msg) {
    if (this.onDanmu && msg.txt !== undefined) {
      this.onDanmu({ roomId: state.roomId, text: msg.txt, user: msg.nn || '' });
    }
  }

  /** 打开采样 WebSocket 并登录/订阅该房间 */
  _openSocket(state) {
    const url = BARRAGE_SERVERS[this.serverIndex++ % BARRAGE_SERVERS.length];
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      console.log(`[dy] ${state.roomId} 已连接, 发送 loginreq + joingroup`);
      // 随机 visitor 身份登录（无需签名）并加入房间分组
      this._sendJoin(ws, state.roomId);
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
        if (isNaN(vipCount)) {
          // oni 无 vn 字段（未开通贵宾的房间）→ 贵宾数为 0，按 0 上报避免挂到超时
          console.log(`[dy] ${state.roomId} oni 无 vn 字段, 按贵宾数 0 上报`);
          state.reported = true;
          this.onVipCount({ roomId: state.roomId, vipCount: 0 });
        } else {
          console.log(`[dy] ${state.roomId} 贵宾数=${vipCount}`);
          state.reported = true;
          this.onVipCount({ roomId: state.roomId, vipCount });
        }
        this._disconnect(state.roomId); // 采样模式：拿到即断开
      } else if (msg.type === 'chatmsg') {
        this._emitDanmu(state, msg);
      }
    };

    ws.onclose = (e) => {
      // 异常断开（非主动关闭）→ 该房间本轮失败，收尾等下一轮采样；
      // 主动断开时 state.stopped 已为 true，直接返回
      if (!state.stopped) {
        console.warn(`[dy] ${state.roomId} 异常断开 code=${e.code}`);
        this._disconnect(state.roomId);
      }
    };

    ws.onerror = () => {
      // 错误后必然触发 onclose,收尾逻辑统一在 onclose 中处理
    };
  }
}
