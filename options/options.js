// options/options.js — 设置页逻辑（房间号管理版）
//
// 单写者（见 docs/adr/0003-room-store-single-writer.md）：页面只读房间库的只读快照，
// 变更一律发消息给 SW（PATCH_SETTINGS / PATCH_ROOM_CONFIG / REORDER_ROOMS / ADD_ROOM / REMOVE_ROOM /
// ADD_CATEGORY / RENAME_CATEGORY / REMOVE_CATEGORY / REORDER_CATEGORIES / SET_ROOM_CATEGORY），
// 页面不写 storage。
// 房间标识（复合键、平台标签、观众数指标文案与开关键）来自 lib/room-identity.js 的全局
// `RoomIdentity`，页面不自己拼字符串，也不自查存储形状（见 CONTEXT.md「房间标识」）。
// 分类的分组顺序、未分类固定最前与空分组取舍来自 lib/room-categories.js 的全局 `RoomCategories`，
// 页面只渲染它的结论（归类 / 改名 / 删除 / 分类顺序都经 SW 落到房间库，见 ADR-0008）。

const roomStore = new RoomStore({
  storage: {
    get: keys => chrome.storage.local.get(keys),
    set: entries => chrome.storage.local.set(entries)
  },
  identity: RoomIdentity,
  categoryRules: RoomCategories
});

/** 分类下拉里「新建分类…」的哨兵值（是下拉选项值，不是分类 id） */
const NEW_CATEGORY_OPTION = '__new__';

/** 设置变更：落盘、重建轮询 alarm、重算通道与盯守都在 SW 侧完成 */
async function patchSettings(patch) {
  return await chrome.runtime.sendMessage({ type: 'PATCH_SETTINGS', patch });
}

