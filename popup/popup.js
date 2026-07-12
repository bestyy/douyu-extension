// popup.js — 弹窗逻辑

document.addEventListener('DOMContentLoaded', async () => {
  const streamerList = document.getElementById('streamerList');
  const onlineCount = document.getElementById('onlineCount');
  const loading = document.getElementById('loading');
  const noRoom = document.getElementById('noRoom');
  const emptyState = document.getElementById('emptyState');
  const errorState = document.getElementById('errorState');

  // 打开设置页
  document.getElementById('openOptions').addEventListener('click', openOptions);
  document.getElementById('settingsBtn').addEventListener('click', openOptions);

  // 刷新按钮
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'MANUAL_REFRESH' }, () => {
      loadData();
    });
  });

  async function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  await loadData();
});

async function loadData() {
  // Show loading, hide everything else
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('noRoom').classList.add('hidden');
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('errorState').classList.add('hidden');
  document.getElementById('streamerList').classList.add('hidden');

  try {
    const data = await chrome.storage.local.get(null);
    document.getElementById('loading').classList.add('hidden');

    // 房间号检查
    const rooms = data.rooms;
    if (!rooms || rooms.length === 0) {
      document.getElementById('noRoom').classList.remove('hidden');
      return;
    }

    const streamers = data.streamers || [];
    const onlineStreamers = streamers.filter(s => s.online);

    if (onlineStreamers.length === 0) {
      document.getElementById('emptyState').classList.remove('hidden');
      document.getElementById('onlineCount').textContent = '0';
      return;
    }

    // 渲染列表
    document.getElementById('onlineCount').textContent = String(onlineStreamers.length);
    renderStreamerList(document.getElementById('streamerList'), onlineStreamers);
    document.getElementById('streamerList').classList.remove('hidden');

  } catch (err) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('errorState').classList.remove('hidden');
  }
}

function renderStreamerList(container, streamers) {
  container.innerHTML = '';

  streamers.forEach(s => {
    const card = document.createElement('div');
    card.className = 'streamer-card';
    card.addEventListener('click', () => {
      chrome.tabs.create({ url: `https://www.douyu.com/${s.roomId}` });
    });

    const coverImg = document.createElement('img');
    coverImg.className = 'streamer-cover';
    coverImg.src = s.coverUrl || 'icons/icon48.png';
    coverImg.alt = s.nickname;
    coverImg.addEventListener('error', () => { coverImg.src = 'icons/icon48.png'; });

    const infoDiv = document.createElement('div');
    infoDiv.className = 'streamer-info';
    infoDiv.innerHTML = `
      <div class="streamer-name">${escapeHtml(s.nickname)}</div>
      <div class="streamer-title">${escapeHtml(s.title || '正在直播')}</div>
      <div class="streamer-meta">
        <span class="live-dot"></span>
        ${escapeHtml(s.category)} · ${formatNumber(s.viewers)} 人
      </div>
    `;

    card.appendChild(coverImg);
    card.appendChild(infoDiv);
    container.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatNumber(num) {
  if (num >= 10000) {
    return (num / 10000).toFixed(1) + '万';
  }
  return String(num);
}
