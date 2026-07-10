# EH＋：原代码 vs 现版改动对照

**对比基准：** 审查时的「原代码」= `Downloads\EH_Page_Enhancer-extension-v0.1.0`（20 个文件、无 `shared/`、无 `icons/`）。

**现版源码：** 本仓库（build 后 35 个文件）。

---

## 一、包结构 / 构建（原 → 现）

| 原代码 | 现版 |
|--------|------|
| 仅 `extension/` 下 20 个文件 | 增加 `shared/`（14 模块）+ `icons/`（5 张 PNG） |
| `service-worker.js` 内联清理/保护逻辑 | 改为引用 `shared/cleanup.js` 等；build 时 `../shared/` → `./shared/` |
| `manifest.json` 引用图标但包内无 `icons/` | build 前自动生成图标并复制 |
| 无统一 Node 构建 | 新增 `scripts/build-all.mjs`、`generate-icons.mjs`；`package.json` 增加 `generate:icons`、`build:extension` |

---

## 二、9 项不一致修复（逐项对比）

### 1. 扩展图标

**原：** `manifest.json` 写 `icons/icon-*.png`，包内无目录。

**现：** 新增 `scripts/generate-icons.mjs`，生成 `extension/icons/icon-{16,32,48,128,1024}.png`，build 时复制到输出包。

---

### 2. 清理预估（N > 0 天）

**原（Downloads `service-worker.js`）：**

```js
const canAggregateClean = request.mode === 'all' || request.days === 0;
// N>0 天时 images/logs/other 预估全为 0
```

**现：**

- `shared/cleanup.js` 新增 `planRuntimeCleanup()`，`days > 0` 时按 `now - days * 86400000` 扫描记录/日志；`days = 0` 表示不按时间清理缓存
- `buildCleanupPreview()` / `cleanupActiveStorage()` 均调用 `planRuntimeCleanup()`

---

### 3. 清理「日志」范围

**原：** 只统计 `logBytes`，**不更新** `state.logs` 数组。

**现：**

- `cleanupActiveStorage()` 返回 `remainingLogs`
- `applyCleanupResult(state, result, remainingLogs)` 真正写回过滤后的日志列表

---

### 4. 受保护阈值语义

**原（内联在 service-worker）：**

```js
(record?.readCount ?? record?.cacheHitCount ?? 0) >= threshold
```

**现（`shared/cleanup.js`）：**

```js
return (record.readCount ?? 0) > threshold;
```

- 去掉 `cacheHitCount` 兜底
- `>=` 改为 `>`（阈值 3 时，第 4 次才保护）

---

### 5. 经常观看 / readCount

**原：** `stats.frequent` 从不写入；`readCount` 不递增；无浏览历史来源筛选 UI。

**现：**

| 文件 | 改动 |
|------|------|
| `service-worker.js` | `touchCacheRecordAccess()` 递增 readCount；`recordFrequentWatch()` 写入 stats |
| `shared/statistics.js` | `recordFrequentWatch()` 实现 |
| `history.html` / `history.js` | 浏览历史页提供全部 / `/g/` / `/s/` 来源筛选，并用“按观看次数”作为经常观看视图 |

---

### 6. 受保护统计 + 存储上限 enforcement

**原：** `syncPreloadCacheState()` 只同步 `imageBytes/imageRecords`；无停写逻辑。

**现：**

| 文件 | 改动 |
|------|------|
| `shared/cleanup.js` | `shouldAllowNewImageCache()` |
| `service-worker.js` | `syncPreloadCacheState()` 汇总受保护占用；`enforceImageCacheLimits()`；写入前检查 |
| `content-script.js` | 浮窗增加 `[data-role="cache-blocked"]` 提示条 |

---

### 7. 重选目录迁移确认（本次会话新增最多）

**原：** 有 i18n 文案 `migrateDirectoryConfirm`，但**从未调用**；重选目录直接开 picker。

**现：**

| 位置 | 新增内容 |
|------|----------|
| `service-worker.js` | `pendingDirectorySwitchSnapshot/Request`；打开 picker 前快照旧目录缓存；`handleDirectorySwitchResponse()`；`migrateDirectoryCacheToDirectory()`；消息 `EHPE_DIRECTORY_SWITCH_CONFIRM` / `RESPONSE` |
| `content-script.js` | `handleDirectorySwitchConfirm()` 弹 `window.confirm`；`bindRuntimeMessages()` 监听确认消息 |

