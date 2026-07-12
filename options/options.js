// options/options.js — 设置页逻辑

document.addEventListener('DOMContentLoaded', async () => {
  // 加载已有的设置
  const data = await chrome.storage.local.get(null);

  const cookieInput = document.getElementById('cookieInput');
  const refreshInterval = document.getElementById('refreshInterval');
  const notificationsEnabled = document.getElementById('notificationsEnabled');

  if (data.cookie?.value) {
    cookieInput.value = data.cookie.value;
  }
  if (data.settings?.refreshInterval) {
    refreshInterval.value = data.settings.refreshInterval;
  }
  if (data.settings?.notificationsEnabled !== undefined) {
    notificationsEnabled.checked = data.settings.notificationsEnabled;
  }

  // 保存 Cookie
  document.getElementById('saveCookieBtn').addEventListener('click', async () => {
    const value = cookieInput.value.trim();
    if (!value) {
      showStatus('cookieStatus', '请输入 Cookie', 'error');
      return;
    }

    // 客户端侧 cookie 字段校验
    const required = ['acf_uid', 'acf_auth', 'acf_biz', 'acf_stk', 'acf_ct', 'acf_ltkid'];
    const parsed = {};
    value.split(';').forEach(pair => {
      const [k, ...rest] = pair.trim().split('=');
      if (k && rest.length > 0) parsed[k.trim()] = rest.join('=').trim();
    });
    const missing = required.filter(k => !parsed[k]);
    if (missing.length > 0) {
      showStatus('cookieStatus', '缺少必要字段: ' + missing.join(', '), 'error');
      return;
    }

    await chrome.storage.local.set({
      cookie: { value, lastChecked: Date.now() },
      _cookieError: null
    });

    showStatus('cookieStatus', '✅ Cookie 已保存', 'success');
  });

  // 测试连接
  document.getElementById('testCookieBtn').addEventListener('click', async () => {
    const value = cookieInput.value.trim();
    if (!value) {
      showStatus('cookieStatus', '请先输入 Cookie', 'error');
      return;
    }

    showStatus('cookieStatus', '⏳ 正在测试连接...', 'info');

    // 通过 background 测试
    chrome.runtime.sendMessage({ type: 'TEST_COOKIE', cookie: value }, (response) => {
      if (response?.valid) {
        showStatus('cookieStatus', '✅ Cookie 有效，连接成功！', 'success');
      } else {
        showStatus('cookieStatus', `❌ 连接失败：${response?.error || 'Cookie 无效或已过期'}`, 'error');
      }
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

    // 通知 background 重建定时器
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });

    showStatus('settingsStatus', '✅ 设置已保存', 'success');
  });

  // 通知开关实时保存
  notificationsEnabled.addEventListener('change', async () => {
    const data = await chrome.storage.local.get('settings');
    const settings = data.settings || {};
    settings.notificationsEnabled = notificationsEnabled.checked;
    await chrome.storage.local.set({ settings });
  });
});

function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}