document.addEventListener('DOMContentLoaded', async () => {
  const [snapshot, legacy] = await Promise.all([
    roomStore.snapshot(),
    chrome.storage.local.get('cookie') // 旧版 Cookie 配置：只用于迁移提示
  ]);
  const settings = snapshot.settings; // 快照已补全缺省值、把平台开关解算成布尔

  const roomIdInput = document.getElementById('roomIdInput');
  const addRoomBtn = document.getElementById('addRoomBtn');
  const addRoomCategory = document.getElementById('addRoomCategory');
  const newCategoryBtn = document.getElementById('newCategoryBtn');
  const roomList = document.getElementById('roomList');
  const emptyRooms = document.getElementById('emptyRooms');
  const refreshStatusBtn = document.getElementById('refreshStatusBtn');
  const addStatus = document.getElementById('addStatus');
  const refreshInterval = document.getElementById('refreshInterval');
  const notificationsEnabled = document.getElementById('notificationsEnabled');
  const danmakuWatchEnabled = document.getElementById('danmakuWatchEnabled');
  const viewerAlertEnabled = document.getElementById('viewerAlertEnabled');
  const surgeAlertEnabled = document.getElementById('surgeAlertEnabled');
  const highlightAlertEnabled = document.getElementById('highlightAlertEnabled');
  const todayStatsEnabled = document.getElementById('todayStatsEnabled');
  const surgeMultiple = document.getElementById('surgeMultiple');
  const surgeMinBaseline = document.getElementById('surgeMinBaseline');
  const surgeCooldownMinutes = document.getElementById('surgeCooldownMinutes');
  const surgeMinBuckets = document.getElementById('surgeMinBuckets');
  const fetchDouyuViewerCount = document.getElementById('fetchDouyuViewerCount');
  const fetchBilibiliViewerCount = document.getElementById('fetchBilibiliViewerCount');
  // 加载现有设置
  refreshInterval.value = settings.refreshInterval;
  notificationsEnabled.checked = settings.notificationsEnabled;
  danmakuWatchEnabled.checked = isDanmakuWatchEnabled(settings);
  viewerAlertEnabled.checked = isViewerAlertEnabled(settings);
  surgeAlertEnabled.checked = isSurgeAlertEnabled(settings);
  highlightAlertEnabled.checked = isHighlightAlertEnabled(settings);
  todayStatsEnabled.checked = isTodayStatsEnabled(settings);
  // 四个激增数值用归一化后的生效值回填（与判定侧同一套钳制与缺省）
  const surgeSettings = normalizeSurgeSettings(settings);
  surgeMultiple.value = surgeSettings.multiple;
  surgeMinBaseline.value = surgeSettings.minBaseline;
  surgeCooldownMinutes.value = surgeSettings.cooldownMinutes;
  surgeMinBuckets.value = surgeSettings.minBuckets;
  fetchDouyuViewerCount.checked = settings.fetchDouyuViewerCount;
  fetchBilibiliViewerCount.checked = settings.fetchBilibiliViewerCount;

  // Migration check - old cookie config detected
  if (legacy.cookie && legacy.cookie.value && snapshot.rooms.length === 0) {
    showStatus(addStatus, '已检测到旧版配置，请添加您要监控的房间号', 'info');
  }

  // 渲染房间列表：按分类分段（未分类固定最前；空分类也渲染，便于先建好分类再往里放房间）
  async function renderRoomList() {
    const [{ rooms = [], streamers = [], categories = [], settings }, extra] = await Promise.all([
      roomStore.snapshot(),
      chrome.storage.local.get('watchQueued') // 盯守排队视图（SW 侧的键，不归房间库）
    ]);
    const onlineMap = {};
    streamers.forEach(s => { onlineMap[RoomIdentity.roomKey(s)] = s.online; });
    // 因盯守名额满而排队的房间（面板里提示「开了开关却没反应」的原因）
    const queuedKeys = new Set((extra.watchQueued || []).map(q => RoomIdentity.roomKey(q)));

    // 头部信号条：按在线房间数（1/3/6/10 档）点亮
    const onlineCount = streamers.filter(s => s.online).length;
    document.getElementById('headMeter').dataset.lit =
      onlineCount >= 10 ? '4' : onlineCount >= 6 ? '3' : onlineCount >= 3 ? '2' : onlineCount >= 1 ? '1' : '0';

    renderAddCategoryOptions(categories);

    // 分组投影（未分类固定最前、其余按分类顺序、保留空分组）交给 lib/room-categories.js；
    // 房间带上开播态供「在播数/总数」计数
    const grouped = RoomCategories.buildRoomGroups({
      rooms: rooms.map(r => ({ ...r, online: onlineMap[RoomIdentity.roomKey(r)] })),
      categories,
      hideEmptyGroups: false
    });
    // 一个房间都没有时只展示已建好的分类（先建分类再往里放房间）；分类也没有就只剩空提示
    const visible = rooms.length === 0 ? grouped.filter(group => group.id !== '') : grouped;
    emptyRooms.classList.toggle('hidden', rooms.length > 0);
    if (visible.length === 0) {
      roomList.innerHTML = '';
      return;
    }

    const panelState = {
      settings,
      watchEnabled: danmakuWatchEnabled.checked,
      alertEnabled: viewerAlertEnabled.checked,
      surgeEnabled: surgeAlertEnabled.checked,
      highlightEnabled: highlightAlertEnabled.checked,
      queuedKeys
    };
    roomList.innerHTML = visible
      .map(group => renderCategorySection(group, { categories, panelState }))
      .join('');

    wireRoomItems();
    initDragAndDrop();
  }

  /** 一个分类段：标题行（分类名 + 在播数/总数 + 就地改名 / 删除）+ 该分类下的房间行 */
  function renderCategorySection(group, { categories, panelState }) {
    const head = group.id === ''
      ? `<div class="category-head" data-category-id="">
          <span class="category-name-static">${RoomCategories.UNCATEGORIZED_NAME}</span>
          <span class="category-count">${group.onlineCount}/${group.totalCount}</span>
        </div>`
      : `<div class="category-head" data-category-id="${escapeAttr(group.id)}">
          <span class="category-drag-handle" draggable="false" title="拖动调整分类顺序">⠿</span>
          <input class="category-name-input" data-category-id="${escapeAttr(group.id)}" value="${escapeAttr(group.name)}" maxlength="${RoomCategories.NAME_MAX_LENGTH}" title="就地改名" spellcheck="false">
          <span class="category-count">${group.onlineCount}/${group.totalCount}</span>
          <button class="category-remove" data-category-id="${escapeAttr(group.id)}" data-category-name="${escapeAttr(group.name)}" data-category-count="${group.totalCount}" title="删除分类">✕</button>
        </div>`;
    const items = group.rooms
      .map(r => renderRoomItem(r, group.id, { categories, panelState }))
      .join('');
    // 拖拽作用域就是这一段（房间拖拽只在段内生效，拖到别的段上回弹）
    return `
      <div class="category-section" data-category-id="${escapeAttr(group.id)}" draggable="false">
        ${head}
        <div class="category-rooms">${items}</div>
      </div>
    `;
  }

  /** 一行房间：既有内容不变，只在昵称与通知按钮之间多一个归类下拉（归类只有下拉一个入口） */
  function renderRoomItem(r, groupId, { categories, panelState }) {
    const onlineStatus = r.online;
    let statusCls;
    if (onlineStatus === true) {
      statusCls = 'online';
    } else if (onlineStatus === false) {
      statusCls = 'offline';
    } else {
      statusCls = 'unknown';
    }
    // 平台标签：取值与文案都来自房间标识 module；不认识的取值（只可能来自手改存储）显式标出，
    // 不回退成斗鱼，也不把原始取值拼进标记里（页面其余动态文本同样经 escapeHtml）
    const platformTag = RoomIdentity.isPlatform(r.platform)
      ? `<span class="platform-tag ${r.platform}">${RoomIdentity.platformLabel(r.platform)}</span>`
      : '<span class="platform-tag">未知平台</span>';
    return `
      <div class="room-item" data-room-id="${r.roomId}" data-platform="${r.platform}">
        <span class="drag-handle" draggable="false">⠿</span>
        <span class="status-dot ${statusCls}"></span>
        ${platformTag}
        <span class="room-id">${r.roomId}</span>
        <span class="room-nickname">${escapeHtml(r.nickname || '未知')}</span>
        <select class="room-category" title="归入哪个分类">${renderCategoryOptions(categories, groupId)}</select>
        <button class="btn-notify${roomNotifyActive(r) ? ' on' : ''}" title="该房间的通知设置">通知设置</button>
        <button class="btn-remove" data-room-id="${r.roomId}">✕</button>
        ${renderNotifyPanel(r, {
          watchEnabled: panelState.watchEnabled,
          alertEnabled: panelState.alertEnabled,
          surgeEnabled: panelState.surgeEnabled,
          highlightEnabled: panelState.highlightEnabled,
          viewerFetchEnabled: panelState.settings[RoomIdentity.viewerToggle(r.platform)] !== false,
          surgeQueued: panelState.queuedKeys.has(RoomIdentity.roomKey(r))
        })}
      </div>
    `;
  }

  /** 分类下拉的选项：未分类 + 所有分类 + 「新建分类…」；selectedId 为空串即未分类 */
  function renderCategoryOptions(categories, selectedId) {
    const options = [`<option value=""${selectedId === '' ? ' selected' : ''}>${RoomCategories.UNCATEGORIZED_NAME}</option>`];
    for (const category of categories) {
      const id = String(category.id);
      options.push(`<option value="${escapeAttr(id)}"${id === selectedId ? ' selected' : ''}>${escapeHtml(category.name)}</option>`);
    }
    options.push(`<option value="${NEW_CATEGORY_OPTION}">＋ 新建分类…</option>`);
    return options.join('');
  }

  /** 添加房间表单的分类下拉（默认未分类，尽量保留用户当前的选择） */
  function renderAddCategoryOptions(categories) {
    const prev = addRoomCategory.value;
    addRoomCategory.innerHTML = renderCategoryOptions(categories, '');
    addRoomCategory.value = categories.some(c => String(c.id) === prev) ? prev : '';
  }

  /** 弹窗输入分类名并建分类；取消或失败返回 null（失败时把原因显示在添加状态处） */
  async function createCategoryViaPrompt() {
    const name = window.prompt('新建分类名：');
    if (name === null) {
      return null; // 用户取消
    }
    const response = await chrome.runtime.sendMessage({ type: 'ADD_CATEGORY', name });
    if (!response || !response.ok) {
      showStatus(addStatus, (response && response.error) || '创建分类失败', 'error');
      return null;
    }
    return response.category;
  }

  /** 渲染完成后接线：删除房间 / 通知面板 / 归类下拉 / 分类就地改名与删除 */
  function wireRoomItems() {
    // 删除房间
    document.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const roomItem = btn.closest('.room-item');
        const roomId = btn.dataset.roomId;
        const platform = roomItem.dataset.platform;
        chrome.runtime.sendMessage({ type: 'REMOVE_ROOM', roomId, platform }, () => {
          renderRoomList();
        });
      });
    });

    // 通知设置面板：展开/收起（昵称后的入口按钮，面板占整行）
    document.querySelectorAll('.btn-notify').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = btn.closest('.room-item').querySelector('.notify-panel');
        panel.classList.toggle('hidden');
        btn.classList.toggle('active', !panel.classList.contains('hidden'));
      });
    });

    // 面板内任一控件改动即保存（配完即用，不用跳页面）
    document.querySelectorAll('.notify-panel').forEach(panel => {
      panel.addEventListener('change', () => saveNotifyPanel(panel));
    });

    // 归类：下拉是唯一入口（拖拽只排序、不改分类）；「新建分类…」先建再把该房放进去
    document.querySelectorAll('.room-category').forEach(select => {
      select.addEventListener('change', async () => {
        const roomItem = select.closest('.room-item');
        if (select.value === NEW_CATEGORY_OPTION) {
          const created = await createCategoryViaPrompt();
          if (!created) {
            await renderRoomList();
            return;
          }
          select.value = String(created.id);
        }
        const response = await chrome.runtime.sendMessage({
          type: 'SET_ROOM_CATEGORY',
          roomId: roomItem.dataset.roomId,
          platform: roomItem.dataset.platform,
          categoryId: select.value
        });
        if (!response || !response.ok) {
          showStatus(addStatus, (response && response.error) || '归类失败', 'error');
        }
        await renderRoomList();
      });
    });

    // 分类就地改名（回车即失焦提交，change 只触发一次）
    document.querySelectorAll('.category-name-input').forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
      input.addEventListener('change', async () => {
        const response = await chrome.runtime.sendMessage({ type: 'RENAME_CATEGORY', id: input.dataset.categoryId, name: input.value });
        if (!response || !response.ok) {
          showStatus(addStatus, (response && response.error) || '改名失败', 'error');
        }
        await renderRoomList();
      });
    });

    // 删除分类：二次确认并报出会影响的房间数；房间本体不删，回落未分类
    document.querySelectorAll('.category-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const count = Number(btn.dataset.categoryCount) || 0;
        const confirmed = window.confirm(`「${btn.dataset.categoryName}」下有 ${count} 个房间，删除后它们将回到未分类。确定删除？`);
        if (!confirmed) {
          return;
        }
        const response = await chrome.runtime.sendMessage({ type: 'REMOVE_CATEGORY', id: btn.dataset.categoryId });
        if (!response || !response.ok) {
          showStatus(addStatus, (response && response.error) || '删除失败', 'error');
        }
        await renderRoomList();
      });
    });
  }

  // 添加房间：房间号与平台都由房间库校验（纯数字校验只有那一个口径），页面只负责空输入提示。
  // 分类下拉默认「未分类」，也可以就地「新建分类…」，新房间一次到位（落后在所属分类末尾）
  async function handleAddRoom() {
    const roomId = roomIdInput.value.trim();
    const platform = document.getElementById('roomPlatform').value;
    if (!roomId) {
      showStatus(addStatus, '请输入房间号', 'error');
      return;
    }

    let categoryId = addRoomCategory.value;
    if (categoryId === NEW_CATEGORY_OPTION) {
      const created = await createCategoryViaPrompt();
      if (!created) {
        await renderRoomList();
        return;
      }
      categoryId = String(created.id);
    }

    showStatus(addStatus, '正在解析房间号…', 'info');
    addRoomBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'ADD_ROOM', roomId, platform, categoryId }, (response) => {
      addRoomBtn.disabled = false;
      if (response?.ok) {
        roomIdInput.value = '';
        showStatus(addStatus, `已添加：${response.nickname}`, 'success');
        renderRoomList();
      } else {
        showStatus(addStatus, `${response?.error || '添加失败'}`, 'error');
      }
    });
  }

  addRoomBtn.addEventListener('click', handleAddRoom);
  roomIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddRoom();
  });

  // 先建好分类再往里放房间（分类为空也照样显示在列表里）
  newCategoryBtn.addEventListener('click', async () => {
    const created = await createCategoryViaPrompt();
    if (!created) {
      return;
    }
    showStatus(addStatus, `已新建分类：${created.name}`, 'success');
    await renderRoomList();
  });

  // 刷新全部状态
  refreshStatusBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'MANUAL_REFRESH' }, () => {
      renderRoomList();
      showStatus(addStatus, '状态已刷新', 'success');
      setTimeout(() => addStatus.classList.add('hidden'), 2000);
    });
  });

  // 轮询间隔：改动即保存（与页面其余控件一致），失焦/回车时把输入钳制回生效值
  const intervalSaved = document.getElementById('intervalSaved');
  let intervalInputTimer = null;
  let intervalTipTimer = null;
  let savedInterval = Math.max(60, parseInt(refreshInterval.value, 10) || 60);

  function showIntervalSaved() {
    intervalSaved.classList.remove('hidden');
    clearTimeout(intervalTipTimer);
    intervalTipTimer = setTimeout(() => intervalSaved.classList.add('hidden'), 1500);
  }

  /** @param {boolean} clampToMin 输入结束（失焦/回车）时钳制并回写；输入中途只落盘合法值 */
  async function saveRefreshInterval(clampToMin) {
    const parsed = parseInt(refreshInterval.value, 10);
    if (!clampToMin && (isNaN(parsed) || parsed < 60)) {
      return; // 输入中途（删空、位数不够）不落盘，等失焦时统一钳制
    }
    const interval = Math.max(60, parsed || 60);
    if (clampToMin) {
      refreshInterval.value = interval;
    }
    if (interval === savedInterval) {
      return; // 值没变就不写盘，也避免重复触发后台同步
    }
    savedInterval = interval;
    await patchSettings({ refreshInterval: interval }); // 重建轮询 alarm 与落盘都在 SW 侧
    showIntervalSaved();
  }

  refreshInterval.addEventListener('input', () => {
    clearTimeout(intervalInputTimer);
    intervalInputTimer = setTimeout(() => saveRefreshInterval(false), 600);
  });
  refreshInterval.addEventListener('change', () => {
    clearTimeout(intervalInputTimer);
    saveRefreshInterval(true);
  });

  notificationsEnabled.addEventListener('change', async () => {
    await patchSettings({ notificationsEnabled: notificationsEnabled.checked });
  });

  // 弹幕检测总开关：即时生效（SW 断开会话并清空排队），并重绘房间列表面板内的失效提示
  danmakuWatchEnabled.addEventListener('change', async () => {
    await patchSettings({ danmakuWatchEnabled: danmakuWatchEnabled.checked });
    await renderRoomList();
  });

  // 观众数提醒总开关：即时生效（判定入口读设置），重绘房间列表面板内的失效提示
  viewerAlertEnabled.addEventListener('change', async () => {
    await patchSettings({ viewerAlertEnabled: viewerAlertEnabled.checked });
    await renderRoomList();
  });

  // 弹幕激增总开关：即时生效（SW 重算盯守计划与结算 alarm），重绘房间列表面板内的失效提示
  surgeAlertEnabled.addEventListener('change', async () => {
    await patchSettings({ surgeAlertEnabled: surgeAlertEnabled.checked });
    await renderRoomList();
  });

  // 看点通知总开关：即时生效（SW 收敛取数 alarm），重绘房间列表面板内的失效提示
  highlightAlertEnabled.addEventListener('change', async () => {
    await patchSettings({ highlightAlertEnabled: highlightAlertEnabled.checked });
    await renderRoomList();
  });

  // 今日统计总开关：即时生效（SW 收敛取数 alarm 并停止请求第三方站点）；关掉后不请求、不展示，数字保留
  todayStatsEnabled.addEventListener('change', async () => {
    await patchSettings({ todayStatsEnabled: todayStatsEnabled.checked });
  });

  // 四个激增判定参数：改动即保存（与页面其余控件一致），失焦/回车时归一化并回写生效值
  // 取值范围从 lib/danmaku-surge.js 的 SURGE_LIMITS 插进表单，避免与判定侧各写一份
  const surgeSaved = document.getElementById('surgeSaved');
  let surgeTipTimer = null;
  const surgeFields = [
    { input: surgeMultiple, settingKey: 'surgeMultiple', configKey: 'multiple', limits: SURGE_LIMITS.multiple },
    { input: surgeMinBaseline, settingKey: 'surgeMinBaseline', configKey: 'minBaseline', limits: SURGE_LIMITS.minBaseline },
    { input: surgeCooldownMinutes, settingKey: 'surgeCooldownMinutes', configKey: 'cooldownMinutes', limits: SURGE_LIMITS.cooldownMinutes },
    { input: surgeMinBuckets, settingKey: 'surgeMinBuckets', configKey: 'minBuckets', limits: SURGE_LIMITS.minBuckets }
  ];
  let savedSurge = normalizeSurgeSettings(settings);

  function showSurgeSaved() {
    surgeSaved.classList.remove('hidden');
    clearTimeout(surgeTipTimer);
    surgeTipTimer = setTimeout(() => surgeSaved.classList.add('hidden'), 1500);
  }

  async function saveSurgeNumbers() {
    const raw = {};
    for (const { input, settingKey } of surgeFields) {
      raw[settingKey] = input.value;
    }
    const normalized = normalizeSurgeSettings(raw); // 钳制 + 兜底缺省，与判定侧同一套
    const patch = {};
    let changed = false;
    for (const { input, settingKey, configKey } of surgeFields) {
      const value = normalized[configKey];
      input.value = value; // 回写实际生效值（用户看得见钳制结果）
      patch[settingKey] = value;
      if (value !== savedSurge[configKey]) {
        changed = true;
      }
    }
    if (!changed) {
      return; // 值没变就不写盘，也避免重复触发后台同步
    }
    savedSurge = normalized;
    await patchSettings(patch);
    showSurgeSaved();
  }

  for (const { input, limits } of surgeFields) {
    input.min = limits[0];
    input.max = limits[1];
    input.addEventListener('change', saveSurgeNumbers);
  }

  // 观众数开关：即时生效（SW 同步弹幕客户端连接与已存数值的清理）
  // 两个平台字段同时写入，未改动的平台取 DOM 当前状态；旧总开关由房间库在写入时删除
  async function onViewerToggle() {
    await patchSettings({
      fetchDouyuViewerCount: fetchDouyuViewerCount.checked,
      fetchBilibiliViewerCount: fetchBilibiliViewerCount.checked
    });
    // 采样开关是观众数提醒的联动前提：重绘面板内的「拿不到数值」提示
    await renderRoomList();
  }
  fetchDouyuViewerCount.addEventListener('change', onViewerToggle);
  fetchBilibiliViewerCount.addEventListener('change', onViewerToggle);

  // 初始渲染
  await renderRoomList();

  // === 拖拽排序 ===
  // 两种拖拽共用一个手势状态：房间只在所属分类段内排序（拖到别的段上回弹），分类标题手柄调整
  // 分类之间的先后（「未分类」没有手柄、拖不动）。归类不走拖拽——只有下拉一个入口（见 ADR-0008）。
  function initDragAndDrop() {
    let dragKind = null;    // 'room' | 'category' | null
    let dragRoom = null;    // 正在拖的房间行
    let dragSection = null; // 正在拖的分类段

    // 只有从手柄开始 mouse down 才启用 draggable；mouseup 重置，防止未实际拖拽时状态残留
    const resetDraggable = () => {
      roomList.querySelectorAll('.room-item, .category-section').forEach(el => {
        el.setAttribute('draggable', 'false');
      });
    };
    document.addEventListener('mouseup', resetDraggable);

    const clearMarks = () => {
      roomList.querySelectorAll('.room-item, .category-section').forEach(el => {
        el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
      });
    };

    roomList.querySelectorAll('.drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation(); // 防止冒泡到 room-item
        resetDraggable();
        dragKind = 'room';
        handle.closest('.room-item').setAttribute('draggable', 'true');
      });
    });

    roomList.querySelectorAll('.category-drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        resetDraggable();
        dragKind = 'category';
        handle.closest('.category-section').setAttribute('draggable', 'true');
      });
    });

    // 房间拖拽：作用域限定在同一个 .category-rooms 里
    roomList.querySelectorAll('.room-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        if (dragKind !== 'room') return;
        dragRoom = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.roomId);
      });

      item.addEventListener('dragover', (e) => {
        if (dragKind !== 'room' || !dragRoom) return;
        // 拖到别的分类段上不给落点提示（松手即回弹，不改分类）
        const section = item.closest('.category-section');
        if (section !== dragRoom.closest('.category-section')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (item === dragRoom) return;
        section.querySelectorAll('.room-item').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
        const rect = item.getBoundingClientRect();
        item.classList.add(e.clientY > rect.top + rect.height / 2 ? 'drag-over-bottom' : 'drag-over-top');
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      item.addEventListener('dragend', () => {
        clearMarks();
        resetDraggable();
        dragKind = null;
        dragRoom = null;
      });

      item.addEventListener('drop', async (e) => {
        if (dragKind !== 'room' || !dragRoom || item === dragRoom) return;
        const section = item.closest('.category-section');
        if (section !== dragRoom.closest('.category-section')) return; // 跨段回弹
        e.preventDefault();

        const items = Array.from(section.querySelectorAll('.room-item'));
        const dragIndex = items.indexOf(dragRoom);
        const dropIndex = items.indexOf(item);
        const rect = item.getBoundingClientRect();
        const insertAfter = e.clientY > rect.top + rect.height / 2;

        // 构建段内新顺序：拖拽项插到目标项的上/下半边
        const newOrder = items.filter(el => el !== dragRoom);
        const insertAt = dragIndex < dropIndex
          ? (insertAfter ? dropIndex : dropIndex - 1)
          : (insertAfter ? dropIndex + 1 : dropIndex);
        newOrder.splice(insertAt, 0, dragRoom);
        const order = newOrder.map(el => ({ roomId: el.dataset.roomId, platform: el.dataset.platform }));

        try {
          // 重排请求带上所在分类：房间库只置换该分类成员所占的槽位，不动别的分类
          const response = await chrome.runtime.sendMessage({ type: 'REORDER_ROOMS', categoryId: section.dataset.categoryId, order });
          if (!response || !response.ok) {
            throw new Error((response && response.error) || '重排失败');
          }
        } catch (err) {
          console.error('拖拽排序保存失败:', err);
          await renderRoomList();
          return;
        }

        clearMarks();
        resetDraggable();
        dragKind = null;
        dragRoom = null;
        await renderRoomList();
      });
    });

    // 分类拖拽：只有真分类段有手柄，未分类段既不参与排序、也不能被排到后面；
    // 未分类段仍接受落点——拖到它上面等于把这个分类排到所有分类之前（未分类永远最前）
    roomList.querySelectorAll('.category-section').forEach(section => {
      section.addEventListener('dragstart', (e) => {
        if (dragKind !== 'category') return;
        dragSection = section;
        section.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', section.dataset.categoryId);
      });

      section.addEventListener('dragover', (e) => {
        if (dragKind !== 'category' || !dragSection || section === dragSection) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        roomList.querySelectorAll('.category-section').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
        const rect = section.querySelector('.category-head').getBoundingClientRect();
        section.classList.add(e.clientY > rect.top + rect.height / 2 ? 'drag-over-bottom' : 'drag-over-top');
      });

      section.addEventListener('dragleave', () => {
        section.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      section.addEventListener('dragend', () => {
        clearMarks();
        resetDraggable();
        dragKind = null;
        dragSection = null;
      });

      section.addEventListener('drop', async (e) => {
        if (dragKind !== 'category' || !dragSection || section === dragSection) return;
        e.preventDefault();

        const headRect = section.querySelector('.category-head').getBoundingClientRect();
        const insertAfter = e.clientY > headRect.top + headRect.height / 2;
        // 分类顺序只由真分类组成；拖到未分类段上等于排到所有分类之前（未分类永远最前）
        const ids = Array.from(roomList.querySelectorAll('.category-section'))
          .map(el => el.dataset.categoryId)
          .filter(id => id !== '' && id !== dragSection.dataset.categoryId);
        const insertAt = section.dataset.categoryId === ''
          ? 0
          : (insertAfter ? ids.indexOf(section.dataset.categoryId) + 1 : ids.indexOf(section.dataset.categoryId));
        const order = ids.slice();
        order.splice(insertAt, 0, dragSection.dataset.categoryId);

        try {
          const response = await chrome.runtime.sendMessage({ type: 'REORDER_CATEGORIES', order });
          if (!response || !response.ok) {
            throw new Error((response && response.error) || '分类重排失败');
          }
        } catch (err) {
          console.error('分类排序保存失败:', err);
        }

        clearMarks();
        resetDraggable();
        dragKind = null;
        dragSection = null;
        await renderRoomList();
      });
    });
  }
});

