// test/highlight-alert-flow.test.cjs — 看点通知链路（编排 + 房间库 + 真实规则 module）行为测试
//
// 运行：npm test（node --test）
// 覆盖：首次观测只记水位不发通知、此后只报编号更大的、一次多条只报最新一条（正文补「另有 N 条」）、
// 通知 ID 的 _highlight 后缀与点击还原直播间、未开播不请求不写水位、失败与空列表不写水位、
// 三层门控（平台门 / 总开关 / 该房开关）、取数 alarm 随开关收敛、多房水位各自独立、
// 移除与重新添加房间清水位、与开播通知总开关正交。
// 取数走编排的 alarm 入口（pollHighlights），与生产同一条路；看点列表由 harness 的假平台 API 脚本化。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, poll, pollHighlights, douyuResult } = require('./support/harness.cjs');

const room = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
const streamer = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, online: true, ...extra });
const online = (roomId, platform = 'douyu', extra = {}) => ({ roomId, platform, online: true, ...extra });

/** 一条收敛后的看点（API 层给编排的形状） */
const item = (highlightId, title = `看点${highlightId}`) => ({ highlightId, title, startTime: 0, endTime: 0, heat: 0 });
/** 平台 API 的成功返回 */
const highlights = (...items) => ({ success: true, data: { highlights: items } });

test('首次观测只记水位不发通知；此后只报编号更大的，一次多条只报最新一条', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { highlightAlert: true })],
    streamers: [streamer('100', 'douyu', { title: '在播中' })]
  }, { highlightResults: { douyu: highlights(item(60410, '开场的那条')) } });

  await pollHighlights(harness);
  assert.deepEqual(harness.highlightCalls, [{ platform: 'douyu', roomId: '100' }], '开了开关且在播就取数');
  assert.equal(harness.notifications.length, 0, '首次观测：整场都是「新的」，但只记不发');
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60410 });

  harness.setHighlightResult('douyu', highlights(item(60411, '梦回TI2蓝猫游龙超神')));
  await pollHighlights(harness);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'douyu_100_highlight');
  assert.equal(harness.notifications[0].content.title, '[斗鱼] 昵称100 有新看点！');
  assert.equal(harness.notifications[0].content.message, '梦回TI2蓝猫游龙超神', '正文就是看点标题');
  assert.equal(harness.notifications[0].content.contextMessage, '在播中', '房间标题放上下文行');
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60411 });

  // 同一次轮询发现多条（顺序故意打乱）：只报最新那一条，其余在水位里一并消化
  harness.setHighlightResult('douyu', highlights(
    item(60414, '最新的一条'),
    item(60412, '较早的一条'),
    item(60413, '中间的一条')
  ));
  await pollHighlights(harness);
  assert.equal(harness.notifications.length, 2, '一次发现多条只发一条通知');
  assert.equal(harness.notifications[1].content.message, '最新的一条\n另有 2 条', 'N = count - 1');
  assert.equal(harness.notifications[1].id, 'douyu_100_highlight', '同房复用同一通知 ID（覆盖不堆积）');
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60414 });

  await harness.orchestrator.onNotificationClicked('douyu_100_highlight');
  assert.deepEqual(harness.openedTabs.map(t => t.url), ['https://www.douyu.com/100'], '点击进直播间');
});

test('未开播的房间不取数、不写水位；重新开播后第一轮仍只记水位', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { highlightAlert: true })],
    streamers: [streamer('100', 'douyu', { online: false })]
  }, { highlightResults: { douyu: highlights(item(60411, '新看点')) } });

  await pollHighlights(harness);
  assert.deepEqual(harness.highlightCalls, [], '实测未开播房间的看点列表为空：离线不请求');
  assert.equal(harness.data.highlightWatermarks, undefined);
  assert.equal(harness.notifications.length, 0);

  harness.setApiResult('douyu', douyuResult([online('100')]));
  await poll(harness);
  await pollHighlights(harness);
  assert.equal(harness.highlightCalls.length, 1, '开播后照常取数');
  assert.equal(harness.notifications.length, 0, '重新开播后的第一轮只记水位');
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60411 });
});

