// test/config-backup.test.cjs — 配置备份纯模块（lib/config-backup.js）的纯计算单元测试
//
// 运行：npm test（node --test）
// 覆盖：构造导出对象（格式标识与版本号、剥掉 online、settings 只带已知键、exportedAt）、
// 解析并校验导入文本的全部拒绝口径（无法解析 / 格式标识不符 / 版本不认识 / 顶层类型不对 /
// 未知设置键 / 布尔字段类型错 / 数值越界 / 平台未知 / 房间号非法 / 房间重复 / 分类 id 空或重复 /
// 分类名不合法 / categoryId 悬空）、缺键的合法，以及成功时吐出的已归一化配置。
// 全部是纯函数调用（不驱动编排、不碰存储），端口随调用注入（identity / categoryRules），
// 口径见 docs/adr/0012-config-backup-export-import.md 与 spec。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ConfigBackup } = require('../lib/config-backup.js');
const { RoomIdentity } = require('../lib/room-identity.js');
const { RoomCategories } = require('../lib/room-categories.js');

const ports = { identity: RoomIdentity, categoryRules: RoomCategories };
const parse = text => ConfigBackup.parseBackup(text, ports);

/** 一份合法的导出对象（各用例在其上做一处改动） */
const sample = () => ({
  format: 'douyu-extensions-config',
  version: 1,
  exportedAt: '2026-09-27T10:00:00.000Z',
  settings: { refreshInterval: 120, notificationsEnabled: true, surgeMultiple: 4.5 },
  categories: [{ id: 'c1', name: '游戏' }],
  rooms: [
    { platform: 'douyu', roomId: '12345', nickname: '甲', categoryId: 'c1', notify: true },
    { platform: 'bilibili', roomId: '23456', nickname: '乙', notify: false }
  ]
});
const text = obj => JSON.stringify(obj);

// === 构造导出对象 ===

test('buildExport：带格式标识与版本号，exportedAt 取注入的时刻', () => {
  const snapshot = { rooms: [], categories: [], settings: { refreshInterval: 60 } };
  const out = ConfigBackup.buildExport(snapshot, { now: new Date('2026-09-27T10:00:00.000Z') });
  assert.equal(out.format, 'douyu-extensions-config');
  assert.equal(out.version, 1);
  assert.equal(out.exportedAt, '2026-09-27T10:00:00.000Z');
});

test('buildExport：剥掉快照附加的 online 与平台派生的 internalRoomId，房间只留持久化字段', () => {
  const snapshot = {
    rooms: [{ platform: 'douyu', roomId: '91224', nickname: '甲', online: true, internalRoomId: '8727436', notify: true }],
    categories: [],
    settings: {}
  };
  const out = ConfigBackup.buildExport(snapshot);
  assert.equal('online' in out.rooms[0], false);
  assert.equal('internalRoomId' in out.rooms[0], false, '内部号是平台派生数据，不进备份文件');
  assert.equal(out.rooms[0].roomId, '91224');
  assert.equal(out.rooms[0].notify, true);
});

test('buildExport：settings 只带房间库已知的键（未知键、旧总开关与退役项都不入文件）', () => {
  const snapshot = {
    rooms: [],
    categories: [],
    settings: { refreshInterval: 60, fetchDouyuViewerCount: true, fetchViewerCount: true, todayStatsEnabled: true, bogus: 1 }
  };
  const out = ConfigBackup.buildExport(snapshot);
  assert.deepEqual(Object.keys(out.settings).sort(), ['fetchDouyuViewerCount', 'refreshInterval']);
});

test('buildExport：分类原样带着（id 与顺序）', () => {
  const snapshot = { rooms: [], categories: [{ id: 'c1', name: '游戏' }, { id: 'c2', name: '音乐' }], settings: {} };
  const out = ConfigBackup.buildExport(snapshot);
  assert.deepEqual(out.categories, [{ id: 'c1', name: '游戏' }, { id: 'c2', name: '音乐' }]);
});

