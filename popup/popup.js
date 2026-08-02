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

  // 当前标签页跳转设置
  document.getElementById('currentTabCheck').addEventListener('change', async (e) => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.openInCurrentTab = e.target.checked;
    await chrome.storage.local.set({ settings });
  });

  function openOptions() {
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

    // 加载当前标签页跳转设置
    const settings = data.settings || {};
    document.getElementById('currentTabCheck').checked = !!settings.openInCurrentTab;
    if (!rooms || rooms.length === 0) {
      if (data.cookie && data.cookie.value) {
        // Old cookie data exists - show migration hint
        document.getElementById('noRoomSub').innerHTML = 
          '已升级到新版本！旧版 Cookie 配置已不再可用。<br>请前往 <a href="#" id="openOptions">设置页</a> 添加房间号';
      }
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
    card.addEventListener('click', async () => {
      const url = s.platform === 'bilibili'
        ? `https://live.bilibili.com/${s.roomId}`
        : `https://www.douyu.com/${s.roomId}`;
      const { settings } = await chrome.storage.local.get('settings');
      if (settings && settings.openInCurrentTab) {
        chrome.tabs.update({ url });
      } else {
        chrome.tabs.create({ url });
      }
    });

    const coverImg = document.createElement('img');
    coverImg.className = 'streamer-cover';
    coverImg.alt = s.nickname;
    coverImg.referrerPolicy = 'no-referrer';
    const fallbackSrc = chrome.runtime.getURL('icons/icon48.png');
    coverImg.addEventListener('error', () => {
      if (coverImg.src !== fallbackSrc) {
        coverImg.src = fallbackSrc;
      }
    });
    coverImg.src = s.coverUrl || fallbackSrc;

    const infoDiv = document.createElement('div');
    infoDiv.className = 'streamer-info';
    const platformTag = s.platform === 'bilibili'
      ? '<span class="platform-tag bilibili">B站</span>'
      : '<span class="platform-tag douyu">斗鱼</span>';
    // 平台统计：斗鱼显示贵宾数（弹幕推送 oni 消息），B站显示高能榜在线数（弹幕推送 ONLINE_RANK_COUNT），> 0 时显示
    const statText = s.platform === 'douyu'
      ? (typeof s.vipCount === 'number' && s.vipCount > 0 ? ` · ${formatNumber(s.vipCount)} 贵宾` : '')
      : (typeof s.rankCount === 'number' && s.rankCount > 0 ? ` · ${formatNumber(s.rankCount)} 高能榜` : '');
    infoDiv.innerHTML = `
      <div class="streamer-name">${platformTag}${escapeHtml(s.nickname)}</div>
      <div class="streamer-title">${escapeHtml(s.title || '正在直播')}</div>
      <div class="streamer-meta">
        <span class="live-dot"></span>
        ${escapeHtml(s.category)}${statText}
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