function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** 属性值转义：回归 textContent 不转义引号，而分类名可能进 value/data-* 属性 */
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// === 房间通知设置面板（房间行内展开：开播通知 + 弹幕检测 + 观众数提醒 + 弹幕激增 + 看点通知）===
// storage 存用户意图（开播通知开关 + 检测启用开关 + 检测词 + 阈值/窗口/冷却 + 激增开关 + 看点开关），
// 检测配置的归一化在读写两侧都做：读用 lib/danmaku-watch.js 的 normalizeWatch
// （未启用/无检测词视为未配置），写用同一套归一化后再落盘，用户能直接看到自己的输入被如何处理。

/**
 * 该房是否有生效的通知配置：开播通知开启，或弹幕检测已启用且有检测词，或观众数提醒已启用，
 * 或打开了弹幕激增，或打开了看点通知（入口按钮据此高亮）
 */
function roomNotifyActive(room) {
  return room.notify === true || !!normalizeWatch(room.watch) || !!normalizeViewerAlert(room.viewerAlert) ||
    room.surgeAlert === true || room.highlightAlert === true;
}

/**
 * 渲染某房间的通知设置面板（开播通知默认关闭；检测无配置时用缺省值）
 * @param {object} room 存储中的房间对象
 * @param {object} [state]
 * @param {boolean} [state.watchEnabled] 弹幕检测总开关（关闭时面板内提示该房检测暂不生效）
 * @param {boolean} [state.alertEnabled] 观众数提醒总开关（关闭时面板内提示该房提醒暂不生效）
 * @param {boolean} [state.surgeEnabled] 弹幕激增总开关（关闭时面板内提示该房激增暂不生效）
 * @param {boolean} [state.highlightEnabled] 看点通知总开关（关闭时面板内提示该房看点暂不生效）
 * @param {boolean} [state.viewerFetchEnabled] 该平台观众数采样开关（关闭时提示拿不到数值）
 * @param {boolean} [state.surgeQueued] 该房是否因盯守名额满在排队（开了激增却迟迟不判定的原因）
 */
