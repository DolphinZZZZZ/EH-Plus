import { saveDirectoryHandle } from './directory-storage.js';

const choose = document.querySelector('#choose');
const status = document.querySelector('#status');

choose?.addEventListener('click', async () => {
  if (typeof showDirectoryPicker !== 'function') {
    setStatus('当前浏览器不支持目录授权 API');
    return;
  }

  choose.disabled = true;
  setStatus('正在等待目录选择...');
  try {
    const handle = await showDirectoryPicker({ mode: 'readwrite' });
    const saved = await saveDirectoryHandle(handle, { label: handle.name });
    const response = await chrome.runtime.sendMessage({
      type: 'EHPLUS_DIRECTORY_SELECTED',
      label: saved.label,
      selectedAt: Date.now()
    });
    if (!response?.ok) {
      throw new Error(response?.error || '后台未接受目录授权');
    }
    setStatus(`已授权：${saved.label}`);
    setTimeout(() => window.close(), 700);
  } catch (error) {
    choose.disabled = false;
    setStatus(error?.name === 'AbortError' ? '已取消选择目录' : `授权失败：${error?.message || String(error)}`);
  }
});

function setStatus(value) {
  if (status) status.textContent = value;
}
