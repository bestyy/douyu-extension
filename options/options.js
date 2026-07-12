// options/options.js — 设置页逻辑（房间号管理版）

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get(null);

  const roomIdInput = document.getElementById('roomIdInput');
  const addRoomBtn = document.getElementById('addRoomBtn');
  const roomList = document.getElementById('roomList');
  const emptyRooms = document.getElementById('emptyRooms');
  const refreshStatusBtn = document.getElementById('refreshStatusBtn');
  const addStatus = document.getElementById('addStatus');
  const refreshInterval = document.getElementById('refreshInterval');
  const notificationsEnabled = document.getElementById('notificationsEnabled');

  // 加载现有设置
  if (data.settings?.refreshInterval) {
    refreshInterval.value = data.settings.refreshInterval;
  }
  if (data.settings?.notificationsEnabled !== undefined) {
    notificationsEnabled.checked = data.settings.notificationsEnabled;
  }

  // Migration check - old cookie config detected
  if (data.cookie && data.cookie.value && (!data.rooms || data.rooms.length === 0)) {
    showStatus(addStatus, '\u{1F4A1} 已检测到旧版配置，请添加您要监控的房间号', 'info');
  }

  // 渲染房间列表
  async function renderRoomList() {
    const { rooms = [], streamers = [] } = await chrome.storage.local.get(['rooms', 'streamers']);
    const onlineMap = {};
    streamers.forEach(s => { onlineMap[`${s.platform}_${s.roomId}`] = s.online; });

    if (rooms.length === 0) {
      roomList.innerHTML = '';
      emptyRooms.classList.remove('hidden');
      return;
    }
    emptyRooms.classList.add('hidden');

    roomList.innerHTML = rooms.map(r => {
      const onlineStatus = onlineMap[`${r.platform}_${r.roomId}`];
      let statusIcon;
      if (onlineStatus === true) {
        statusIcon = '🟢';
      } else if (onlineStatus === false) {
        statusIcon = '🔴';
      } else {
        statusIcon = '🟣';
      }
      const platformLabel = r.platform === 'bilibili'
        ? '<span class="platform-tag bilibili">B站</span>'
        : '<span class="platform-tag douyu">斗鱼</span>';
      const checkedAttr = r.notify === true ? 'checked' : '';
      return `
        <div class="room-item" data-room-id="${r.roomId}" data-platform="${r.platform}">
          <input type="checkbox" class="room-notify-cb" ${checkedAttr}>
          <span class="drag-handle" draggable="false">⠿</span>
          <span class="room-status">${statusIcon}</span>
          ${platformLabel}
          <span class="room-id">${r.roomId}</span>
          <span class="room-nickname">${escapeHtml(r.nickname || '未知')}</span>
          <button class="btn-remove" data-room-id="${r.roomId}">✕</button>
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

    // checkbox 变化事件 — 更新 notify 状态
    document.querySelectorAll('.room-notify-cb').forEach(cb => {
      cb.addEventListener('change', async (e) => {
        e.stopPropagation();
        const roomItem = cb.closest('.room-item');
        const roomId = roomItem.dataset.roomId;
        const platform = roomItem.dataset.platform || 'douyu';

        const { rooms = [] } = await chrome.storage.local.get('rooms');
        const updatedRooms = rooms.map(r => {
          if (r.roomId === roomId && r.platform === platform) {
            return { ...r, notify: cb.checked };
          }
          return r;
        });
        await chrome.storage.local.set({ rooms: updatedRooms });
      });
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

    showStatus(addStatus, '⏳ 正在解析房间号...', 'info');
    addRoomBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'ADD_ROOM', roomId, platform }, (response) => {
      addRoomBtn.disabled = false;
      if (response?.ok) {
        roomIdInput.value = '';
        showStatus(addStatus, `✅ 已添加：${response.nickname}`, 'success');
        renderRoomList();
      } else {
        showStatus(addStatus, `❌ ${response?.error || '添加失败'}`, 'error');
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
      showStatus(addStatus, '🔄 状态已刷新', 'success');
      setTimeout(() => addStatus.classList.add('hidden'), 2000);
    });
  });

  // 保存设置
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const interval = Math.max(60, parseInt(refreshInterval.value, 10) || 60);
    refreshInterval.value = interval;
    await chrome.storage.local.set({
      settings: {
        refreshInterval: interval,
        notificationsEnabled: notificationsEnabled.checked
      }
    });
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
    showStatus(document.getElementById('settingsStatus'), '✅ 设置已保存', 'success');
  });

  notificationsEnabled.addEventListener('change', async () => {
    const data = await chrome.storage.local.get('settings');
    const settings = data.settings || {};
    settings.notificationsEnabled = notificationsEnabled.checked;
    await chrome.storage.local.set({ settings });
  });

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

        // 从 DOM 顺序提取新 rooms 数组
        const newRooms = newOrder.map(el => ({
          roomId: el.dataset.roomId,
          platform: el.dataset.platform || 'douyu'
        }));

        // 直接写入 storage
        const { rooms = [], streamers = [] } = await chrome.storage.local.get(['rooms', 'streamers']);

        // 按新 rooms 顺序重建 rooms 对象（保留 nickname）
        const roomMap = {};
        rooms.forEach(r => {
          roomMap[`${r.platform}_${r.roomId}`] = r;
        });
        const updatedRooms = newRooms.map(r => ({
          ...roomMap[`${r.platform}_${r.roomId}`],
          roomId: r.roomId,
          platform: r.platform
        }));

        // 同步重排 streamers
        const streamerMap = {};
        streamers.forEach(s => {
          streamerMap[`${s.platform}_${s.roomId}`] = s;
        });
        const updatedStreamers = [];
        for (const r of newRooms) {
          const key = `${r.platform}_${r.roomId}`;
          if (streamerMap[key]) {
            updatedStreamers.push(streamerMap[key]);
          } else {
            // 保留基本信息，等待下次刷新填充完整数据
            updatedStreamers.push({ roomId: r.roomId, platform: r.platform, online: false });
          }
        }

        try {
          await chrome.storage.local.set({
            rooms: updatedRooms,
            streamers: updatedStreamers
          });
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