function renderNotifyPanel(room, { watchEnabled = true, alertEnabled = true, surgeEnabled = true, highlightEnabled = true, viewerFetchEnabled = true, surgeQueued = false } = {}) {
  const watchBlock = WATCH_PLATFORMS.includes(room.platform)
    ? renderWatchBlock(room.watch, watchEnabled)
    : `
      <div class="panel-divider"></div>
      <p class="watch-hint">该平台暂不支持弹幕检测（需要平台弹幕通道，目前仅斗鱼 / B站 支持）</p>`;
  const alertBlock = RoomIdentity.viewerMetric(room.platform)
    ? renderViewerAlertBlock(room.viewerAlert, room.platform, alertEnabled, viewerFetchEnabled)
    : `
      <div class="panel-divider"></div>
      <p class="watch-hint">该平台暂不支持观众数提醒（需要平台观众数指标，目前仅斗鱼 / B站 支持）</p>`;
  // 激增依赖与检测同一条弹幕通道：无通道的平台不重复提示（上面那条已说明原因）
  const surgeBlock = WATCH_PLATFORMS.includes(room.platform)
    ? renderSurgeBlock(room.surgeAlert, surgeEnabled, surgeQueued)
    : '';
  // 看点不看弹幕通道，只有斗鱼有这个形态的信息：平台门用 HIGHLIGHT_PLATFORMS，不是 WATCH_PLATFORMS
  const highlightBlock = HIGHLIGHT_PLATFORMS.includes(room.platform)
    ? renderHighlightBlock(room.highlightAlert, highlightEnabled)
    : `
      <div class="panel-divider"></div>
      <p class="watch-hint">该平台暂不支持看点通知（看点只有斗鱼有）</p>`;
  return `
    <div class="notify-panel hidden">
      <label class="toggle-row">
        <span>开播通知</span>
        <input type="checkbox" class="room-notify"${room.notify === true ? ' checked' : ''}>
      </label>
      ${watchBlock}
      ${alertBlock}
      ${surgeBlock}
      ${highlightBlock}
      <span class="saved-tip hidden">已保存</span>
    </div>
  `;
}

