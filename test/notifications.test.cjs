// test/notifications.test.cjs — 通知 module 的纯计算单元测试
//
// 运行：npm test（node --test）
// 覆盖：通知 ID 构造 / 解析往返（含无后缀的开播、变长 `_sub_<id>` 订阅）、未知 ID 与非房间通知返回 null、
// 种类完备性、总开关声明与四个规则 module 的判定交叉校验、六类文案（含订阅文案从 subscription-alert 迁来）。
// 注入真实房间标识 module（与房间库同一套做法）；只断言导出接口的行为，不断言私有登记表的字段名。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { KIND_IDS, createNotifications } = require('../lib/notifications.js');
const { RoomIdentity } = require('../lib/room-identity.js');
const viewerAlert = require('../lib/viewer-alert.js');
const danmakuWatch = require('../lib/danmaku-watch.js');
const danmakuSurge = require('../lib/danmaku-surge.js');
const highlightAlert = require('../lib/highlight-alert.js');

const notifications = createNotifications({ identity: RoomIdentity });

// === ID 体系：构造与解析成对互逆 ===

test('ID 往返：parse(build(kind, facts).id) 还原种类与房间身份', () => {
  const cases = [
    {
      kind: 'live',
      facts: { platform: 'douyu', roomId: '100' },
      id: 'douyu_100',
      parsed: { kind: 'live', platform: 'douyu', roomId: '100' }
    },
    {
      kind: 'watch',
      facts: { platform: 'douyu', roomId: '100' },
      id: 'douyu_100_watch',
      parsed: { kind: 'watch', platform: 'douyu', roomId: '100' }
    },
    {
      kind: 'viewer',
      facts: { platform: 'bilibili', roomId: '200' },
      id: 'bilibili_200_viewer',
      parsed: { kind: 'viewer', platform: 'bilibili', roomId: '200' }
    },
    {
      kind: 'surge',
      facts: { platform: 'douyu', roomId: '100' },
      id: 'douyu_100_surge',
      parsed: { kind: 'surge', platform: 'douyu', roomId: '100' }
    },
    {
      kind: 'highlight',
      facts: { platform: 'douyu', roomId: '100' },
      id: 'douyu_100_highlight',
      parsed: { kind: 'highlight', platform: 'douyu', roomId: '100' }
    },
    {
      kind: 'subscription',
      facts: { platform: 'douyu', roomId: '100', subscriptionId: 's7' },
      id: 'douyu_100_sub_s7',
      parsed: { kind: 'subscription', platform: 'douyu', roomId: '100', subscriptionId: 's7' }
    }
  ];

  for (const { kind, facts, id, parsed } of cases) {
    const built = notifications.build(kind, facts);
    assert.equal(built.id, id, `${kind} 的 ID 形状`);
    assert.deepEqual(notifications.parse(built.id), parsed, `${kind} 的解析往返`);
  }
});

test('无后缀的开播通知：解析回开播种类', () => {
  assert.deepEqual(
    notifications.parse('douyu_100'),
    { kind: 'live', platform: 'douyu', roomId: '100' }
  );
});

test('变长订阅后缀：同一房间的多条订阅各自解析回同一房间、各自的订阅 id', () => {
  const facts = { platform: 'douyu', roomId: '100', nickname: '昵称100', online: false };
  const first = notifications.build('subscription', { ...facts, subscriptionId: 's1' });
  const second = notifications.build('subscription', { ...facts, subscriptionId: 's2' });

  assert.equal(first.id, 'douyu_100_sub_s1');
  assert.equal(second.id, 'douyu_100_sub_s2');
  assert.deepEqual(
    notifications.parse(first.id),
    { kind: 'subscription', platform: 'douyu', roomId: '100', subscriptionId: 's1' }
  );
  assert.deepEqual(
    notifications.parse(second.id),
    { kind: 'subscription', platform: 'douyu', roomId: '100', subscriptionId: 's2' }
  );
});

test('未知 ID 与非房间通知（渠道降级提示）解析为 null：点击不跳错误页面', () => {
  const unknown = ['', null, undefined, 'nonsense', 'douyu', 'douyu_100_unknown', 'bili_bridge_fallback'];
  for (const id of unknown) {
    assert.equal(notifications.parse(id), null, `${String(id)} 应解析为 null`);
  }
});

test('种类完备性：KIND_IDS 含六类，每类都能构造出以房间复合键为前缀的 ID', () => {
  assert.deepEqual(
    [...KIND_IDS].sort(),
    ['highlight', 'live', 'subscription', 'surge', 'viewer', 'watch']
  );
  for (const kind of KIND_IDS) {
    const { id } = notifications.build(kind, { platform: 'douyu', roomId: '100', subscriptionId: 's1' });
    assert.ok(id.startsWith('douyu_100'), `${kind} 的 ID 以房间复合键为前缀：${id}`);
  }
});

