// 原型标注工具 · MV3 service worker
// 职责：工具栏图标/快捷键 → 广播激活；tab 加载时按存储设置徽标；转发标注变更刷新徽标。

const KEY_PREFIX = 'proto-anno::';

function storageKey(url) {
  return url ? KEY_PREFIX + url.split('#')[0] : null;
}

async function countForUrl(url) {
  const key = url && storageKey(url);
  if (!key) return 0;
  try {
    const data = await chrome.storage.local.get(key);
    // 存储侧是 JSON 字符串（annotator.js save() 用 stringify 写入），需解析后计数
    const raw = data[key];
    if (!raw) return 0;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
    // 内容脚本尚未就绪是常态（刚重载扩展、页面未刷新、受保护页面），不是错误：
    // 短暂等待后重试一次，仍失败则静默退出（用户再点一次即可）。
    try {
      await new Promise((r) => setTimeout(r, 300));
      await chrome.tabs.sendMessage(tab.id, { type: 'PA_ACTIVATE' });
    } catch (e2) { /* 页面不可注入（chrome:// 、扩展刚重载未刷新等）：静默 */ }
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ANNO_CHANGED' && sender.tab) {
    updateBadge(sender.tab.id, sender.tab.url);
  }
  // 截图请求（content script 无权调用 captureVisibleTab，必须由 SW 代发）
  if (msg && msg.type === 'PA_CAPTURE' && sender.tab) {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      const err = chrome.runtime.lastError;
      sendResponse(err ? { ok: false, error: err.message } : { ok: true, dataUrl });
    });
    return true; // 异步响应通道
  }
});