/**
 * 弹幕检测配置块（启用开关 + 检测词 + 阈值/窗口/冷却）
 * @param {object} watch rooms[].watch
 * @param {boolean} watchEnabled 总开关（关闭且该房已启用检测时提示配置暂不生效）
 */
function renderWatchBlock(watch, watchEnabled = true) {
  const enabled = watch?.enabled === true;
  const keywords = normalizeKeywords(watch?.keywords).join('\n');
  const limits = normalizeWatchLimits(watch || {});
  const masterOffHint = enabled && !watchEnabled
    ? '<p class="watch-hint master-off">弹幕检测总开关已关闭，该房配置暂不生效（在下方「通知总开关」重新打开）</p>'
    : '';
  return `
      <div class="panel-divider"></div>
      <label class="toggle-row">
        <span>弹幕检测</span>
        <input type="checkbox" class="watch-enabled"${enabled ? ' checked' : ''}>
      </label>
      <textarea class="watch-keywords" rows="3" spellcheck="false" placeholder="检测词，一行一个（最多 ${WATCH_MAX_KEYWORDS} 个，每个最多 ${WATCH_MAX_KEYWORD_LENGTH} 字）">${escapeHtml(keywords)}</textarea>
      <div class="watch-nums">
        <label class="watch-num">触发阈值 <input type="number" class="watch-threshold" min="${WATCH_LIMITS.threshold[0]}" max="${WATCH_LIMITS.threshold[1]}" value="${limits.threshold}"> 次</label>
        <label class="watch-num">窗口 <input type="number" class="watch-window" min="${WATCH_LIMITS.windowMinutes[0]}" max="${WATCH_LIMITS.windowMinutes[1]}" value="${limits.windowMinutes}"> 分钟</label>
        <label class="watch-num">冷却 <input type="number" class="watch-cooldown" min="${WATCH_LIMITS.cooldownMinutes[0]}" max="${WATCH_LIMITS.cooldownMinutes[1]}" value="${limits.cooldownMinutes}"> 分钟</label>
      </div>
      <p class="watch-hint">开播时自动盯该房弹幕：窗口内命中数达到阈值就发一条通知，之后进入冷却。子串匹配、不区分大小写；冷却 0 表示本场只报一次。</p>
      ${masterOffHint}
  `;
}