// === 总开关：登记表的声明与各规则 module 的判定钉在一起 ===

test('总开关交叉校验：声明键置 false 时对应规则 module 也判不启用', () => {
  const table = [
    { kind: 'watch', key: 'danmakuWatchEnabled', isEnabled: danmakuWatch.isDanmakuWatchEnabled },
    { kind: 'viewer', key: 'viewerAlertEnabled', isEnabled: viewerAlert.isViewerAlertEnabled },
    { kind: 'surge', key: 'surgeAlertEnabled', isEnabled: danmakuSurge.isSurgeAlertEnabled },
    { kind: 'highlight', key: 'highlightAlertEnabled', isEnabled: highlightAlert.isHighlightAlertEnabled }
  ];

  for (const { kind, key, isEnabled } of table) {
    assert.equal(notifications.isMasterSwitchOn(kind, { [key]: false }), false, `${kind}：声明的开关关闭即不放行`);
    assert.equal(isEnabled({ [key]: false }), false, `${kind}：规则 module 同样判不启用`);
    assert.equal(notifications.isMasterSwitchOn(kind, { [key]: true }), true, `${kind}：开启即放行`);
    assert.equal(isEnabled({ [key]: true }), true);
    assert.equal(
      notifications.isMasterSwitchOn(kind, { notificationsEnabled: false, [key]: true }),
      true,
      `${kind}：不受别的总开关牵动`
    );
  }
});

test('开播与订阅的总开关声明键是全局 notificationsEnabled（只声明、不改行为）', () => {
  for (const kind of ['live', 'subscription']) {
    assert.equal(notifications.isMasterSwitchOn(kind, { notificationsEnabled: false }), false, `${kind} 关闭总开关即不放行`);
    assert.equal(notifications.isMasterSwitchOn(kind, { notificationsEnabled: true }), true);
    assert.equal(notifications.isMasterSwitchOn(kind, {}), true, `${kind} 缺省视为开启`);
    assert.equal(notifications.isMasterSwitchOn(kind, undefined), true);
  }
  assert.equal(notifications.isMasterSwitchOn('live', { danmakuWatchEnabled: false }), true, '别的开关不牵动开播');
  assert.equal(notifications.isMasterSwitchOn('subscription', { viewerAlertEnabled: false }), true, '别的开关不牵动订阅');
  assert.equal(notifications.isMasterSwitchOn('unknown-kind', {}), false, '未知种类不放行');
});

// === 六类文案 ===

test('六类文案表驱动：facts → 标题 / 正文 / 上下文行', () => {
  const cases = [
    {
      kind: 'live',
      facts: { platform: 'douyu', roomId: '100', nickname: '昵称100', title: '在播', category: '游戏' },
      content: { title: '[斗鱼] 昵称100 开播了！', message: '在播', contextMessage: '游戏' }
    },
    {
      kind: 'live',
      facts: {
        platform: 'bilibili', roomId: '200', nickname: '昵称200',
        title: '在播', category: '虚拟主播', viewerCount: 12000
      },
      content: { title: '[B站] 昵称200 开播了！', message: '在播', contextMessage: '虚拟主播 · 1.2万 高能榜' }
    },
    {
      kind: 'watch',
      facts: {
        platform: 'douyu', roomId: '100', nickname: '昵称100',
        keyword: '上车', text: '上车+1', user: '观众甲', count: 2, windowMinutes: 5
      },
      content: {
        title: '[斗鱼] 昵称100 弹幕命中！',
        message: '观众甲：上车+1',
        contextMessage: '5 分钟内「上车」命中 2 次'
      }
    },
    {
      kind: 'viewer',
      facts: { platform: 'douyu', roomId: '100', nickname: '昵称100', value: 5000, threshold: 3000, streamerTitle: '在播' },
      content: { title: '[斗鱼] 昵称100 贵宾数超过 3000！', message: '当前 5000 贵宾', contextMessage: '在播' }
    },
    {
      kind: 'surge',
      facts: {
        platform: 'douyu', roomId: '100', nickname: '昵称100',
        bucketCount: 100, baseline: 10, sample: '这波五杀太秀了吧', streamerTitle: '在播中'
      },
      content: {
        title: '[斗鱼] 昵称100 弹幕激增！',
        message: '上一分钟 100 条，平时约 10 条\n「这波五杀太秀了吧」',
        contextMessage: '在播中'
      }
    },
    {
      kind: 'highlight',
      facts: {
        platform: 'douyu', roomId: '100', nickname: '昵称100',
        highlightTitle: '最新的一条', count: 3, streamerTitle: '在播中'
      },
      content: {
        title: '[斗鱼] 昵称100 有新看点！',
        message: '最新的一条\n另有 2 条',
        contextMessage: '在播中'
      }
    },
    {
      kind: 'subscription',
      facts: {
        platform: 'douyu', roomId: '100', subscriptionId: 's1',
        nickname: '主播甲', online: true, title: '今天的直播'
      },
      content: { title: '[斗鱼] 主播甲 订阅到点了！', message: '正在直播：今天的直播' }
    }
  ];

  for (const { kind, facts, content } of cases) {
    assert.deepEqual(notifications.build(kind, facts).content, content, `${kind} 的文案`);
  }
});

