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
      return `
        <div class="room-item" data-room-id="${r.roomId}" data-platform="${r.platform}">
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
