// lib/room-categories.js — 分类与未分类的纯规则：名称校验 / 保留名 / 有序分组投影 / 分类栏投影
//
// 术语（见 CONTEXT.md）：
// - 分类 (category)：用户自建的房间组织维度——跨平台、互斥、纯组织（不影响任何通知行为）
// - 未分类 (uncategorized)：房间没归入任何分类时的展示形态。它不是分类：不落盘、不在分类列表里、
//   不能改名 / 删除 / 拖拽，在弹窗与设置页都固定排在最前。rooms[].categoryId 为空即未分类
// - 分类栏 (category rail)：弹窗在线列表左侧那一栏分类选择器。条目是「全部」+「未分类」+ 有在播的分类，
//   它是视图筛选器（切换只改看哪一段，不写任何键）；「全部」是投影出来的视图聚合，不是分类
// - 分类顺序 (category order)：分类之间的先后，就是分类列表本身的顺序
// - 分类内房间顺序 (room order within a category)：每个分类内部各自保留一份相对顺序
//
// 本模块是「分组怎么排、分类栏有哪些条目、分类名合不合法」的唯一实现，消费方（弹窗与设置页）与房间库
// 都吃它的结论：
// - 房间库消费 validateName 的结论（它只判不落盘，落盘与 id 生成归房间库）
// - 两个页面消费 buildRoomGroups 的有序分组；「隐藏空分组与否」是同一个规则上的一个参数，
//   不是两处各写一遍（弹窗传 true，设置页传 false）
// - 弹窗消费 buildCategoryRail 的条目构成与 resolveRailSelection 的回落判定
//
// 分组是读侧投影：输入为房间列表（每条带 online 与 categoryId）、分类列表、是否隐藏空分组，
// 输出未分类固定最前、其余按分类列表顺序，每组带在播数与总数。房间落在哪个分组只看 categoryId
// 能不能在分类列表里查到——查不到（分类刚被删、id 非法）一律回落未分类，绝不丢弃房间。
//
// 分类栏投影复用分组投影：先按在线门（online === true）滤出在播房间，再走同一个 buildRoomGroups，
// 因此「什么算有在播」只有一份判定，只在结果前面插入「全部」一项。选中项的回落判定也在这里——
// 「这个 id 现在还成不成立」只此一处（编排只落盘、不校验，见 ADR-0009）。
//
// 落点规则（追加到目标分组末尾）不在本模块：它是房间库写入侧的排序契约（见 ADR-0008 第四条），
// 本模块只给出「当前所属分组」，不改动任何顺序。
//
// 零依赖：不引用 chrome / storage / 任何其他 lib。UMD 双兼容：SW 的 importScripts 与两个页面的
// <script> 下是全局 `RoomCategories`，node 下可 require 取到同一个对象。加载位置排在使用它的模块之前。