/**
 * 观众数提醒配置块（启用开关 + 阈值）
 * @param {object} alert rooms[].viewerAlert
 * @param {string} platform 平台（决定指标文案：斗鱼贵宾数 / B站高能榜在线数）
 * @param {boolean} alertEnabled 观众数提醒总开关（关闭且该房已启用时提示配置暂不生效）
 * @param {boolean} viewerFetchEnabled 该平台观众数采样开关（关闭时提示拿不到数值，联动不生效）
 */
function renderViewerAlertBlock(alert, platform, alertEnabled = true, viewerFetchEnabled = true) {
  const meta = RoomIdentity.viewerMetric(platform);
  const enabled = alert?.enabled === true;
  const threshold = viewerAlertThreshold(alert || {});
  // 平台名与指标名都取自房间标识 module，与「刷新与采样」区块里那条开关的行标题保持同源
  const platformName = RoomIdentity.platformLabel(platform);
  const hint = enabled && !alertEnabled
    ? '<p class="watch-hint master-off">观众数提醒总开关已关闭，该房配置暂不生效（在下方「通知总开关」重新打开）</p>'
    : enabled && !viewerFetchEnabled
      ? `<p class="watch-hint master-off">${platformName} · ${meta.label}开关已关闭，拿不到数值、提醒不会触发（在下方「刷新与采样」重新打开）</p>`
      : '';
  return `
      <div class="panel-divider"></div>
      <label class="toggle-row">
        <span>观众数提醒</span>
        <input type="checkbox" class="alert-enabled"${enabled ? ' checked' : ''}>
      </label>
      <div class="watch-nums">
        <label class="watch-num">超过 <input type="number" class="alert-threshold" min="${VIEWER_ALERT_LIMITS[0]}" max="${VIEWER_ALERT_LIMITS[1]}" value="${threshold}"> ${meta.shortLabel} 时提醒</label>
      </div>
      <p class="watch-hint">该房${meta.label}从阈值以下升到阈值以上时提醒一次，回落后再超过会再提醒（每 10 分钟采样一次，短时高峰可能采不到）。</p>
      ${hint}
  `;
}

