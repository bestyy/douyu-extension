// lib/notifications.js — 通知 module：六种通知种类的登记表（后缀 / 总开关 / 文案）与通知 ID 体系
//
// 术语（见 CONTEXT.md）：
// - 通知种类 (notification kind)：开播 / 检测 / 观众数 / 激增 / 看点 / 订阅六种之一
// - 通知 module (notification module)：拥有登记表与 ID 体系，只回答「一条通知长什么样、ID 是什么」
//
// 本模块独占两件事（照 ADR-0005「纯规则模块各自持有常量」与 ADR-0018）：
// 1. 通知 ID 的构造与解析成对互逆：由种类与房间复合键构造（build），并反向还原种类与房间身份（parse）。
//    后缀表只此一处——构造与解析读同一张登记表，因此改后缀不会两处漂移。
// 2. 六种通知的文案构造：平台前缀、观众数指标文案、数字格式化、弹幕文本截断、拼接与截断全在这里；
//    订阅通知的标题 / 正文也从 lib/subscription-alert.js 迁来（订阅判定留在原地）。
//
// 它不判定「该不该发」（门控与边沿判定分属各规则 module 与编排）、不发送（发送归入口的通知适配器）、
// 不持有状态。登记表私有：消费方写得出 build / parse / isMasterSwitchOn，写不出表里的字段
// （后缀 / 开关名 / 文案构造），日后改表形状不算破坏性变更。
//
// 注入「房间标识」module（复合键 / 平台标签 / 观众数指标的唯一来源，见 ADR-0005），
// 因此零 `import`、加载位置不受约束（与房间库注入 identity 同一套做法，见 ADR-0018 第三条）。
//
// 渠道降级提示（ID 字面量 `bili_bridge_fallback`）不是「通知种类」：无房间身份、无总开关、
// 自定义 priority / buttons，是通道的运维通知，不进登记表；它的 ID 会被 parse 判为 null，点击无操作。
//
// 总开关语义只声明、不改行为（见 ADR-0006 / ADR-0016 / ADR-0018 第四条）：`settings.notificationsEnabled`
// 名为全局，实际只管开播与订阅；其余四种各归自己的总开关。登记表显式声明每类受哪个开关管。
//
// UMD 双兼容：SW 经 importScripts 加载（全局 createNotifications / KIND_IDS），node 下可 require。

/** 六种通知种类的名字列表（顺序即解析时剥固定后缀的顺序；开播无后缀，循环里被跳过、循环后兜底） */
const KIND_IDS = Object.freeze(['live', 'watch', 'viewer', 'surge', 'highlight', 'subscription']);

/** 订阅通知 ID 的中缀：后面跟变长的订阅 id，因此不在固定后缀表里 */
const SUBSCRIPTION_MARKER = '_sub_';

/**
 * 通知 module 工厂：注入房间标识 module（零 import，与房间库同一套做法）。
 * @param {{identity: object}} deps identity 房间标识 module（roomKey / roomRefFromKey / platformLabel /
 *        viewerMetric / isRoomId）
 */
