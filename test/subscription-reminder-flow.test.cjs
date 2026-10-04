// test/subscription-reminder-flow.test.cjs — 订阅通知链路（编排 + 房间库 + 真实规则 module）行为测试
//
// 运行：npm test（node --test）
// 覆盖：到点发通知且 ID 形如 ..._sub_...、正文含开播状态、触发后订阅从存储删除、一次触发多条各自处理、
// 宽限期外的被丢弃且不发通知、alarm 被排到最早待触发时刻并在触发后重排 / 清除、SW 重启后再触发行为正确、
// 全局 notificationsEnabled=false 时不发、通知点击进入直播间、房间被移除后仍提醒（显示名回退）、
// 添加 / 删除消息的重排与订阅校验。
// 时间用 harness 的可控时钟驱动（不睡真实时间）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, createClock, boot, remindSubscriptions, poll, douyuResult } = require('./support/harness.cjs');

const room = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, ...extra });
const streamer = (roomId, platform, extra = {}) => ({ roomId, platform, nickname: `昵称${roomId}`, online: true, ...extra });
const sub = (id, at, extra = {}) => ({ id, platform: 'douyu', roomId: '100', at, ...extra });

const reminderAlarms = harness => harness.alarms.filter(a => a.name === 'subscriptionReminder');

test('到点发通知（ID 带 _sub_、正文报开播状态），订阅被删除，alarm 重排到下一条', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu', { title: '在播中' })],
    subscriptions: [sub('s1', 1000), sub('s2', 2000)]
  }, { clock });

  await boot(harness);
  assert.equal(reminderAlarms(harness).length, 1, '启动即排到最早待触发时刻');
  assert.equal(reminderAlarms(harness)[0].info.when, 1000);

  clock.t = 1000;
  await remindSubscriptions(harness);

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].id, 'douyu_100_sub_s1', '通知 ID 前缀是房间复合键、_sub_ 后跟订阅 id');
  assert.equal(harness.notifications[0].content.title, '[斗鱼] 昵称100 订阅到点了！');
  assert.equal(harness.notifications[0].content.message, '正在直播：在播中', '在播时正文附当前标题');
  assert.deepEqual(harness.data.subscriptions.map(s => s.id), ['s2'], '触发后订阅即从存储删除');
  assert.equal(reminderAlarms(harness).at(-1).info.when, 2000, '重排到下一条最早待触发时刻');

  // 点击通知进入直播间：变长的 `_sub_<id>` 后缀要能还原房间复合键
  await harness.orchestrator.onNotificationClicked('douyu_100_sub_s1');
  assert.deepEqual(harness.openedTabs.map(t => t.url), ['https://www.douyu.com/100']);
});

test('到点无条件发：未开播也发，正文写明未开播', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu', { online: false })],
    subscriptions: [sub('s1', 1000)]
  }, { clock });

  await boot(harness);
  clock.t = 1000;
  await remindSubscriptions(harness);

  assert.equal(harness.notifications.length, 1, '像闹钟一样说到做到');
  assert.equal(harness.notifications[0].content.message, '当前未开播');
});

test('一次触发多条各自处理：同一房间多条订阅各弹各的，ID 不互相覆盖', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 1000), sub('s2', 1000), sub('s3', 3000)]
  }, { clock });

  await boot(harness);
  clock.t = 1000;
  await remindSubscriptions(harness);

  assert.deepEqual(harness.notifications.map(n => n.id), ['douyu_100_sub_s1', 'douyu_100_sub_s2']);
  assert.deepEqual(harness.data.subscriptions.map(s => s.id), ['s3']);
  assert.equal(reminderAlarms(harness).at(-1).info.when, 3000);
});