/**
 * 弹幕激增配置块（只有一个复选框：倍数 / 基线门槛 / 冷却是全局参数，在下方「弹幕激增」卡片里配）
 * @param {boolean|undefined} surgeAlert rooms[].surgeAlert（纯布尔，未设置 = 关）
 * @param {boolean} surgeEnabled 激增总开关（关闭且该房已打开时提示暂不生效）
 * @param {boolean} surgeQueued 该房是否因盯守名额满在排队（排队期间不会判定）
 */
function renderSurgeBlock(surgeAlert, surgeEnabled = true, surgeQueued = false) {
  const enabled = surgeAlert === true;
  const hint = enabled && !surgeEnabled
    ? '<p class="watch-hint master-off">弹幕激增总开关已关闭，该房开关暂不生效（在下方「弹幕激增」重新打开）</p>'
    : enabled && surgeQueued
      ? '<p class="watch-hint master-off">盯守名额已满，该房正在排队，暂时不会判定激增（拖动房间列表可调整优先顺序）</p>'
      : '';
  return `
      <div class="panel-divider"></div>
      <label class="toggle-row">
        <span>弹幕激增</span>
        <input type="checkbox" class="surge-enabled"${enabled ? ' checked' : ''}>
      </label>
      <p class="watch-hint">该房弹幕条数突然涨到平时的数倍时提醒一次（倍数 / 基线门槛 / 冷却在下方「弹幕激增」里全局配置；开播约 10 分钟后才开始判定）。</p>
      ${hint}
  `;
}