test('接口失败或返回空列表不写水位：下次成功时仍会通知最新那一条', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { highlightAlert: true })],
    streamers: [streamer('100', 'douyu')]
  }, { highlightResults: { douyu: highlights(item(60410, '开场的那条')) } });

  await pollHighlights(harness);
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60410 });

  harness.setHighlightResult('douyu', { success: false, error: 'room_unavailable' });
  await pollHighlights(harness);
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60410 }, '接口失败不写水位');
  assert.equal(harness.notifications.length, 0, '失败只记日志，不打扰用户');

  harness.setHighlightResult('douyu', highlights());
  await pollHighlights(harness);
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60410 }, '空列表同样不动水位');

  harness.setHighlightResult('douyu', highlights(item(60411, '抖动期间的那条'), item(60412, '抖动期间的另一条')));
  await pollHighlights(harness);
  assert.equal(harness.notifications.length, 1, '一次抖动不会吃掉看点');
  assert.equal(harness.notifications[0].content.message, '抖动期间的另一条\n另有 1 条');
});

test('平台门：B站房间即使打开该房开关也不请求（看点只有斗鱼有这个形态）', async () => {
  const harness = createHarness({
    rooms: [room('200', 'bilibili', { highlightAlert: true })],
    streamers: [streamer('200', 'bilibili')]
  }, { highlightResults: { bilibili: highlights(item(60411, '新看点')) } });

  await pollHighlights(harness);
  assert.deepEqual(harness.highlightCalls, [], '平台门不通过就不请求');
  assert.equal(harness.data.highlightWatermarks, undefined);
  assert.equal(harness.notifications.length, 0);
});

test('该房开关：未打开看点的房间不请求也不写水位', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu'), room('101', 'douyu', { highlightAlert: false })],
    streamers: [streamer('100', 'douyu'), streamer('101', 'douyu')]
  }, { highlightResults: { douyu: highlights(item(60411, '新看点')) } });

  await pollHighlights(harness);
  assert.deepEqual(harness.highlightCalls, []);
  assert.equal(harness.data.highlightWatermarks, undefined);
  assert.equal(harness.notifications.length, 0);
});

test('总开关关闭：不请求不判定、各房开关保留；重新打开后第一轮只记水位', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { highlightAlert: true })],
    streamers: [streamer('100', 'douyu')],
    settings: { highlightAlertEnabled: false }
  }, { highlightResults: { douyu: highlights(item(60411, '新看点')) } });

  await pollHighlights(harness);
  assert.deepEqual(harness.highlightCalls, [], '总开关关闭：不请求');
  assert.equal(harness.data.highlightWatermarks, undefined);

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { highlightAlertEnabled: true } });
  assert.equal(harness.data.rooms[0].highlightAlert, true, '该房开关保留');
  await pollHighlights(harness);
  assert.equal(harness.notifications.length, 0, '重新打开后第一轮仍是首次观测');
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60411 });

  harness.setHighlightResult('douyu', highlights(item(60412, '重新打开后的新看点')));
  await pollHighlights(harness);
  assert.equal(harness.notifications.length, 1, '此后按水位恢复判定');
});

test('取数 alarm 随房间与开关收敛：有房间开启时创建一次、全关掉即清除、再打开再创建', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { highlightAlert: true })],
    streamers: [streamer('100', 'douyu')]
  });
  const highlightAlarms = () => harness.alarms.filter(a => a.name === 'highlightPoll');

  await poll(harness);
  assert.equal(highlightAlarms().length, 1, '有房间开启时创建');
  assert.equal(highlightAlarms()[0].info.periodInMinutes, 5, '周期写死 5 分钟（不受轮询间隔设置影响）');

  await poll(harness);
  assert.equal(highlightAlarms().length, 1, '已在跑不重建（避免每轮把取数一直往后推）');

  await harness.orchestrator.onMessage({
    type: 'PATCH_ROOM_CONFIG', roomId: '100', platform: 'douyu', patch: { highlightAlert: false }
  });
  assert.deepEqual(harness.clearedAlarms, ['highlightPoll'], '全关掉即清除');

  await harness.orchestrator.onMessage({
    type: 'PATCH_ROOM_CONFIG', roomId: '100', platform: 'douyu', patch: { highlightAlert: true }
  });
  assert.equal(highlightAlarms().length, 2, '重新打开即恢复');

  await harness.orchestrator.onMessage({ type: 'PATCH_SETTINGS', patch: { highlightAlertEnabled: false } });
  assert.deepEqual(
    harness.clearedAlarms,
    ['highlightPoll', 'highlightPoll'],
    '总开关关闭时同样不留无用唤醒'
  );
});

