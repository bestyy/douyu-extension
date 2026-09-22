// test/room-identity.test.cjs — 房间标识（lib/room-identity.js）行为测试
//
// 运行：npm test（node --test）
// 覆盖：平台事实查询（标签 / 指标文案 / 存储字段 / 观众数开关键 / 直播间 URL）、复合键的拼与拆、
// 旧格式兜底目标、房间号校验，以及「表不导出」这条接口边界。
// 零依赖 module，进程内直接 require，不需要装配 service worker 或 DOM。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const roomIdentity = require('../lib/room-identity.js');
const { RoomIdentity } = roomIdentity;

// === 平台列表与兜底目标 ===

test('PLATFORM_IDS 是轮询 / 展示顺序的唯一来源，DEFAULT_PLATFORM 是旧格式兜底目标', () => {
  assert.deepEqual(RoomIdentity.PLATFORM_IDS, ['douyu', 'bilibili']);
  assert.equal(RoomIdentity.DEFAULT_PLATFORM, 'douyu');
  assert.ok(RoomIdentity.PLATFORM_IDS.includes(RoomIdentity.DEFAULT_PLATFORM));
});

test('isPlatform：已知平台为真，未知取值、缺字段、非字符串一律为假', () => {
  assert.equal(RoomIdentity.isPlatform('douyu'), true);
  assert.equal(RoomIdentity.isPlatform('bilibili'), true);
  assert.equal(RoomIdentity.isPlatform('kuaishou'), false);
  assert.equal(RoomIdentity.isPlatform(undefined), false);
  assert.equal(RoomIdentity.isPlatform(null), false);
  assert.equal(RoomIdentity.isPlatform(''), false);
  assert.equal(RoomIdentity.isPlatform(0), false);
  assert.equal(RoomIdentity.isPlatform('DOUYU'), false);
});

// === 平台事实 ===

test('platformLabel：斗鱼 / B站；未知平台返回 null（不静默当成斗鱼）', () => {
  assert.equal(RoomIdentity.platformLabel('douyu'), '斗鱼');
  assert.equal(RoomIdentity.platformLabel('bilibili'), 'B站');
  assert.equal(RoomIdentity.platformLabel('kuaishou'), null);
  assert.equal(RoomIdentity.platformLabel(undefined), null);
});

test('viewerMetric：通知与页面同源的指标文案；未知平台返回 null', () => {
  assert.deepEqual(RoomIdentity.viewerMetric('douyu'), { label: '贵宾数', shortLabel: '贵宾' });
  assert.deepEqual(RoomIdentity.viewerMetric('bilibili'), { label: '高能榜在线数', shortLabel: '高能榜' });
  assert.equal(RoomIdentity.viewerMetric('kuaishou'), null);
});

test('viewerField / viewerToggle：观众数的存储字段与开关的 settings 键名；未知平台返回 null', () => {
  assert.equal(RoomIdentity.viewerField('douyu'), 'vipCount');
  assert.equal(RoomIdentity.viewerField('bilibili'), 'rankCount');
  assert.equal(RoomIdentity.viewerField('kuaishou'), null);

  assert.equal(RoomIdentity.viewerToggle('douyu'), 'fetchDouyuViewerCount');
  assert.equal(RoomIdentity.viewerToggle('bilibili'), 'fetchBilibiliViewerCount');
  assert.equal(RoomIdentity.viewerToggle('kuaishou'), null);
});

test('liveUrl：按平台拼直播间 URL，房间号取数字形态也能拼；未知平台返回 null', () => {
  assert.equal(RoomIdentity.liveUrl({ platform: 'douyu', roomId: '100' }), 'https://www.douyu.com/100');
  assert.equal(RoomIdentity.liveUrl({ platform: 'bilibili', roomId: '200' }), 'https://live.bilibili.com/200');
  assert.equal(RoomIdentity.liveUrl({ platform: 'douyu', roomId: 100 }), 'https://www.douyu.com/100');
  assert.equal(RoomIdentity.liveUrl({ platform: 'kuaishou', roomId: '100' }), null);
  assert.equal(RoomIdentity.liveUrl({ roomId: '100' }), null);
  assert.equal(RoomIdentity.liveUrl(undefined), null);
});