function createNotifications({ identity } = {}) {
  if (!identity) {
    throw new Error('通知 module 需要注入房间标识 module');
  }

  // === 文案构造的共用件（数字格式化与弹幕文本截断只此一份）===

  /** 数字格式化：>= 1 万显示 x.x万，否则原样（口径与之前编排里那份一致） */
  function formatNumber(num) {
    if (num >= 10000) {
      return (num / 10000).toFixed(1) + '万';
    }
    return String(num);
  }

  /** 通知正文里的弹幕文本截断（过长会被系统截断成不可读） */
  function truncateDanmu(text) {
    const str = String(text || '');
    return str.length > 60 ? `${str.slice(0, 60)}…` : str;
  }

  /** 通知标题的平台前缀（与 popup / 设置页的平台标签同源） */
  function prefix(platform) {
    return `[${identity.platformLabel(platform)}]`;
  }

  // === 六种通知的文案构造（facts 传领域数据，展示计算全在这里）===

  /**
   * 开播通知：标题报开播，正文是房间标题，上下文行是分类与观众数统计。
   * @param {{platform, roomId, nickname, title, category, viewerCount}} facts
   */
  function buildLive(facts) {
    const metric = identity.viewerMetric(facts.platform);
    const count = facts.viewerCount;
    const statText = metric && typeof count === 'number' && count > 0
      ? `${formatNumber(count)} ${metric.shortLabel}`
      : '';
    return {
      title: `${prefix(facts.platform)} ${facts.nickname} 开播了！`,
      message: facts.title || '正在直播',
      contextMessage: [facts.category, statText].filter(Boolean).join(' · ')
    };
  }

  /**
   * 检测通知：正文是「观众：命中的弹幕」，上下文行是窗口与命中次数。
   * @param {{platform, roomId, nickname, keyword, text, user, count, windowMinutes}} facts
   */
  function buildWatch(facts) {
    const body = facts.user ? `${facts.user}：${truncateDanmu(facts.text)}` : truncateDanmu(facts.text);
    return {
      title: `${prefix(facts.platform)} ${facts.nickname} 弹幕命中！`,
      message: body,
      contextMessage: `${facts.windowMinutes} 分钟内「${facts.keyword}」命中 ${facts.count} 次`
    };
  }

  /**
   * 观众数提醒：数值放正文（Windows 上只有正文保证渲染），房间标题降为上下文行。
   * @param {{platform, roomId, nickname, value, threshold, streamerTitle}} facts
   */
  function buildViewer(facts) {
    const meta = identity.viewerMetric(facts.platform);
    return {
      title: `${prefix(facts.platform)} ${facts.nickname} ${meta.label}超过 ${facts.threshold}！`,
      message: `当前 ${formatNumber(facts.value)} ${meta.shortLabel}`,
      contextMessage: facts.streamerTitle || '正在直播'
    };
  }

  /**
   * 弹幕激增：条数与样本弹幕都放正文（上下文行在 Windows 上不渲染），房间标题仍在上下文行。
   * @param {{platform, roomId, nickname, bucketCount, baseline, sample, streamerTitle}} facts
   */
  function buildSurge(facts) {
    const message = `上一分钟 ${formatNumber(facts.bucketCount)} 条，平时约 ${formatNumber(Math.round(facts.baseline))} 条`
      + (facts.sample ? `\n「${truncateDanmu(facts.sample)}」` : '');
    return {
      title: `${prefix(facts.platform)} ${facts.nickname} 弹幕激增！`,
      message,
      contextMessage: facts.streamerTitle || '正在直播'
    };
  }

  /**
   * 看点通知：正文放看点标题（一次发现多条时补一行「另有 N 条」），房间标题放上下文行。
   * @param {{platform, roomId, nickname, highlightTitle, count, streamerTitle}} facts
   */
  function buildHighlight(facts) {
    const title = facts.highlightTitle || '新看点';
    return {
      title: `${prefix(facts.platform)} ${facts.nickname} 有新看点！`,
      message: facts.count > 1 ? `${title}\n另有 ${facts.count - 1} 条` : title,
      contextMessage: facts.streamerTitle || '正在直播'
    };
  }

  /**
   * 订阅通知（文案从 lib/subscription-alert.js 迁来）：到点无条件发，正文只报触发时的开播状态。
   * 显示名优先用房间 / 主播快照的昵称，解析不到（房间已被移除）时回退为「平台 房间号」。
   * 这条回退口径与 lib/subscription-alert.js 的 subscriptionDisplayName（供页面渲染订阅行）相同，
   * 本 module 零 `import`、无法调用它，故有意各写一份；改口径时两处都要动。
   * @param {{platform, roomId, subscriptionId, nickname, online, title}} facts
   */
  function buildSubscription(facts) {
    const label = identity.platformLabel(facts.platform) || facts.platform || '';
    const displayName = facts.nickname || `${label} ${facts.roomId}`;
    const message = facts.online === true
      ? `正在直播：${facts.title || '正在直播'}`
      : '当前未开播';
    return {
      title: `[${label}] ${displayName} 订阅到点了！`,
      message
    };
  }

  // === 登记表（私有）：种类 → 后缀 / 总开关键 / 文案构造 ===
  // 消费方只能通过下面的查询函数间接用到它。
  const REGISTRY = {
    live: { suffix: '', switchKey: 'notificationsEnabled', build: buildLive },
    watch: { suffix: '_watch', switchKey: 'danmakuWatchEnabled', build: buildWatch },
    viewer: { suffix: '_viewer', switchKey: 'viewerAlertEnabled', build: buildViewer },
    surge: { suffix: '_surge', switchKey: 'surgeAlertEnabled', build: buildSurge },
    highlight: { suffix: '_highlight', switchKey: 'highlightAlertEnabled', build: buildHighlight },
    subscription: { suffix: SUBSCRIPTION_MARKER, switchKey: 'notificationsEnabled', variable: true, build: buildSubscription }
  };

  // === ID 体系：构造与解析成对互逆 ===

  /**
   * 由种类与领域事实构造通知 ID 与通知内容。
   * ID 前缀是房间复合键（供点击进入直播间）：开播为 `platform_roomId`，检测 / 观众数 / 激增 / 看点
   * 各带固定后缀，订阅为 `<复合键>_sub_<订阅 id>`（变长，保证同一房间的多条订阅各弹各的）。
   * @param {string} kind 通知种类（KIND_IDS 之一）
   * @param {object} facts 该类所需的领域数据
   * @returns {{id: string, content: {title: string, message: string, contextMessage?: string}}}
   */
  function build(kind, facts) {
    const spec = REGISTRY[kind];
    if (!spec) {
      throw new Error(`未知通知种类: ${kind}`);
    }
    const base = identity.roomKey({ platform: facts.platform, roomId: facts.roomId });
    const id = spec.variable
      ? `${base}${spec.suffix}${facts.subscriptionId}`
      : `${base}${spec.suffix}`;
    return { id, content: spec.build(facts) };
  }

  /** 拆出的房间身份是否成立：平台已知且房间号是纯数字（房间号里不会有 `_`，未知 ID 由此被挡下） */
  function isUsableRoomRef(ref) {
    return !!ref && identity.isRoomId(ref.roomId);
  }

  /**
   * 解析通知 ID，还原种类与房间身份（与 build 成对互逆）。
   * 未知 ID 与非房间通知（如渠道降级提示）返回 null，点击处理器据此静默无操作、不跳错误页面。
   * @param {string} notificationId
   * @returns {{kind: string, platform: string, roomId: string, subscriptionId?: string}|null}
   */
  function parse(notificationId) {
    const id = String(notificationId ?? '');
    if (!id) {
      return null;
    }
    // 订阅的 `_sub_<id>` 是变长的，优先在第一个 `_sub_` 处截断（房间号是纯数字，前缀里不会出现 `_sub_`）
    const subIndex = id.indexOf(SUBSCRIPTION_MARKER);
    if (subIndex > 0) {
      const ref = identity.roomRefFromKey(id.slice(0, subIndex));
      if (!isUsableRoomRef(ref)) {
        return null;
      }
      return {
        kind: 'subscription',
        platform: ref.platform,
        roomId: ref.roomId,
        subscriptionId: id.slice(subIndex + SUBSCRIPTION_MARKER.length)
      };
    }
    // 四种固定后缀：剥掉后还原房间复合键
    for (const kind of KIND_IDS) {
      const suffix = REGISTRY[kind].suffix;
      if (suffix && id.endsWith(suffix)) {
        const ref = identity.roomRefFromKey(id.slice(0, -suffix.length));
        if (!isUsableRoomRef(ref)) {
          return null;
        }
        return { kind, platform: ref.platform, roomId: ref.roomId };
      }
    }
    // 无后缀即开播通知
    const ref = identity.roomRefFromKey(id);
    if (!isUsableRoomRef(ref)) {
      return null;
    }
    return { kind: 'live', platform: ref.platform, roomId: ref.roomId };
  }

  /**
   * 该通知种类是否被它的总开关放行（只声明登记表里的开关键，不改任何开关语义）。
   * 缺省视为开启（旧版本无该字段），与各规则 module 的 `isXxxEnabled` 同一口径。
   * @param {string} kind 通知种类
   * @param {object} [settings] 存储中的 settings
   * @returns {boolean}
   */
  function isMasterSwitchOn(kind, settings) {
    const spec = REGISTRY[kind];
    if (!spec) {
      return false;
    }
    return settings?.[spec.switchKey] !== false;
  }

  return Object.freeze({ build, parse, isMasterSwitchOn });
}

// UMD 双兼容：SW 的 importScripts 下 module 未定义自动跳过；node 下可 require 测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KIND_IDS, createNotifications };
}
