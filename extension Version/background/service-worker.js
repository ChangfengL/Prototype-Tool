// 原型标注工具 · MV3 service worker
// 职责：工具栏图标/快捷键 → 广播激活；tab 加载时按存储设置徽标；转发标注变更刷新徽标。

const KEY_PREFIX = 'proto-anno::';

function storageKey(url) {
  try {
    return KEY_PREFIX + url.split('#')[0];
  } catch (e) {
    return null;
  }
}

async function countForUrl(url) {
  const key = url && storageKey(url);
  if (!key) return 0;
  try {
    const data = await chrome.storage.local.get(key);
    const arr = data[key];
    return Array.isArray(arr) ? arr.length : 0;
  } catch (e) {
    return 0;
  }
}

async function updateBadge(tabId, url) {
  try {
    const n = await countForUrl(url);
    await chrome.action.setBadgeText({ tabId, text: n > 0 ? String(n) : '' });
    if (n > 0) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#FF4438' });
      await chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' });
    }
  } catch (e) { /* tab 可能已关闭 */ }
}

// 工具栏图标点击（含 _execute_action 快捷键，二者都会触发 onClicked）→ 向该 tab 广播
// 激活消息；内容脚本侧负责 toggle，避免双监听导致二次切换。
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PA_ACTIVATE' });
  } catch (e) {
    // 内容脚本未注入（chrome:// 页、file:// 未授权、InPrivate 未允许等）——
    // 日志到 SW 控制台（edge://extensions → 检查视图：服务工作进程）
    console.error('[原型标注] 激活消息发送失败，tab=' + tab.id + ' url=' + (tab.url || '?') + ' : ' + e.message);
  }
});

// tab 加载完成 → 按存储计数刷新徽标
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url) {
    updateBadge(tabId, tab.url);
  }
});

// tab 切换 → 徽标跟随当前 tab 的存储计数（兜底）
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url) updateBadge(tabId, tab.url);
  } catch (e) { }
});

// 内容脚本报告标注数量变化 → 刷新徽标
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'ANNO_CHANGED' && sender.tab) {
    updateBadge(sender.tab.id, sender.tab.url);
  }
});
