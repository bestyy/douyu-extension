// test/popup-category-rail-flow.test.cjs — 弹窗分类栏的选中项链路（编排 + 真实房间库 / 分类规则）行为测试
//
// 运行：npm test（node --test）
// 覆盖：写入选中项后键上落下对应的分类 id（含「全部」的保留 id）、写陌生 id 原样落下不做校验、
// 这条消息不触发任何 alarm / 通知 / 采样、未声明的消息类型不会被这条链消费，
// 以及「记忆存的是分类 id」这条链路对分类改名 / 删除的后果（改名活下来、删除只临时回落不改记忆）。
// 形态与今日统计 / 看点通知的 flow 测试一致：建 harness、onMessage 发消息、断言内存存储与返回值。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./support/harness.cjs');
const { RoomCategories } = require('../lib/room-categories.js');
const { ALL_ID, UNCATEGORIZED_ID, buildCategoryRail, resolveRailSelection } = RoomCategories;

const setPopupCategory = (harness, categoryId) =>
  harness.orchestrator.onMessage({ type: 'SET_POPUP_CATEGORY', categoryId });

test('写入选中项：键上落下对应的分类 id（含「全部」的保留 id 与未分类的空串）', async () => {
  const harness = createHarness({ categories: [{ id: 'c1', name: '游戏' }] });

  assert.deepEqual(await setPopupCategory(harness, 'c1'), { ok: true });
  assert.equal(harness.data.popupCategoryId, 'c1');

  assert.deepEqual(await setPopupCategory(harness, ALL_ID), { ok: true });
  assert.equal(harness.data.popupCategoryId, ALL_ID, '「全部」用的是保留 id');

  assert.deepEqual(await setPopupCategory(harness, UNCATEGORIZED_ID), { ok: true });
  assert.equal(harness.data.popupCategoryId, '', '未分类就是空串（与「全部」不是一回事）');
});

test('写陌生 id：编排原样落下，不做分类存在性校验（判定留在读取侧的回落规则）', async () => {
  const harness = createHarness({ categories: [{ id: 'c1', name: '游戏' }] });

  assert.deepEqual(await setPopupCategory(harness, 'c早就删了'), { ok: true });
  assert.equal(harness.data.popupCategoryId, 'c早就删了');

  // 读侧照同一条回落规则处理：栏里没有它 → 本次显示回落到「全部」
  const items = buildCategoryRail({ rooms: [], categories: harness.data.categories });
  assert.equal(resolveRailSelection(harness.data.popupCategoryId, items), ALL_ID);
});

test('非字符串的选中项被拒、不写盘（消息形状守卫，不是分类校验）', async () => {
  const harness = createHarness({ categories: [{ id: 'c1', name: '游戏' }] });

  assert.deepEqual(await setPopupCategory(harness, undefined), { ok: false });
  assert.deepEqual(await setPopupCategory(harness, 42), { ok: false });
  assert.equal('popupCategoryId' in harness.data, false, '畸形消息不留下键');
});

test('这条消息不触发任何 alarm / 通知 / 采样（纯 UI 状态，与分类的组织操作一样直通）', async () => {
  const harness = createHarness({
    rooms: [{ roomId: '100', platform: 'douyu', nickname: '昵称100', online: true }],
    streamers: [{ roomId: '100', platform: 'douyu', nickname: '昵称100', online: true }],
    categories: [{ id: 'c1', name: '游戏' }]
  });

  await setPopupCategory(harness, 'c1');

  assert.deepEqual(harness.alarms, [], '不碰轮询 / 采样 / 取数 alarm');
  assert.deepEqual(harness.notifications, [], '不发任何通知');
  assert.deepEqual(harness.badge, [], '不参与在线角标');
  assert.deepEqual(harness.clients.douyuSample.sampleCalls, [], '不触发观众数采样');
  assert.deepEqual(harness.clients.douyuWatch.roomCalls, [], '不收敛盯守连接');
  assert.deepEqual(harness.apiCalls, [], '不请求任何平台接口');
});

test('未声明的消息类型不会被这条链消费：走默认分支、不落任何键', async () => {
  const harness = createHarness({ categories: [{ id: 'c1', name: '游戏' }] });

  assert.deepEqual(await harness.orchestrator.onMessage({ type: 'SET_SOMETHING_ELSE', categoryId: 'c1' }), { ok: false });
  assert.deepEqual(await harness.orchestrator.onMessage({ type: 'POPUP_CATEGORY' }), { ok: false });
  assert.equal('popupCategoryId' in harness.data, false);
});

test('记忆存的是分类 id：分类改名后选中项仍然成立（改名不改 id）', async () => {
  const harness = createHarness({ categories: [{ id: 'c1', name: '游戏' }] });
  await setPopupCategory(harness, 'c1');

  await harness.orchestrator.onMessage({ type: 'RENAME_CATEGORY', id: 'c1', name: '单机游戏' });

  assert.equal(harness.data.popupCategoryId, 'c1', '记忆里的 id 不受改名影响');
  const items = buildCategoryRail({
    rooms: [{ categoryId: 'c1', online: true }],
    categories: harness.data.categories
  });
  assert.deepEqual(items.map(i => i.name), ['全部', '单机游戏']);
  assert.equal(resolveRailSelection(harness.data.popupCategoryId, items), 'c1', '改名后仍选中它');
});

test('选中的分类被删后：记忆保持原值不改写，读取侧只是本次回落到「全部」', async () => {
  const harness = createHarness({
    categories: [{ id: 'c1', name: '游戏' }],
    rooms: [{ roomId: '100', platform: 'douyu', nickname: '昵称100', categoryId: 'c1' }]
  });
  await setPopupCategory(harness, 'c1');

  await harness.orchestrator.onMessage({ type: 'REMOVE_CATEGORY', id: 'c1' });

  assert.equal(harness.data.popupCategoryId, 'c1', '记忆代表用户意图，一次删除不抹掉它');
  const items = buildCategoryRail({
    rooms: [{ categoryId: 'c1', online: true }], // 该房随分类删除回落未分类
    categories: harness.data.categories
  });
  assert.equal(resolveRailSelection(harness.data.popupCategoryId, items), ALL_ID);
});

test('选中的分类全部下播时：记忆不改写，读取侧回落到「全部」', async () => {
  const harness = createHarness({ categories: [{ id: 'c1', name: '游戏' }] });
  await setPopupCategory(harness, 'c1');

  const offline = buildCategoryRail({
    rooms: [{ categoryId: 'c1', online: false }],
    categories: harness.data.categories
  });
  assert.equal(resolveRailSelection(harness.data.popupCategoryId, offline), ALL_ID, '该分类不占位 → 本次回落');
  assert.equal(harness.data.popupCategoryId, 'c1', '下次它再有人开播仍会选中它');
});
