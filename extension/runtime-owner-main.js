// MAIN world 运行时标记（规划 §5）：
// isolated world 的 content-script 会把运行时信息镜像到 <html> 的 data-ehplus-* 属性，
// 本脚本在页面主世界读取这些属性并维护 window.__EHPLUS_RUNTIME__，
// 使页面脚本与其他脚本可以直接检测扩展的接管状态。
(() => {
  if (window.__EHPLUS_RUNTIME_OWNER_MIRROR__ === true) return;
  window.__EHPLUS_RUNTIME_OWNER_MIRROR__ = true;

  const RUNTIME_ATTRS = [
    'data-ehplus-extension',
    'data-ehplus-extension-version',
    'data-ehplus-runtime-owner',
    'data-ehplus-runtime-state',
    'data-ehplus-runtime-takeover-state',
    'data-ehplus-page-session-id',
    'data-ehplus-runtime-nonce',
    'data-ehplus-runtime-updated-at',
    'data-ehplus-runtime-heartbeat-at'
  ];

  const readRuntimeFromDataset = () => {
    const data = document.documentElement?.dataset;
    if (!data || data.ehplusExtension !== '1') return null;
    return {
      owner: data.ehplusRuntimeOwner || 'extension',
      extensionVersion: data.ehplusExtensionVersion || '',
      state: data.ehplusRuntimeState || 'active',
      takeoverState: data.ehplusRuntimeTakeoverState || 'extension-owner',
      pageSessionId: data.ehplusPageSessionId || '',
      nonce: data.ehplusRuntimeNonce || '',
      updatedAt: Number(data.ehplusRuntimeUpdatedAt) || 0,
      heartbeatAt: Number(data.ehplusRuntimeHeartbeatAt) || 0
    };
  };

  const apply = () => {
    const runtime = readRuntimeFromDataset();
    if (runtime) window.__EHPLUS_RUNTIME__ = runtime;
  };

  const start = () => {
    const root = document.documentElement;
    if (!root) return;
    apply();
    new MutationObserver(apply).observe(root, {
      attributes: true,
      attributeFilter: RUNTIME_ATTRS
    });
  };

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
