// options/options.js — 设置页逻辑（房间号管理版）
//
// 单写者（见 docs/adr/0003-room-store-single-writer.md）：页面只读房间库的只读快照，
// 变更一律发消息给 SW（PATCH_SETTINGS / PATCH_ROOM_CONFIG / REORDER_ROOMS），页面不写 storage。

const roomStore = new RoomStore({
  storage: {
    get: keys => chrome.storage.local.get(keys),
    set: entries => chrome.storage.local.set(entries)
  }
});

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
  const roomList = document.getElementById('roomList');
  const emptyRooms = document.getElementById('emptyRooms');
  const refreshStatusBtn = document.getElementById('refreshStatusBtn');
  const addStatus = document.getElementById('addStatus');
  const refreshInterval = document.getElementById('refreshInterval');
  const notificationsEnabled = document.getElementById('notificationsEnabled');
  const danmakuWatchEnabled = document.getElementById('danmakuWatchEnabled');
  const viewerAlertEnabled = document.getElementById('viewerAlertEnabled');
  const surgeAlertEnabled = document.getElementById('surgeAlertEnabled');
  const surgeMultiple = document.getElementById('surgeMultiple');
  const surgeMinBaseline = document.getElementById('surgeMinBaseline');
  const surgeCooldownMinutes = document.getElementById('surgeCooldownMinutes');
  const fetchDouyuViewerCount = document.getElementById('fetchDouyuViewerCount');
  const fetchBilibiliViewerCount = document.getElementById('fetchBilibiliViewerCount');
  // 加载现有设置
  refreshInterval.value = settings.refreshInterval;
  notificationsEnabled.checked = settings.notificationsEnabled;
  danmakuWatchEnabled.checked = isDanmakuWatchEnabled(settings);
  viewerAlertEnabled.checked = isViewerAlertEnabled(settings);
  surgeAlertEnabled.checked = isSurgeAlertEnabled(settings);
  // 三个激增数值用归一化后的生效值回填（与判定侧同一套钳制与缺省）
  const surgeSettings = normalizeSurgeSettings(settings);
  surgeMultiple.value = surgeSettings.multiple;
  surgeMinBaseline.value = surgeSettings.minBaseline;
  surgeCooldownMinutes.value = surgeSettings.cooldownMinutes;
  fetchDouyuViewerCount.checked = settings.fetchDouyuViewerCount;
  fetchBilibiliViewerCount.checked = settings.fetchBilibiliViewerCount;

  // Migration check - old cookie config detected
  if (legacy.cookie && legacy.cookie.value && snapshot.rooms.length === 0) {
    showStatus(addStatus, '已检测到旧版配置，请添加您要监控的房间号', 'info');
  }

  // 渲染房间列表
  async function renderRoomList() {
    const [{ rooms = [], streamers = [], settings }, extra] = await Promise.all([
      roomStore.snapshot(),
      chrome.storage.local.get('watchQueued') // 盯守排队视图（SW 侧的键，不归房间库）
    ]);
    const onlineMap = {};
    streamers.forEach(s => { onlineMap[`${s.platform}_${s.roomId}`] = s.online; });
    // 观众数采样开关（联动提示用）：快照已按平台解算成布尔
    const viewerFetchByPlatform = {
      douyu: settings.fetchDouyuViewerCount,
      bilibili: settings.fetchBilibiliViewerCount
    };
    // 因盯守名额满而排队的房间（面板里提示「开了开关却没反应」的原因）
    const queuedKeys = new Set((extra.watchQueued || []).map(q => `${q.platform}_${q.roomId}`));

    // 头部信号条：按在线房间数（1/3/6/10 档）点亮
    const onlineCount = streamers.filter(s => s.online).length;
    document.getElementById('headMeter').dataset.lit =
      onlineCount >= 10 ? '4' : onlineCount >= 6 ? '3' : onlineCount >= 3 ? '2' : onlineCount >= 1 ? '1' : '0';

    if (rooms.length === 0) {
      roomList.innerHTML = '';
      emptyRooms.classList.remove('hidden');
      return;
    }
    emptyRooms.classList.add('hidden');

    roomList.innerHTML = rooms.map(r => {
      const onlineStatus = onlineMap[`${r.platform}_${r.roomId}`];
      let statusCls;
      if (onlineStatus === true) {
        statusCls = 'online';
      } else if (onlineStatus === false) {
        statusCls = 'offline';
      } else {
        statusCls = 'unknown';
      }
      const platformLabel = r.platform === 'bilibili'
        ? '<span class="platform-tag bilibili">B站</span>'
        : '<span class="platform-tag douyu">斗鱼</span>';
      return `
        <div class="room-item" data-room-id="${r.roomId}" data-platform="${r.platform}">
          <span class="drag-handle" draggable="false">⠿</span>
          <span class="status-dot ${statusCls}"></span>
          ${platformLabel}
          <span class="room-id">${r.roomId}</span>
          <span class="room-nickname">${escapeHtml(r.nickname || '未知')}</span>
          <button class="btn-notify${roomNotifyActive(r) ? ' on' : ''}" title="该房间的通知设置">通知设置</button>
          <button class="btn-remove" data-room-id="${r.roomId}">✕</button>
          ${renderNotifyPanel(r, {
            watchEnabled: danmakuWatchEnabled.checked,
            alertEnabled: viewerAlertEnabled.checked,
            surgeEnabled: surgeAlertEnabled.checked,
            viewerFetchEnabled: viewerFetchByPlatform[r.platform] !== false,
            surgeQueued: queuedKeys.has(`${r.platform}_${r.roomId}`)
          })}
        </div>
      `;
    }).join('');

    // 删除按钮事件
    document.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const roomItem = btn.closest('.room-item');
        const roomId = btn.dataset.roomId;
        const platform = roomItem.dataset.platform || 'douyu';
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

    // 初始化拖拽排序
    initDragAndDrop();
  }

  // 添加房间
  async function handleAddRoom() {
    const roomId = roomIdInput.value.trim();
    const platform = document.getElementById('roomPlatform').value;
    if (!roomId) {
      showStatus(addStatus, '请输入房间号', 'error');
      return;
    }
    if (!/^\d+$/.test(roomId)) {
      showStatus(addStatus, '房间号必须为纯数字', 'error');
      return;
    }

    showStatus(addStatus, '正在解析房间号…', 'info');
    addRoomBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'ADD_ROOM', roomId, platform }, (response) => {
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

  // 三个激增判定参数：改动即保存（与页面其余控件一致），失焦/回车时归一化并回写生效值
  // 取值范围从 lib/danmaku-surge.js 的 SURGE_LIMITS 插进表单，避免与判定侧各写一份
  const surgeSaved = document.getElementById('surgeSaved');
  let surgeTipTimer = null;
  const surgeFields = [
    { input: surgeMultiple, settingKey: 'surgeMultiple', configKey: 'multiple', limits: SURGE_LIMITS.multiple },
    { input: surgeMinBaseline, settingKey: 'surgeMinBaseline', configKey: 'minBaseline', limits: SURGE_LIMITS.minBaseline },
    { input: surgeCooldownMinutes, settingKey: 'surgeCooldownMinutes', configKey: 'cooldownMinutes', limits: SURGE_LIMITS.cooldownMinutes }
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
  function initDragAndDrop() {
    const roomList = document.getElementById('roomList');
    let dragSrc = null;

    // 只有从手柄开始 mouse down 才启用 draggable
    // 每次重新设置前先清除所有历史状态
    // document mouseup 重置所有 draggable，防止未实际拖拽时状态残留
    const resetDraggable = () => {
      roomList.querySelectorAll('.room-item').forEach(el => {
        el.setAttribute('draggable', 'false');
      });
    };
    document.addEventListener('mouseup', resetDraggable);

    roomList.querySelectorAll('.drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation(); // 防止冒泡到 room-item
        // 重置所有项，防止残留 draggable 状态
        roomList.querySelectorAll('.room-item').forEach(el => {
          el.setAttribute('draggable', 'false');
        });
        const item = handle.closest('.room-item');
        item.setAttribute('draggable', 'true');
      });
    });

    roomList.querySelectorAll('.room-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        // 只有 draggable=true 时才会触发 dragstart，
        // 而 draggable=true 仅通过手柄 mousedown 设置，
        // 所以此处不需要额外验证
        dragSrc = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.roomId);
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        if (item === dragSrc) return;

        // 判断插入位置：鼠标位于当前项上半部分还是下半部分
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const isAfter = e.clientY > midY;

        // 清除所有项的 drag-over 类
        roomList.querySelectorAll('.room-item').forEach(el => {
          el.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        item.classList.add(isAfter ? 'drag-over-bottom' : 'drag-over-top');
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      item.addEventListener('dragend', () => {
        roomList.querySelectorAll('.room-item').forEach(el => {
          el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
          el.setAttribute('draggable', 'false');
        });
        dragSrc = null;
      });

      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (item === dragSrc) return;

        // 计算新顺序
        const items = Array.from(roomList.querySelectorAll('.room-item'));
        const dragIndex = items.indexOf(dragSrc);
        const dropIndex = items.indexOf(item);

        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const insertAfter = e.clientY > midY;

        // 构建新的排序
        let newOrder;
        if (dragIndex < dropIndex) {
          // 向下拖：移除 dragSrc，插入到 dropIndex（或之后）
          newOrder = items.filter(el => el !== dragSrc);
          // 移除 dragSrc 后，目标项索引变为 dropIndex - 1
          const insertAt = insertAfter ? dropIndex : dropIndex - 1;
          newOrder.splice(insertAt, 0, dragSrc);
        } else {
          // 向上拖
          newOrder = items.filter(el => el !== dragSrc);
          const insertAt = insertAfter ? dropIndex + 1 : dropIndex;
          newOrder.splice(insertAt, 0, dragSrc);
        }

        // 目标顺序（只发房间身份，不发数据；未列出的房间由房间库按原相对顺序接尾，不会丢）
        const order = newOrder.map(el => ({
          roomId: el.dataset.roomId,
          platform: el.dataset.platform || 'douyu'
        }));

        try {
          const response = await chrome.runtime.sendMessage({ type: 'REORDER_ROOMS', order });
          if (!response || !response.ok) {
            throw new Error((response && response.error) || '重排失败');
          }
        } catch (err) {
          console.error('拖拽排序保存失败:', err);
          // 回滚到原始顺序
          await renderRoomList();
          return;
        }

        // 清除样式并重新渲染
        roomList.querySelectorAll('.room-item').forEach(el => {
          el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
          el.setAttribute('draggable', 'false');
        });
        dragSrc = null;

        // 重新渲染列表（保持新视觉顺序）
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

// === 房间通知设置面板（房间行内展开：开播通知 + 弹幕检测 + 观众数提醒 + 弹幕激增）===
// storage 存用户意图（开播通知开关 + 检测启用开关 + 检测词 + 阈值/窗口/冷却 + 激增开关），
// 检测配置的归一化在读写两侧都做：读用 lib/danmaku-watch.js 的 normalizeWatch
// （未启用/无检测词视为未配置），写用同一套归一化后再落盘，用户能直接看到自己的输入被如何处理。

/**
 * 该房是否有生效的通知配置：开播通知开启，或弹幕检测已启用且有检测词，或观众数提醒已启用，
 * 或打开了弹幕激增（入口按钮据此高亮）
 */
function roomNotifyActive(room) {
  return room.notify === true || !!normalizeWatch(room.watch) || !!normalizeViewerAlert(room.viewerAlert) ||
    room.surgeAlert === true;
}

/**
 * 渲染某房间的通知设置面板（开播通知默认关闭；检测无配置时用缺省值）
 * @param {object} room 存储中的房间对象
 * @param {object} [state]
 * @param {boolean} [state.watchEnabled] 弹幕检测总开关（关闭时面板内提示该房检测暂不生效）
 * @param {boolean} [state.alertEnabled] 观众数提醒总开关（关闭时面板内提示该房提醒暂不生效）
 * @param {boolean} [state.surgeEnabled] 弹幕激增总开关（关闭时面板内提示该房激增暂不生效）
 * @param {boolean} [state.viewerFetchEnabled] 该平台观众数采样开关（关闭时提示拿不到数值）
 * @param {boolean} [state.surgeQueued] 该房是否因盯守名额满在排队（开了激增却迟迟不判定的原因）
 */
function renderNotifyPanel(room, { watchEnabled = true, alertEnabled = true, surgeEnabled = true, viewerFetchEnabled = true, surgeQueued = false } = {}) {
  const watchBlock = WATCH_PLATFORMS.includes(room.platform)
    ? renderWatchBlock(room.watch, watchEnabled)
    : `
      <div class="panel-divider"></div>
      <p class="watch-hint">该平台暂不支持弹幕检测（需要平台弹幕通道，目前仅斗鱼 / B站 支持）</p>`;
  const alertBlock = VIEWER_METRICS[room.platform]
    ? renderViewerAlertBlock(room.viewerAlert, room.platform, alertEnabled, viewerFetchEnabled)
    : `
      <div class="panel-divider"></div>
      <p class="watch-hint">该平台暂不支持观众数提醒（需要平台观众数指标，目前仅斗鱼 / B站 支持）</p>`;
  // 激增依赖与检测同一条弹幕通道：无通道的平台不重复提示（上面那条已说明原因）
  const surgeBlock = WATCH_PLATFORMS.includes(room.platform)
    ? renderSurgeBlock(room.surgeAlert, surgeEnabled, surgeQueued)
    : '';
  return `
    <div class="notify-panel hidden">
      <label class="toggle-row">
        <span>开播通知</span>
        <input type="checkbox" class="room-notify"${room.notify === true ? ' checked' : ''}>
      </label>
      ${watchBlock}
      ${alertBlock}
      ${surgeBlock}
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
  const meta = VIEWER_METRICS[platform];
  const enabled = alert?.enabled === true;
  const threshold = viewerAlertThreshold(alert || {});
  // 指标名取自 meta.label，与「刷新与采样」区块里那条开关的行标题保持同源
  const platformName = platform === 'bilibili' ? 'B站' : '斗鱼';
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

const panelSavedTimers = new WeakMap();
/** 面板内「已保存」提示（短暂显示后自动隐藏） */
function showPanelSaved(panel) {
  const tip = panel.querySelector('.saved-tip');
  tip.classList.remove('hidden');
  clearTimeout(panelSavedTimers.get(panel));
  panelSavedTimers.set(panel, setTimeout(() => tip.classList.add('hidden'), 1500));
}

/**
 * 保存某房间的通知配置（开播通知 + 弹幕检测 + 观众数提醒 + 弹幕激增）：归一化后写回表单与 storage，
 * 并让 background 立即收敛盯守连接（平台无弹幕通道时面板里没有检测/激增控件，只写 notify）
 */
async function saveNotifyPanel(panel) {
  const roomItem = panel.closest('.room-item');
  const roomId = roomItem.dataset.roomId;
  const platform = roomItem.dataset.platform || 'douyu';

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

  // 变更经 SW 落到房间库（页面不写 storage）：null 表示清掉该配置槽，undefined 表示不动
  const patch = { notify };
  if (watch !== undefined) patch.watch = watch;
  if (viewerAlert !== undefined) patch.viewerAlert = viewerAlert;
  if (surgeAlert !== undefined) patch.surgeAlert = surgeAlert;
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
  // 或观众数提醒已启用，或打开了弹幕激增）
  roomItem.querySelector('.btn-notify').classList.toggle('on', roomNotifyActive(response.room || {}));
  showPanelSaved(panel);
}
