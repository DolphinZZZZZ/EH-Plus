const I18N = {
  'zh-CN': {
    mode: '1.0.0',
    message: '账号状态、缓存、统计、签到和设置都在网页悬浮窗内显示与操作。',
    historyLink: '浏览历史',
    footnote: '如未看到悬浮窗，请打开或刷新 E-Hentai / ExHentai 页面。'
  },
  'en-US': {
    mode: '1.0.0',
    message: 'Account status, cache, statistics, check-in, and settings are all shown and operated in the page floating panel.',
    historyLink: 'Browsing history',
    footnote: 'If the floating panel is not visible, open or refresh an E-Hentai / ExHentai page.'
  }
};

let currentLanguage = 'zh-CN';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  document.querySelector('[data-role="open-history"]')?.addEventListener('click', openHistoryPage);
  const response = await chrome.runtime.sendMessage({ type: 'EHPLUS_POPUP_OPENED' });
  currentLanguage = response?.state?.settings?.language === 'en-US' ? 'en-US' : 'zh-CN';
  document.documentElement.lang = currentLanguage;
  applyLanguage();
}

async function openHistoryPage() {
  const response = await chrome.runtime.sendMessage({ type: 'EHPLUS_OPEN_HISTORY' }).catch(() => null);
  if (!response?.ok) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('history.html') }).catch(() => {});
  }
  window.close();
}

function applyLanguage() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = tr(node.dataset.i18n);
  });
}

function tr(key) {
  return I18N[currentLanguage]?.[key] ?? I18N['zh-CN'][key] ?? key;
}