// === 解析与校验：成功路径 ===

test('parseBackup：合法文件通过，吐出已归一化的 rooms / categories / settings', () => {
  const result = parse(text(sample()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.categories, [{ id: 'c1', name: '游戏' }]);
  assert.equal(result.config.rooms.length, 2);
  assert.deepEqual(result.config.rooms[0], { platform: 'douyu', roomId: '12345', nickname: '甲', categoryId: 'c1', notify: true });
  assert.deepEqual(result.config.settings, { refreshInterval: 120, notificationsEnabled: true, surgeMultiple: 4.5 });
});

test('parseBackup：缺键合法（settings 只有部分键 / 房间省略可选字段）', () => {
  const result = parse(text({
    format: 'douyu-extensions-config',
    version: 1,
    settings: { refreshInterval: 90 },
    rooms: [{ platform: 'douyu', roomId: '12345' }]
    // categories 整个缺失
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.settings, { refreshInterval: 90 });
  assert.deepEqual(result.config.rooms, [{ platform: 'douyu', roomId: '12345' }]);
  assert.deepEqual(result.config.categories, []);
});

test('parseBackup：接受下线之前导出的文件（退役的 todayStatsEnabled 放行，但不落进配置）', () => {
  const result = parse(text({
    format: 'douyu-extensions-config',
    version: 1,
    settings: { refreshInterval: 90, todayStatsEnabled: true },
    rooms: []
  }));
  assert.equal(result.ok, true, '旧备份不能因为多了退役字段就被整份拒绝');
  assert.deepEqual(result.config.settings, { refreshInterval: 90 });
});

test('parseBackup：房间号两端的空白被 trim 后落盘为纯数字', () => {
  const result = parse(text({
    format: 'douyu-extensions-config', version: 1,
    rooms: [{ platform: 'douyu', roomId: ' 12345 ', nickname: '甲' }]
  }));
  assert.equal(result.ok, true);
  assert.equal(result.config.rooms[0].roomId, '12345');
});

test('parseBackup：导入不保留 internalRoomId（缺它也照收），由导入后的轮询重新补齐', () => {
  const withInternal = parse(text({
    format: 'douyu-extensions-config', version: 1,
    rooms: [{ platform: 'douyu', roomId: '91224', nickname: '甲', internalRoomId: '8727436' }]
  }));
  assert.equal(withInternal.ok, true);
  assert.equal('internalRoomId' in withInternal.config.rooms[0], false, '文件里夹带的内部号也不落进配置');

  const without = parse(text({
    format: 'douyu-extensions-config', version: 1,
    rooms: [{ platform: 'douyu', roomId: '91224', nickname: '甲' }]
  }));
  assert.equal(without.ok, true, '缺 internalRoomId 不拒绝导入');
});

// === 解析与校验：整份拒绝 ===

test('parseBackup：拒绝无法解析的文本（选错文件 / 手改坏了）', () => {
  const result = parse('这不是 JSON');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-backup');
});

test('parseBackup：拒绝格式标识不符的文件（是别的 JSON）', () => {
  const result = parse(text({ format: 'something-else', version: 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-backup');
});

test('parseBackup：拒绝不认识的版本号', () => {
  const result = parse(text({ ...sample(), version: 2 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-version');
});

test('parseBackup：拒绝顶层类型不对（rooms 非数组 / settings 非对象）', () => {
  assert.equal(parse(text({ ...sample(), rooms: {} })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), settings: [] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), categories: 'x' })).reason, 'invalid');
});

test('parseBackup：拒绝房间里的未知平台 / 非法房间号', () => {
  assert.equal(parse(text({ ...sample(), rooms: [{ platform: 'youtube', roomId: '1' }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), rooms: [{ platform: 'douyu', roomId: 'abc' }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), rooms: [{ platform: 'douyu', roomId: 12345 }] })).reason, 'invalid', '数字形态也不接受（必须是字符串）');
});

test('parseBackup：拒绝重复的房间（复合键相同）', () => {
  const result = parse(text({
    ...sample(),
    rooms: [
      { platform: 'douyu', roomId: '12345' },
      { platform: 'douyu', roomId: '12345' }
    ]
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('parseBackup：拒绝悬空的 categoryId（指向文件里没有的分类）', () => {
  const result = parse(text({
    ...sample(),
    rooms: [{ platform: 'douyu', roomId: '12345', categoryId: 'c9' }]
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('parseBackup：拒绝分类 id 为空或重复、分类名不合法（空 / 保留名 / 重名）', () => {
  assert.equal(parse(text({ ...sample(), categories: [{ id: '', name: '游戏' }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), categories: [{ id: 'c1', name: '游戏' }, { id: 'c1', name: '音乐' }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), categories: [{ id: 'c1', name: '  ' }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), categories: [{ id: 'c1', name: '未分类' }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), categories: [{ id: 'c1', name: '游戏' }, { id: 'c2', name: ' 游戏 ' }] })).reason, 'invalid');
});

test('parseBackup：拒绝 settings 里的未知键', () => {
  const result = parse(text({ ...sample(), settings: { refreshInterval: 60, notASetting: true } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('parseBackup：拒绝布尔设置项的非布尔值', () => {
  const result = parse(text({ ...sample(), settings: { notificationsEnabled: 'yes' } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('parseBackup：拒绝越界的数值设置项（区间与房间库的钳制同源）', () => {
  assert.equal(parse(text({ ...sample(), settings: { refreshInterval: 30 } })).reason, 'invalid', '低于 60 秒');
  assert.equal(parse(text({ ...sample(), settings: { surgeMultiple: 0.5 } })).reason, 'invalid', '低于 1.1 倍');
  assert.equal(parse(text({ ...sample(), settings: { surgeMultiple: 99 } })).reason, 'invalid', '高于 10 倍');
  assert.equal(parse(text({ ...sample(), settings: { surgeMinBaseline: 0 } })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), settings: { surgeCooldownMinutes: 999 } })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), settings: { surgeMinBuckets: 1 } })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), settings: { surgeMinBuckets: 'x' } })).reason, 'invalid', '非数值');
  // 边界值通过
  assert.equal(parse(text({ ...sample(), settings: { refreshInterval: 60 } })).ok, true);
  assert.equal(parse(text({ ...sample(), settings: { surgeMultiple: 1.1 } })).ok, true);
  assert.equal(parse(text({ ...sample(), settings: { surgeMinBuckets: 30 } })).ok, true);
});

test('parseBackup：拒绝小数位过多的数值（导入是原样写入、不像 patchSettings 会钳制）', () => {
  assert.equal(parse(text({ ...sample(), settings: { surgeMultiple: 4.55 } })).reason, 'invalid', '倍数只支持一位小数');
  assert.equal(parse(text({ ...sample(), settings: { refreshInterval: 60.5 } })).reason, 'invalid', '秒数只能是整数');
  assert.equal(parse(text({ ...sample(), settings: { surgeMinBuckets: 10.1 } })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), settings: { surgeMultiple: 4.5 } })).ok, true, '一位小数通过');
});

test('parseBackup：拒绝房间已认识字段的类型错误（notify / watch / viewerAlert 等）', () => {
  assert.equal(parse(text({ ...sample(), rooms: [{ platform: 'douyu', roomId: '1', notify: 'yes' }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), rooms: [{ platform: 'douyu', roomId: '1', watch: 'x' }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), rooms: [{ platform: 'douyu', roomId: '1', viewerAlert: 1 }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), rooms: [{ platform: 'douyu', roomId: '1', surgeAlert: 1 }] })).reason, 'invalid');
  assert.equal(parse(text({ ...sample(), rooms: [{ platform: 'douyu', roomId: '1', highlightAlert: 1 }] })).reason, 'invalid');
});