test('开播文案：没有观众数统计时上下文行只有分类', () => {
  const { content } = notifications.build('live', {
    platform: 'douyu', roomId: '100', nickname: '昵称100', title: '在播', category: '游戏', viewerCount: 0
  });
  assert.equal(content.contextMessage, '游戏');
  const noCategory = notifications.build('live', {
    platform: 'douyu', roomId: '100', nickname: '昵称100', title: '在播'
  });
  assert.equal(noCategory.content.contextMessage, '');
});

test('观众数文案：B站指标是高能榜在线数，数值放正文、标题降为上下文行', () => {
  const { content } = notifications.build('viewer', {
    platform: 'bilibili', roomId: '200', nickname: '昵称200', value: 5000, threshold: 3000, streamerTitle: '第二场'
  });
  assert.equal(content.title, '[B站] 昵称200 高能榜在线数超过 3000！');
  assert.equal(content.message, '当前 5000 高能榜');
  assert.equal(content.contextMessage, '第二场');
});

test('主体缺失时的正文回退：房间标题缺省用「正在直播」', () => {
  const viewer = notifications.build('viewer', {
    platform: 'douyu', roomId: '100', nickname: '昵称100', value: 1, threshold: 0
  });
  assert.equal(viewer.content.contextMessage, '正在直播', '无房间标题：观众数提醒回退「正在直播」');

  const live = notifications.build('live', { platform: 'douyu', roomId: '100', nickname: '昵称100' });
  assert.equal(live.content.message, '正在直播', '无标题：开播通知回退「正在直播」');
});

test('激增文案：无合格样本时只报条数', () => {
  const { content } = notifications.build('surge', {
    platform: 'douyu', roomId: '100', nickname: '昵称100',
    bucketCount: 100, baseline: 10, sample: null, streamerTitle: '在播中'
  });
  assert.equal(content.message, '上一分钟 100 条，平时约 10 条');
});

test('看点文案：标题为空回退「新看点」，单条不加「另有」', () => {
  const base = { platform: 'douyu', roomId: '100', nickname: '昵称100', streamerTitle: '在播中' };
  assert.equal(notifications.build('highlight', { ...base, highlightTitle: '', count: 1 }).content.message, '新看点');
  assert.equal(notifications.build('highlight', { ...base, highlightTitle: '唯一一条', count: 1 }).content.message, '唯一一条');
});

test('检测文案：弹幕文本超过 60 字截断并加省略号', () => {
  const long = 'a'.repeat(61);
  const { content } = notifications.build('watch', {
    platform: 'douyu', roomId: '100', nickname: '昵称100',
    keyword: 'k', text: long, user: '观众甲', count: 1, windowMinutes: 5
  });
  assert.equal(content.message, `观众甲：${'a'.repeat(60)}…`);
});

test('订阅文案（自 subscription-alert 迁来）：在播附标题、无标题回退、未播写明、房间移除回退平台房间号', () => {
  const base = { platform: 'douyu', roomId: '100', subscriptionId: 's1' };

  assert.deepEqual(
    notifications.build('subscription', { ...base, nickname: '主播甲', online: true, title: '今天的直播' }).content,
    { title: '[斗鱼] 主播甲 订阅到点了！', message: '正在直播：今天的直播' }
  );
  assert.equal(
    notifications.build('subscription', { ...base, nickname: '主播甲', online: true }).content.message,
    '正在直播：正在直播',
    '在播但没有标题时回退「正在直播」'
  );
  assert.equal(
    notifications.build('subscription', { ...base, nickname: '主播甲', online: false }).content.message,
    '当前未开播'
  );
  assert.deepEqual(
    notifications.build('subscription', { ...base, online: false }).content,
    { title: '[斗鱼] 斗鱼 100 订阅到点了！', message: '当前未开播' },
    '房间已被移除（无昵称）：回退「平台 房间号」'
  );
  assert.equal(
    notifications.build('subscription', {
      platform: 'bilibili', roomId: '200', subscriptionId: 's1', nickname: '昵称200', online: true, title: 'B站在播'
    }).content.title,
    '[B站] 昵称200 订阅到点了！'
  );
});