test('多个房间的水位各自独立：一个房的水位不影响另一个房', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { highlightAlert: true }), room('101', 'douyu', { highlightAlert: true })],
    streamers: [streamer('100', 'douyu'), streamer('101', 'douyu')],
    highlightWatermarks: { douyu_100: 60410, douyu_101: 60410 }
  }, {
    highlightResults: {
      douyu: roomId => (roomId === '100'
        ? highlights(item(60411, '一百的新看点'))
        : highlights(item(60411, '一百零一的新看点')))
    }
  });

  await pollHighlights(harness);
  assert.deepEqual(harness.highlightCalls.map(c => c.roomId), ['100', '101']);
  assert.equal(harness.notifications.length, 2, '两个房各报各的');
  assert.deepEqual(harness.notifications.map(n => n.content.message), ['一百的新看点', '一百零一的新看点']);
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60411, douyu_101: 60411 });
});

test('移除房间清掉水位，重新添加的房间第一轮不补报该场已有的看点', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { highlightAlert: true })],
    streamers: [streamer('100', 'douyu')]
  }, {
    highlightResults: { douyu: highlights(item(60410, '开场的那条')) },
    resolve: { douyu: { success: true, nickname: '昵称100' } }
  });

  await pollHighlights(harness);
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60410 });

  await harness.orchestrator.onMessage({ type: 'REMOVE_ROOM', roomId: '100', platform: 'douyu' });
  assert.deepEqual(harness.data.highlightWatermarks, {}, '移除房间顺手清掉水位');

  await harness.orchestrator.onMessage({ type: 'ADD_ROOM', roomId: '100', platform: 'douyu' });
  await harness.orchestrator.onMessage({
    type: 'PATCH_ROOM_CONFIG', roomId: '100', platform: 'douyu', patch: { highlightAlert: true }
  });
  harness.setApiResult('douyu', douyuResult([online('100')]));
  await poll(harness); // 重新添加后重建主播快照（移除时已连带删掉）
  harness.setHighlightResult('douyu', highlights(item(60405, '该场更早的一条'), item(60411, '该场已有的另一条')));
  await pollHighlights(harness);

  assert.equal(harness.notifications.length, 0, '重新添加后的第一轮只记水位');
  assert.deepEqual(harness.data.highlightWatermarks, { douyu_100: 60411 });
});

test('看点通知只受自己的总开关约束：开播通知总开关关闭不影响', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { highlightAlert: true })],
    streamers: [streamer('100', 'douyu')],
    settings: { notificationsEnabled: false },
    highlightWatermarks: { douyu_100: 60410 }
  }, { highlightResults: { douyu: highlights(item(60411, '新看点')) } });

  await pollHighlights(harness);

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'douyu_100_highlight');
  assert.equal(harness.notifications[0].content.message, '新看点');
});

test('看点标题为空时正文不留空：退回「新看点」', async () => {
  const harness = createHarness({
    rooms: [room('100', 'douyu', { highlightAlert: true })],
    streamers: [streamer('100', 'douyu')],
    highlightWatermarks: { douyu_100: 60410 }
  }, { highlightResults: { douyu: highlights(item(60411, '')) } });

  await pollHighlights(harness);
  assert.equal(harness.notifications[0].content.message, '新看点');
});

test('偏离合同的通知 ID（带后缀）不会误伤既有四种通知的解析', async () => {
  const harness = createHarness({ rooms: [room('100', 'douyu'), room('200', 'bilibili')] });

  await harness.orchestrator.onNotificationClicked('douyu_100_highlight');
  await harness.orchestrator.onNotificationClicked('douyu_100_surge');
  await harness.orchestrator.onNotificationClicked('douyu_100');

  assert.deepEqual(harness.openedTabs.map(t => t.url), [
    'https://www.douyu.com/100',
    'https://www.douyu.com/100',
    'https://www.douyu.com/100'
  ]);
});