/**
 * 看点通知配置块（只有一个复选框：周期固定 5 分钟、无 per-room 参数）
 * @param {boolean|undefined} highlightAlert rooms[].highlightAlert（纯布尔，未设置 = 关）
 * @param {boolean} highlightEnabled 看点通知总开关（关闭且该房已打开时提示暂不生效）
 */
function renderHighlightBlock(highlightAlert, highlightEnabled = true) {
  const enabled = highlightAlert === true;
  const hint = enabled && !highlightEnabled
    ? '<p class="watch-hint master-off">看点通知总开关已关闭，该房开关暂不生效（在下方「看点通知」重新打开）</p>'
    : '';
  return `
      <div class="panel-divider"></div>
      <label class="toggle-row">
        <span>看点通知</span>
        <input type="checkbox" class="highlight-enabled"${enabled ? ' checked' : ''}>
      </label>
      <p class="watch-hint">该房出现新看点时提醒一次。首次打开只记录当前进度，不会把已有的看点补报一遍；平台长时间不切出新看点时也不会通知（每 5 分钟查一次）。</p>
      ${hint}
  `;
}

const panelSavedTimers = new WeakMap();
/** 面板内「已保存」提示（短暂显示后自动隐藏） */
function showPanelSaved(panel) {
  const tip = panel.querySelector('.saved-tip');
  tip.classList.remove('hidden');
  clearTimeout(panelSavedTimers.get(panel));
  panelSavedTimers.set(panel, setTimeout(() => tip.classList.add('hidden'), 1500));
}

/**
 * 保存某房间的通知配置（开播通知 + 弹幕检测 + 观众数提醒 + 弹幕激增 + 看点通知）：归一化后写回表单与 storage，
 * 并让 background 立即收敛盯守连接与看点取数（平台无控件的项不写，保持原有值）
 */
async function saveNotifyPanel(panel) {
  const roomItem = panel.closest('.room-item');
  const roomId = roomItem.dataset.roomId;
  const platform = roomItem.dataset.platform;

  const notify = panel.querySelector('.room-notify').checked;
  let watch; // undefined = 面板没有该控件，不改动
  if (panel.querySelector('.watch-enabled')) {
    const keywordInput = panel.querySelector('.watch-keywords');
    const thresholdInput = panel.querySelector('.watch-threshold');
    const windowInput = panel.querySelector('.watch-window');
    const cooldownInput = panel.querySelector('.watch-cooldown');

    watch = {
      enabled: panel.querySelector('.watch-enabled').checked,
      keywords: normalizeKeywords(keywordInput.value),
      // 数值归一化复用 lib/danmaku-watch.js（与读取侧同一套区间与缺省值）
      ...normalizeWatchLimits({
        threshold: thresholdInput.value,
        windowMinutes: windowInput.value,
        cooldownMinutes: cooldownInput.value
      })
    };
    // 回写实际生效值（去空行/去重/截断/钳制后的结果）
    keywordInput.value = watch.keywords.join('\n');
    thresholdInput.value = watch.threshold;
    windowInput.value = watch.windowMinutes;
    cooldownInput.value = watch.cooldownMinutes;
  }

  let viewerAlert; // undefined = 面板没有该控件，不改动
  if (panel.querySelector('.alert-enabled')) {
    const thresholdInput = panel.querySelector('.alert-threshold');
    // 数值归一化复用 lib/viewer-alert.js（与 SW 判定侧同一套区间与缺省值）
    viewerAlert = {
      enabled: panel.querySelector('.alert-enabled').checked,
      threshold: viewerAlertThreshold({ threshold: thresholdInput.value })
    };
    thresholdInput.value = viewerAlert.threshold; // 回写钳制后的实际生效值
  }

  let surgeAlert; // undefined = 面板没有该控件，不改动
  if (panel.querySelector('.surge-enabled')) {
    surgeAlert = panel.querySelector('.surge-enabled').checked; // 纯布尔，参数是全局的
  }

  let highlightAlert; // undefined = 面板没有该控件，不改动
  if (panel.querySelector('.highlight-enabled')) {
    highlightAlert = panel.querySelector('.highlight-enabled').checked; // 纯布尔，周期是写死的
  }

  // 变更经 SW 落到房间库（页面不写 storage）：null 表示清掉该配置槽，undefined 表示不动
  const patch = { notify };
  if (watch !== undefined) patch.watch = watch;
  if (viewerAlert !== undefined) patch.viewerAlert = viewerAlert;
  if (surgeAlert !== undefined) patch.surgeAlert = surgeAlert;
  if (highlightAlert !== undefined) patch.highlightAlert = highlightAlert;
  const response = await chrome.runtime.sendMessage({
    type: 'PATCH_ROOM_CONFIG',
    roomId,
    platform,
    patch
  });
  if (!response || !response.ok) {
    return; // 房间已被移除：面板随下次渲染消失，不写回
  }

  // 入口按钮高亮 = 该房有生效的通知配置（开播通知开启，或检测已启用且有检测词，
  // 或观众数提醒已启用，或打开了弹幕激增，或打开了看点通知）
  roomItem.querySelector('.btn-notify').classList.toggle('on', roomNotifyActive(response.room || {}));
  showPanelSaved(panel);
}