test('宽限期内照发；超过宽限期静默丢弃且不发通知', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 1000), sub('s2', -300000)]
  }, { clock });

  await boot(harness); // 过去时刻的 s2 不参与排期，alarm 排在 s1
  clock.t = 1000;
  await remindSubscriptions(harness);

  assert.equal(harness.notifications.length, 1, '在宽限期内（延迟 0）照发');
  assert.equal(harness.notifications[0].id, 'douyu_100_sub_s1');
  assert.deepEqual(harness.data.subscriptions, [], '超过宽限期的 s2 被安静丢弃');
  assert.deepEqual(harness.clearedAlarms, ['subscriptionReminder'], '没有待触发订阅即清掉 alarm');
});

test('未来订阅不触发；remind 只是重排 alarm', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 5000)]
  }, { clock });

  await boot(harness);
  clock.t = 1000;
  await remindSubscriptions(harness);

  assert.equal(harness.notifications.length, 0);
  assert.deepEqual(harness.data.subscriptions.map(s => s.id), ['s1'], '未到点的订阅原地保留');
  assert.equal(reminderAlarms(harness).at(-1).info.when, 5000);
});

test('全局关闭通知：到点不弹通知，但订阅照样被消费，重开不残留', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    settings: { notificationsEnabled: false },
    subscriptions: [sub('s1', 1000), sub('s2', 5000)]
  }, { clock });

  await boot(harness);
  clock.t = 1000;
  await remindSubscriptions(harness);

  assert.equal(harness.notifications.length, 0, '关掉总开关就不发');
  assert.deepEqual(harness.data.subscriptions.map(s => s.id), ['s2'], '未来的订阅保留，重开即恢复');
  assert.equal(reminderAlarms(harness).at(-1).info.when, 5000);
});

test('SW 被回收重启后再到点：已排定订阅不丢，照常提醒', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 1000)]
  }, { clock });

  await boot(harness);
  harness.restart(); // 内存态归零，存储与 alarm 注册表保留
  await boot(harness);

  assert.equal(reminderAlarms(harness).length, 2, '重启后从存储重排（一次性 alarm 用同一绝对时刻覆盖无漂移）');
  assert.equal(reminderAlarms(harness).at(-1).info.when, 1000);

  clock.t = 1000;
  await remindSubscriptions(harness);
  assert.equal(harness.notifications.length, 1, '重启后照响');
  assert.equal(harness.notifications[0].id, 'douyu_100_sub_s1');
});

test('错过触发的补发：SW 启动时发现已到点且仍在宽限期内，排立即触发的 alarm 并按宽限期补发', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 1000)]
  }, { clock });

  // 模拟到点那一刻扩展没在运行（浏览器关着 / SW 被回收），唤醒时该订阅已过期但仍在宽限期内
  clock.t = 2000;
  await boot(harness);
  assert.equal(reminderAlarms(harness).at(-1).info.when, 2000, '不因漏触发而永久停在未来：排一个立即触发的 alarm');

  await remindSubscriptions(harness);
  assert.equal(harness.notifications.length, 1, '在宽限期内补发');
  assert.equal(harness.notifications[0].id, 'douyu_100_sub_s1');
  assert.deepEqual(harness.data.subscriptions, []);
});

test('错过触发且超过宽限期：安静丢弃，不补发', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 1000)]
  }, { clock });

  clock.t = 1000 + 300001; // 超出 5 分钟宽限期
  await boot(harness);
  await remindSubscriptions(harness);

  assert.equal(harness.notifications.length, 0, '过时提醒不补发');
  assert.deepEqual(harness.data.subscriptions, [], '安静丢弃');
});

test('扩展更新清掉 alarm 后：onInstalled 从存储重排，订阅不会永久停摆', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 4000)]
  }, { clock });

  await harness.orchestrator.onInstalled();
  assert.equal(reminderAlarms(harness).at(-1).info.when, 4000, '安装 / 更新时按存储里的订阅重排 alarm');
});