// === 复合键 ===

test('roomKey 的字符串格式被钉住：platform_roomId', () => {
  assert.equal(RoomIdentity.roomKey({ platform: 'douyu', roomId: '100' }), 'douyu_100');
  assert.equal(RoomIdentity.roomKey({ platform: 'bilibili', roomId: '200' }), 'bilibili_200');
  assert.equal(RoomIdentity.roomKey({ platform: 'douyu', roomId: 100 }), 'douyu_100');
});

test('roomRefFromKey：拼键与拆键互逆，按第一个下划线切分', () => {
  assert.deepEqual(RoomIdentity.roomRefFromKey('douyu_100'), { platform: 'douyu', roomId: '100' });
  assert.deepEqual(RoomIdentity.roomRefFromKey('bilibili_200'), { platform: 'bilibili', roomId: '200' });
  for (const ref of [{ platform: 'douyu', roomId: '100' }, { platform: 'bilibili', roomId: '200' }]) {
    assert.deepEqual(RoomIdentity.roomRefFromKey(RoomIdentity.roomKey(ref)), ref);
  }
  assert.deepEqual(RoomIdentity.roomRefFromKey('douyu_100_watch'), { platform: 'douyu', roomId: '100_watch' });
});

test('roomRefFromKey：未知平台、缺房间号、没有下划线的输入返回 null', () => {
  assert.equal(RoomIdentity.roomRefFromKey('kuaishou_100'), null);
  assert.equal(RoomIdentity.roomRefFromKey('douyu'), null);
  assert.equal(RoomIdentity.roomRefFromKey('douyu_'), null);
  assert.equal(RoomIdentity.roomRefFromKey('_100'), null);
  assert.equal(RoomIdentity.roomRefFromKey(''), null);
  assert.equal(RoomIdentity.roomRefFromKey(undefined), null);
});

// === 房间号校验 ===

test('isRoomId：纯数字为真；字母、小数、空值、加号与全角数字一律为假', () => {
  assert.equal(RoomIdentity.isRoomId('100'), true);
  assert.equal(RoomIdentity.isRoomId('0'), true);
  assert.equal(RoomIdentity.isRoomId(100), true, '数字形态同样算纯数字');
  assert.equal(RoomIdentity.isRoomId(' 100 '), true, '前后空白不影响判定');
  assert.equal(RoomIdentity.isRoomId('12a'), false);
  assert.equal(RoomIdentity.isRoomId('12.5'), false);
  assert.equal(RoomIdentity.isRoomId('-1'), false);
  assert.equal(RoomIdentity.isRoomId('+1'), false);
  assert.equal(RoomIdentity.isRoomId('１２３'), false, '全角数字不是纯数字');
  assert.equal(RoomIdentity.isRoomId(''), false);
  assert.equal(RoomIdentity.isRoomId(undefined), false);
  assert.equal(RoomIdentity.isRoomId(null), false);
});

test('sameRoomId：同一房间号的字符串与数字形态相等', () => {
  assert.equal(RoomIdentity.sameRoomId('100', '100'), true);
  assert.equal(RoomIdentity.sameRoomId(100, '100'), true);
  assert.equal(RoomIdentity.sameRoomId('100', '101'), false);
  assert.equal(RoomIdentity.sameRoomId('100', undefined), false);
});

// === 接口边界 ===

test('只导出查询：内部平台表不出现在接口上（表的形状还能改）', () => {
  assert.deepEqual(Object.keys(RoomIdentity).sort(), [
    'DEFAULT_PLATFORM',
    'PLATFORM_IDS',
    'isPlatform',
    'isRoomId',
    'liveUrl',
    'platformLabel',
    'roomKey',
    'roomRefFromKey',
    'sameRoomId',
    'viewerField',
    'viewerMetric',
    'viewerToggle'
  ]);
  assert.equal(roomIdentity.PLATFORMS, undefined);
  assert.equal(roomIdentity.RoomIdentity, RoomIdentity, 'node 下 require 拿到的是同一个对象');
});
