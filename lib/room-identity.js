// lib/room-identity.js — 房间标识：房间身份的全部查询与由平台决定的房间事实
//
// 术语（见 CONTEXT.md）：
// - 房间号 (roomId)：用户在设置页输入的编号，字符串形式，必须是纯数字
// - 房间标识 (room identity)：`platform + roomId` 组成的复合键（字符串形式 `platform_roomId`），
//   以及由平台决定的房间事实——展示标签、观众数指标文案与存储字段、平台观众数开关、直播间 URL
//
// 这是这批知识的唯一来源：拼键、拆键、旧格式（条目缺 platform）的兜底目标、房间号校验，
// 以及每个平台的房间事实都只在这里写一次。房间库、编排、设置页、弹窗只接收它的结论。
//
// 表私有、只导出查询：消费方写得出 `RoomIdentity.viewerMetric(p)`，写不出 `PLATFORMS[p].label`；
// 因此表的形状（平铺还是嵌套、字段叫什么）日后还能改。
// 判定类常量不搬进来（如弹幕检测的「有无弹幕通道」跟着它自己的判定走），归属判据见 ADR-0005。
//
// 零依赖：不引用 chrome / storage / 任何其他 lib。UMD 双兼容：SW 的 importScripts 与两个页面的
// <script> 下是全局 `RoomIdentity`，node 下可 require 取到同一个对象。加载位置必须排在被依赖者之前。

const RoomIdentity = (() => {
  // 平台表（私有）：新增平台在这里加一行，消费方不必动
  const PLATFORMS = {
    douyu: {
      label: '斗鱼',
      metric: Object.freeze({ label: '贵宾数', shortLabel: '贵宾' }),
      viewerField: 'vipCount',
      viewerToggle: 'fetchDouyuViewerCount',
      liveUrlBase: 'https://www.douyu.com'
    },
    bilibili: {
      label: 'B站',
      metric: Object.freeze({ label: '高能榜在线数', shortLabel: '高能榜' }),
      viewerField: 'rankCount',
      viewerToggle: 'fetchBilibiliViewerCount',
      liveUrlBase: 'https://live.bilibili.com'
    }
  };

  const PLATFORM_IDS = Object.freeze(['douyu', 'bilibili']); // 顺序即轮询 / 展示顺序
  const DEFAULT_PLATFORM = 'douyu'; // 旧格式（条目缺 platform）的兜底目标

  const entry = platform => (Object.prototype.hasOwnProperty.call(PLATFORMS, platform) ? PLATFORMS[platform] : null);

  /** 合法的平台取值（未知平台一律返回 null，由调用方决定忽略还是拒绝） */
  function isPlatform(value) {
    return entry(value) !== null;
  }

  /** 平台展示标签；通知前缀由调用方拼 `[${label}]`。未知平台返回 null */
  function platformLabel(platform) {
    const found = entry(platform);
    return found ? found.label : null;
  }

  /** 观众数指标文案（通知正文与页面文案同源）。未知平台返回 null */
  function viewerMetric(platform) {
    const found = entry(platform);
    return found ? found.metric : null;
  }

  /** 观众数在 streamers 条目上的存储字段。未知平台返回 null */
  function viewerField(platform) {
    const found = entry(platform);
    return found ? found.viewerField : null;
  }

  /** 平台观众数开关在 settings 上的键名。未知平台返回 null */
  function viewerToggle(platform) {
    const found = entry(platform);
    return found ? found.viewerToggle : null;
  }

  /** 直播间 URL（ref = {platform, roomId}）。未知平台返回 null，由调用方决定忽略 */
  function liveUrl(ref) {
    const found = entry(ref && ref.platform);
    return found ? `${found.liveUrlBase}/${String(ref.roomId)}` : null;
  }

  /**
   * 复合键 `platform_roomId`（存储里存的是对象，复合键只在内存与通知 ID 里出现）。
   * ref 的 platform 来自已归一的条目（房间库的读取入口保证它存在），因此这里不做校验。
   * @param {{platform: string, roomId: string}} ref
   */
  function roomKey(ref) {
    return `${ref.platform}_${ref.roomId}`;
  }

  /**
   * 拆复合键：房间号恒为纯数字（见 CONTEXT.md），因此按第一个 `_` 切分（房间号里不会有 `_`）。
   * 未知平台或没带房间号返回 null，由调用方决定忽略。
   * @param {string} key 复合键（调用方负责先剥掉通知 ID 的后缀）
   * @returns {{platform: string, roomId: string}|null}
   */
  function roomRefFromKey(key) {
    const text = String(key ?? '');
    const index = text.indexOf('_');
    if (index <= 0 || index === text.length - 1) {
      return null;
    }
    const platform = text.slice(0, index);
    if (!isPlatform(platform)) {
      return null;
    }
    return { platform, roomId: text.slice(index + 1) };
  }

  /** 房间号校验：纯数字（接受数字形态与前后空白，其余一律 false） */
  function isRoomId(value) {
    return /^\d+$/.test(String(value ?? '').trim());
  }

  /** 房间号相等：存储与消息里可能是数字形态，统一按字符串比较 */
  function sameRoomId(a, b) {
    return String(a) === String(b);
  }

  return Object.freeze({
    PLATFORM_IDS,
    DEFAULT_PLATFORM,
    isPlatform,
    platformLabel,
    viewerMetric,
    viewerField,
    viewerToggle,
    liveUrl,
    roomKey,
    roomRefFromKey,
    isRoomId,
    sameRoomId
  });
})();

// UMD 双兼容：SW 的 importScripts 与页面 <script> 下 module 未定义自动跳过；node 下可 require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RoomIdentity };
}
