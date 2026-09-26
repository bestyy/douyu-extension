// test/room-categories.test.cjs — 分类规则模块（lib/room-categories.js）的纯计算单元测试
//
// 运行：npm test（node --test）
// 覆盖：未分类固定最前、其余按分类列表顺序、隐藏空分组与保留空分组两种模式、在播数与总数、
// 未分类组名与房间分组回落（未知 / 空 categoryId）、名称校验的四种拒绝（空、超长、重名、保留名）
// 与 trim 后的结论。全部是纯函数调用（不驱动编排、不碰存储），口径见 ADR-0008 与 CONTEXT.md「分类」。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RoomCategories } = require('../lib/room-categories.js');
const { UNCATEGORIZED_ID, UNCATEGORIZED_NAME, NAME_MAX_LENGTH, normalizeName, validateName, groupOf, buildRoomGroups } = RoomCategories;

const category = (id, name) => ({ id, name });
const room = (roomId, extra = {}) => ({ roomId, nickname: `昵称${roomId}`, ...extra });

// === 常量与保留名 ===

test('未分类是虚拟桶：id 为空串、展示名为「未分类」', () => {
  assert.equal(UNCATEGORIZED_ID, '');
  assert.equal(UNCATEGORIZED_NAME, '未分类');
});

// === 名称校验 ===

test('validateName：trim 后返回规范名，名字前后空格被去掉', () => {
  assert.deepEqual(validateName('  游戏  ', []), { ok: true, name: '游戏' });
  assert.equal(normalizeName('  游戏  '), '游戏');
  assert.equal(normalizeName(undefined), '');
});

test('validateName：四种拒绝——空、超长、重名、保留名', () => {
  const categories = [category('c1', '游戏')];
  assert.deepEqual(validateName('   ', categories), { ok: false, error: '分类名不能为空' });
  assert.deepEqual(validateName('x'.repeat(NAME_MAX_LENGTH + 1), categories), { ok: false, error: `分类名最多 ${NAME_MAX_LENGTH} 个字` });
  assert.deepEqual(validateName('游戏', categories), { ok: false, error: '已有同名分类' });
  assert.deepEqual(validateName(' 游戏 ', categories), { ok: false, error: '已有同名分类' }, 'trim 后再判重名');
  assert.deepEqual(validateName('未分类', categories), { ok: false, error: '「未分类」是保留名，不能作为分类名' });
});

test('validateName：改名时排除自身（否则会和自己重名）；恰好到上限的名字通过', () => {
  const categories = [category('c1', '游戏'), category('c2', '音乐')];
  assert.deepEqual(validateName('游戏', categories, { excludeId: 'c1' }), { ok: true, name: '游戏' });
  assert.deepEqual(validateName('x'.repeat(NAME_MAX_LENGTH), categories), { ok: true, name: 'x'.repeat(NAME_MAX_LENGTH) });
});

// === 分组回落 ===

test('groupOf：能查到返回该分类 id；空值 / 未知 id 一律回落未分类', () => {
  const categories = [category('c1', '游戏')];
  assert.equal(groupOf('c1', categories), 'c1');
  assert.equal(groupOf('', categories), UNCATEGORIZED_ID);
  assert.equal(groupOf(undefined, categories), UNCATEGORIZED_ID);
  assert.equal(groupOf('c早就删了', categories), UNCATEGORIZED_ID, '分类刚被删 / id 非法都绝不丢弃房间');
  assert.equal(groupOf(2, [category(2, '数字 id')]), '2', 'id 比较按字符串口径');
});

// === 分组投影 ===

test('buildRoomGroups：未分类固定最前，其余按分类列表顺序（设置页模式：保留空分组）', () => {
  const categories = [category('c1', '游戏'), category('c2', '音乐'), category('c3', '空分类')];
  const rooms = [room('1', { categoryId: 'c2' }), room('2'), room('3', { categoryId: 'c1' })];
  const groups = buildRoomGroups({ rooms, categories, hideEmptyGroups: false });
  assert.deepEqual(groups.map(g => g.name), ['未分类', '游戏', '音乐', '空分类']);
  assert.deepEqual(groups.map(g => g.id), ['', 'c1', 'c2', 'c3']);
  assert.deepEqual(groups[0].rooms.map(r => r.roomId), ['2'], '未分类组里是没归类的房间');
  assert.deepEqual(groups[1].rooms.map(r => r.roomId), ['3']);
  assert.deepEqual(groups[3].rooms, [], '空分类也保留（可以先建好分类再往里放房间）');
});

test('buildRoomGroups：隐藏空分组模式只留下有房间的分组（弹窗模式，且无房间的分类整段不出现）', () => {
  const categories = [category('c1', '游戏'), category('c2', '音乐')];
  const rooms = [room('1', { categoryId: 'c2' }), room('2', { categoryId: 'c2' })];
  const groups = buildRoomGroups({ rooms, categories, hideEmptyGroups: true });
  assert.deepEqual(groups.map(g => g.name), ['音乐'], '未分类与空分类都被隐藏');
  assert.deepEqual(groups.map(g => g.id), ['c2']);
});

test('buildRoomGroups：在播数与总数（在线门只看 online === true），组内保持入参顺序', () => {
  const categories = [category('c1', '游戏')];
  const rooms = [
    room('1', { categoryId: 'c1', online: true }),
    room('2', { categoryId: 'c1', online: false }),
    room('3', { categoryId: 'c1' }),                       // 无 online 字段（从未取到快照）
    room('4', { online: true })                            // 未分类且在线
  ];
  const groups = buildRoomGroups({ rooms, categories });
  assert.deepEqual({ online: groups[0].onlineCount, total: groups[0].totalCount }, { online: 1, total: 1 });
  assert.deepEqual({ online: groups[1].onlineCount, total: groups[1].totalCount }, { online: 1, total: 3 });
  assert.deepEqual(groups[1].rooms.map(r => r.roomId), ['1', '2', '3'], '组内顺序就是入参顺序（分类内房间顺序）');
});

test('buildRoomGroups：未知 categoryId 的房间落进未分类组，不被丢弃', () => {
  const categories = [category('c1', '游戏')];
  const rooms = [room('1', { categoryId: 'c已删' }), room('2', { categoryId: 'c1' })];
  const groups = buildRoomGroups({ rooms, categories });
  assert.deepEqual(groups[0].rooms.map(r => r.roomId), ['1'], '查不到分类 id 的房间回落未分类');
  assert.equal(groups[0].totalCount, 1);
});

test('buildRoomGroups：入参畸形容错（缺参、null 条目、分类列表里的空 id 条目）', () => {
  assert.deepEqual(buildRoomGroups().map(g => g.name), ['未分类']);
  const groups = buildRoomGroups({
    rooms: [null, undefined, room('1')],
    categories: [null, category('', '空 id 不算分类'), category('c1', '游戏')]
  });
  assert.deepEqual(groups.map(g => g.name), ['未分类', '游戏'], '空 id 的分类条目被忽略');
  assert.deepEqual(groups[0].rooms.map(r => r.roomId), ['1']);
});
