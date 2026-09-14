// popup.js — 弹窗逻辑
//
// 单写者（见 docs/adr/0003-room-store-single-writer.md）：弹窗只读房间库的只读快照，
// 设置变更发消息给 SW（PATCH_SETTINGS），不写 storage。

const roomStore = new RoomStore({
  storage: {
    get: keys => chrome.storage.local.get(keys),
    set: entries => chrome.storage.local.set(entries)
  }
});

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

  // 当前标签页跳转设置：变更经 SW 落到房间库
  document.getElementById('currentTabCheck').addEventListener('change', async (e) => {
    await chrome.runtime.sendMessage({ type: 'PATCH_SETTINGS', patch: { openInCurrentTab: e.target.checked } });
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
    const [snapshot, extra] = await Promise.all([
      roomStore.snapshot(),
      chrome.storage.local.get(['watchQueued', 'cookie']) // 盯守排队视图与旧版 Cookie 提示不在房间库的键内
    ]);
    const data = { ...snapshot, ...extra };
    document.getElementById('loading').classList.add('hidden');

    // 弹幕检测排队提示：并发上限已满时，超出的开播房间暂未被盯着
    renderWatchQueue(data.watchQueued);

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
      updateMeter(0);
      document.getElementById('noRoom').classList.remove('hidden');
      return;
    }

    const streamers = data.streamers || [];
    const onlineStreamers = streamers.filter(s => s.online);

    if (onlineStreamers.length === 0) {
      updateMeter(0);
      document.getElementById('emptyState').classList.remove('hidden');
      document.getElementById('onlineCount').textContent = '0';
      return;
    }

    // 渲染列表
    updateMeter(onlineStreamers.length);
    document.getElementById('onlineCount').textContent = String(onlineStreamers.length);
    renderStreamerList(document.getElementById('streamerList'), onlineStreamers);
    document.getElementById('streamerList').classList.remove('hidden');

  } catch (err) {
    updateMeter(0);
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('errorState').classList.remove('hidden');
  }
}

// 信号指示条：按在线人数点亮 1/3/6/10 档
function updateMeter(count) {
  const el = document.getElementById('monitor');
  el.dataset.lit = count >= 10 ? '4' : count >= 6 ? '3' : count >= 3 ? '2' : count >= 1 ? '1' : '0';
}

// 盯守排队提示（watchQueued 由轮询收敛点写入）：列出暂未盯守的房间昵称。
// 名额由弹幕检测与弹幕激增共用（见 ADR-0004），故文案不特指某一个功能
function renderWatchQueue(queued) {
  const hint = document.getElementById('watchQueueHint');
  const list = queued || [];
  if (list.length === 0) {
    hint.classList.add('hidden');
    return;
  }
  const names = list.map(q => q.nickname || q.roomId).join('、');
  hint.textContent = `盯守名额已满（同时最多 ${WATCH_MAX_CONCURRENT} 个开播房间），排队中：${names}`;
  hint.classList.remove('hidden');
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
      const settings = (await roomStore.snapshot()).settings; // 快照已补全缺省值
      if (settings.openInCurrentTab) {
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
      ? (typeof s.vipCount === 'number' && s.vipCount > 0 ? ` · <span class="stat-num">${formatNumber(s.vipCount)}</span> 贵宾` : '')
      : (typeof s.rankCount === 'number' && s.rankCount > 0 ? ` · <span class="stat-num">${formatNumber(s.rankCount)}</span> 高能榜` : '');
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