test('房间被移除后订阅仍然有效：到点照常提醒，标题回退为「平台 房间号」', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 1000)]
  }, { clock });

  await harness.orchestrator.onMessage({ type: 'REMOVE_ROOM', roomId: '100', platform: 'douyu' });
  assert.deepEqual(harness.data.subscriptions.map(s => s.id), ['s1'], '删房间不级联删订阅');

  clock.t = 1000;
  await remindSubscriptions(harness);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].content.title, '[斗鱼] 斗鱼 100 订阅到点了！', '解析不到昵称就回退复合键');
});

test('添加订阅：经消息落到房间库并重排 alarm；过去时刻 / 不在列表的房间被拒', async () => {
  const clock = createClock(0);
  const harness = createHarness({ rooms: [room('100', 'douyu')], streamers: [] }, { clock });

  const added = await harness.orchestrator.onMessage({
    type: 'ADD_SUBSCRIPTION', platform: 'douyu', roomId: '100', at: 6000
  });
  assert.equal(added.ok, true);
  assert.deepEqual(added.subscription, { id: 's1', platform: 'douyu', roomId: '100', at: 6000 });
  assert.equal(reminderAlarms(harness).at(-1).info.when, 6000);

  const past = await harness.orchestrator.onMessage({
    type: 'ADD_SUBSCRIPTION', platform: 'douyu', roomId: '100', at: 0
  });
  assert.equal(past.ok, false);
  assert.match(past.error, /晚于当前时间/);

  const missing = await harness.orchestrator.onMessage({
    type: 'ADD_SUBSCRIPTION', platform: 'douyu', roomId: '999', at: 6000
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /监控/);
  assert.equal(harness.data.subscriptions.length, 1, '被拒的两次不落盘');
});

test('删除订阅：经消息删除并重排 alarm；删到空即清掉 alarm', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [],
    subscriptions: [sub('s1', 6000)]
  }, { clock });

  await boot(harness);
  await harness.orchestrator.onMessage({ type: 'REMOVE_SUBSCRIPTION', id: 's1' });
  assert.deepEqual(harness.data.subscriptions, []);
  assert.ok(harness.clearedAlarms.includes('subscriptionReminder'), '没有待触发订阅即清除 alarm');
});

test('配置导入不触碰订阅，且导入后按保留的订阅重排 alarm', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 7000)]
  }, { clock });

  await harness.orchestrator.onMessage({
    type: 'IMPORT_CONFIG',
    config: {
      rooms: [{ platform: 'bilibili', roomId: '200', nickname: '新', notify: false }],
      categories: [],
      settings: { refreshInterval: 60 }
    }
  });

  assert.deepEqual(harness.data.subscriptions.map(s => s.id), ['s1'], '导入只替换三键，本机订阅原封不动');
  assert.equal(reminderAlarms(harness).at(-1).info.when, 7000, '导入的完整收敛里也会重排订阅 alarm');
});

test('B站房间同样可被订阅：行为一致', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('200', 'bilibili')],
    streamers: [streamer('200', 'bilibili', { title: 'B站在播' })],
    subscriptions: [{ id: 's1', platform: 'bilibili', roomId: '200', at: 1000 }]
  }, { clock });

  await boot(harness);
  clock.t = 1000;
  await remindSubscriptions(harness);

  assert.equal(harness.notifications[0].id, 'bilibili_200_sub_s1');
  assert.equal(harness.notifications[0].content.title, '[B站] 昵称200 订阅到点了！');
  await harness.orchestrator.onNotificationClicked('bilibili_200_sub_s1');
  assert.deepEqual(harness.openedTabs.map(t => t.url), ['https://live.bilibili.com/200']);
});

test('订阅与轮询同跑时互不干扰（轮询不改变订阅列表）', async () => {
  const clock = createClock(0);
  const harness = createHarness({
    rooms: [room('100', 'douyu')],
    streamers: [streamer('100', 'douyu')],
    subscriptions: [sub('s1', 5000)]
  }, { clock, apiResults: { douyu: douyuResult([{ roomId: '100', online: true }, { roomId: '100', online: true }]) } });

  await poll(harness);
  assert.deepEqual(harness.data.subscriptions.map(s => s.id), ['s1']);
});