const RoomCategories = (() => {
  // 未分类是虚拟桶：id 用空串表示（rooms[].categoryId 为空即未分类），不落盘、不在分类列表里
  const UNCATEGORIZED_ID = '';
  // 「未分类」同时是保留名：不允许被建成真分类，否则分组标题会重复出现、语义分叉
  const UNCATEGORIZED_NAME = '未分类';
  // 「全部」是分类栏置顶的视图聚合：有保留 id 与展示名，但不是分类——不落盘、不在分类列表里、
  // 不可改名 / 删除 / 排序。保留 id 用分类 id（c<n>）之外的取值，因此不会撞上房间库生成的分类 id；
  // 它同时是「弹窗上次选中的分类」的默认值（见 ADR-0009）
  const ALL_ID = 'all';
  const ALL_NAME = '全部';
  // 保留名（trim 后判）：同一栏里出现两个同名条目会让语义分叉，因此都不允许被建成真分类
  const RESERVED_NAMES = Object.freeze([UNCATEGORIZED_NAME, ALL_NAME]);
  // 分类名长度上限（trim 后的字符数）。够长到写得下一个主题，也短到标题不换行
  const NAME_MAX_LENGTH = 20;

  /** trim 分类名；非字符串输入按空串处理（名字前后的空格被自动去掉，见 spec 故事 8） */
  function normalizeName(raw) {
    return String(raw ?? '').trim();
  }

  /**
   * 校验分类名（房间库建 / 改名前的唯一判据）。四种拒绝：空、超长、重名、保留名（「未分类」「全部」）。
   * @param {*} raw 用户输入的名字（内部的空白会被 trim）
   * @param {Array<{id: string, name: string}>} [categories] 现有分类列表
   * @param {{excludeId?: string}} [options] 改名时排除自身（否则会和自己重名）
   * @returns {{ok: true, name: string} | {ok: false, error: string}} error 是给用户看的中文原因
   */
  function validateName(raw, categories, { excludeId } = {}) {
    const name = normalizeName(raw);
    if (!name) {
      return { ok: false, error: '分类名不能为空' };
    }
    if (name.length > NAME_MAX_LENGTH) {
      return { ok: false, error: `分类名最多 ${NAME_MAX_LENGTH} 个字` };
    }
    const reserved = RESERVED_NAMES.find(reservedName => reservedName === name);
    if (reserved) {
      return { ok: false, error: `「${reserved}」是保留名，不能作为分类名` };
    }
    const skip = excludeId === undefined ? null : String(excludeId);
    const list = Array.isArray(categories) ? categories : [];
    if (list.some(c => c && String(c.id) !== skip && normalizeName(c.name) === name)) {
      return { ok: false, error: '已有同名分类' };
    }
    return { ok: true, name };
  }

  /**
   * 某个 categoryId 实际落在哪个分组：能查到返回该分类 id，空值或查不到一律回落未分类（空串）。
   * 这就是「任何按 id 查分类却查不到的地方，结论是回落未分类」的唯一实现。
   * @param {*} categoryId rooms[].categoryId（或消息里的目标分类 id）
   * @param {Array<{id: string}>} [categories] 现有分类列表
   * @returns {string} 分组 id（'' 表示未分类）
   */
  function groupOf(categoryId, categories) {
    const id = categoryId === undefined || categoryId === null ? '' : String(categoryId);
    if (!id) {
      return UNCATEGORIZED_ID;
    }
    const list = Array.isArray(categories) ? categories : [];
    return list.some(c => c && String(c.id) === id) ? id : UNCATEGORIZED_ID;
  }

  /**
   * 分组投影：把房间列表切成有序分组。
   * 分组顺序 = 未分类固定最前 + 其余按分类列表顺序；每组带在播数（online === true 的条数）与总数。
   * 组内房间保持入参顺序——房间库保证「换分类 / 删分类回落 / 新建房间都追加到目标分组末尾」，
   * 因此这里的顺序就是分类内房间顺序。
   * @param {{rooms?: Array, categories?: Array<{id: string, name: string}>, hideEmptyGroups?: boolean}} params
   *   rooms 的条目只需有 online 与 categoryId 两个字段（弹窗传主播快照、设置页传房间快照均可）
   * @returns {Array<{id: string, name: string, onlineCount: number, totalCount: number, rooms: Array}>}
   */
  function buildRoomGroups({ rooms, categories, hideEmptyGroups = false } = {}) {
    const list = Array.isArray(rooms) ? rooms : [];
    // 分类列表里的空 id 条目不算分类（保留空值专门表示未分类）
    const cats = (Array.isArray(categories) ? categories : []).filter(c => c && String(c.id ?? '') !== '');

    const buckets = new Map();
    buckets.set(UNCATEGORIZED_ID, []);
    for (const c of cats) {
      buckets.set(String(c.id), []);
    }
    for (const room of list) {
      if (!room) continue;
      buckets.get(groupOf(room.categoryId, cats)).push(room);
    }

    const groups = [];
    const push = (id, name) => {
      const members = buckets.get(id) || [];
      if (hideEmptyGroups && members.length === 0) return;
      groups.push({
        id,
        name,
        onlineCount: members.filter(room => room.online === true).length,
        totalCount: members.length,
        rooms: members
      });
    };

    push(UNCATEGORIZED_ID, UNCATEGORIZED_NAME);
    for (const c of cats) {
      // 分类名不会为空（校验拦在写入前），空名只可能来自手改存储：给个中性占位，
      // 既不与保留名「未分类」重名，也不会渲染出一个空白标题
      push(String(c.id), normalizeName(c.name) || '（未命名）');
    }
    return groups;
  }

  /**
   * 分类栏投影：弹窗左栏的条目构成、各自在播数与该段的房间。
   * 顺序 = 「全部」置顶 +「未分类」（真有在播的未分类房间时才出现）+ 有在播房间的真分类
   * （顺序即分类列表顺序）。复用分组投影：先按在线门滤出在播房间，再走同一个
   * buildRoomGroups(hideEmptyGroups=true)，因此「什么算有在播」只有一份判定。
   * @param {{rooms?: Array, categories?: Array<{id: string, name: string}>}} params
   *   rooms 的条目只需有 online 与 categoryId 两个字段
   * @returns {Array<{id: string, name: string, onlineCount: number, rooms?: Array}>}
   *   「全部」（id 是 ALL_ID）是聚合不是分段，只有 id/name/onlineCount；其余每项就是投影出的一段，带 rooms
   */
  function buildCategoryRail({ rooms, categories } = {}) {
    const online = (Array.isArray(rooms) ? rooms : []).filter(room => room && room.online === true);
    const groups = buildRoomGroups({ rooms: online, categories, hideEmptyGroups: true });
    return [{ id: ALL_ID, name: ALL_NAME, onlineCount: online.length }].concat(
      groups.map(group => ({ id: group.id, name: group.name, onlineCount: group.onlineCount, rooms: group.rooms }))
    );
  }

  /**
   * 选中项的回落判定：记忆里的选中项在当前左栏里不存在时（其下房间全下播、未分类桶空了、
   * 分类被删导致 id 失效、或 id 本来就不认识），本次显示回落到「全部」；记忆保持原值不改写。
   * 这是「这个 id 现在还成不成立」的唯一判定处——编排只负责落盘，不做存在性校验（见 ADR-0009）。
   * @param {*} selectedId 记忆里的选中项
   * @param {Array<{id: string}>} [items] buildCategoryRail 的结论
   * @returns {string} 实际生效的条目 id（一定在 items 里，「全部」是兜底）
   */
  function resolveRailSelection(selectedId, items) {
    const list = Array.isArray(items) ? items : [];
    const id = selectedId === undefined || selectedId === null ? ALL_ID : String(selectedId);
    return list.some(item => item && String(item.id) === id) ? id : ALL_ID;
  }

  return Object.freeze({
    UNCATEGORIZED_ID,
    UNCATEGORIZED_NAME,
    ALL_ID,
    ALL_NAME,
    NAME_MAX_LENGTH,
    normalizeName,
    validateName,
    groupOf,
    buildRoomGroups,
    buildCategoryRail,
    resolveRailSelection
  });
})();

// UMD 双兼容：SW 的 importScripts 与页面 <script> 下 module 未定义自动跳过；node 下可 require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RoomCategories };
}