---

### 8. 浏览器默认存储风险提示 icon（本次新增）

**原：** 只有点击地址后的 Profile Path 规则，无 §15 风险 icon。

**现：**

| 位置 | 改动 |
|------|------|
| `content-script.js` i18n | 新增 `browserStorageRiskTip`（中/英长文案） |
| 设置 UI HTML | 存储模式下拉旁加 `?` icon（`data-role="storage-risk-icon"`） |
| `renderStorageAddress()` | 目录模式隐藏 icon，IndexedDB 模式显示 |

---

### 9. 插件单版本运行（本次调整）

**原：** 曾规划插件 / Userscript 共存协议，并预留 `EHPE_STOP_USERSCRIPT`、`EHPE_REPORT_USERSCRIPT` 和 `userscriptDetected` 状态。

**现：**

| 位置 | 改动 |
|------|------|
| `content-script.js` | 只写入 extension owner runtime 标记，不再检测、等待或停止 userscript |
| `service-worker.js` | 不再处理 `EHPE_REPORT_USERSCRIPT`，运行状态不再记录 `userscriptDetected` |

---

## 三、按文件汇总改动清单

### 新增文件

```
scripts/generate-icons.mjs
scripts/generate-icons.ps1
scripts/build-all.mjs
scripts/build-sync.mjs
extension/icons/icon-*.png          （build 生成）
shared/*.js                         （14 个模块，build 时复制进包）
```

### 修改文件

**`extension/service-worker.js`（改动最大）**

- 从 `shared/` 导入清理、统计、格式模块
- 清理：`planRuntimeCleanup`、`remainingLogs`
- 目录：重选确认 + 目录间迁移
- 缓存：`touchCacheRecordAccess`、`enforceImageCacheLimits`、`shouldAllowNewImageCache`
- 插件单版本运行：不再保留 userscript 上报处理

**`extension/content-script.js`**

- 启动流程异步化
- 存储风险 icon + i18n
- 目录切换 confirm 对话框
- 浏览历史按钮直开兜底
- 缓存 blocked 提示

**`shared/cleanup.js`**

- `isProtectedImage/Gallery` 阈值修正
- `planRuntimeCleanup`、`shouldAllowNewImageCache`

**`shared/statistics.js`**

- `recordFrequentWatch`

**`package.json`**

- 新增 `generate:icons`、`build:extension`（指向 `build-all.mjs`）

**`scripts/build-extension.ps1`**

- 构建前生成图标；Downloads 被锁时用 robocopy

---

## 四、相对原代码 **未改** 的部分

这些在审查里提过，但本次修复 **没有动**：

| 项 | 说明 |
|----|------|
| Tampermonkey 脚本版 | 已放弃，不再保留 `userscript/` 占位 |
| 测试 harness / 图片 fixtures | 仍缺失 |
| 自动清理（上限触发） | 图片大小上限会在写入路径执行；TTL/天数已由插件后台 `ehpe-runtime-cleanup` alarm 每 24 小时静默执行，并在后台/页面打开时按上次自动清理时间补跑漏掉的 24 小时周期 |
| 临时 orphan 缓存生命周期 | 临时项在所有 EH/EX 页面关闭后自动清理 |
| 预加载矩阵 64 圆点上限 | 仍为 `Math.min(64, preloadAhead)` |
| `notifications` 权限 | manifest 有，代码未用 |
| 缓存 schema 可选字段 | 仍无 `schemaVersion` 等 |
| Super-preloader 消费端 | 在外部仓库，不在本包 |

---

## 五、如何自己 diff

项目无 git 历史时，可对比审查时的旧包特征：

```powershell
# 旧包特征：无 shared 目录、service-worker 含 canAggregateClean
Select-String -Path "<old unpacked package>\service-worker.js" -Pattern "canAggregateClean|planRuntimeCleanup|\./shared/"
```

- 有 `planRuntimeCleanup`、无 `canAggregateClean` → 已是新逻辑
- 有 `./shared/` → 已是 build 后格式

**源码编辑位置始终是：**

`extension/` 和 `shared/`

Downloads 只是 `npm run build:extension` 的输出，不要在那里直接改。
