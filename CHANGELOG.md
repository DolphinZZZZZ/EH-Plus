# Changelog

## 1.0.1

- Serialized custom-directory initialization and filesystem mutations so concurrent preload writes keep every page record and do not leave new conflicting temporary files.
- Added an explicit authorization-loss state: the extension temporarily uses IndexedDB while preserving the custom-directory preference, synchronizes the visible storage status, and shows a dismissible reauthorization reminder before restoring directory storage after authorization succeeds.
- Rejects HTTP-success responses that explicitly return non-image MIME types, and prevents legacy explicit non-image records from being counted, hydrated, skipped as valid cache hits, or delivered as images while preserving valid gallery JSON metadata.
- Keeps release version metadata synchronized with the manifest, including persisted runtime state, the floating panel, and the popup.

## 1.0.0

- Renamed the project from `EH_Page_Enhancer` to `EH＋` across package names, build artifact names, display strings, and license attribution.
- Unified all protocol and storage naming on the `ehplus` stem before the first public release: message types `EHPE_*` → `EHPLUS_*`, storage keys `ehpe_*` → `ehplus_*`, IndexedDB names `ehp-preload-cache` → `ehplus-preload-cache` and `ehpe-directory-storage` → `ehplus-directory-storage`, CSS prefix `ehp-` → `ehplus-`, DOM markers `data-ehpe-*` → `data-ehplus-*`, alarm names `ehpe-*` → `ehplus-*`. Pre-1.0 test data (old preload cache, settings, and directory authorization) is not migrated; old `ehpe_*` storage keys are removed on install and cooperative-cache consumers must switch to the new message names.
- First version prepared for GitHub release; build outputs now use the `EH＋-extension-v<version>` package name.
- Configured the in-extension project link and GitHub Releases update API for `EH＋`.
- Built-in auto-pager stops at the real last page instead of re-appending it in a loop: both `/s/` and `/g/` controllers track already-inserted page keys/URLs and treat a repeated next link as the end.
- Scroll-triggered auto-paging now appends the configured immediate-pages count per trigger instead of a fixed default.
- Cleanup "older than N days" for images now strips only image bodies (IndexedDB blobs or directory image files) and keeps page metadata and statistics; size-limit eviction and the new-image write gate exempt protected images, and the allocated-storage cap is enforced against total occupancy (images + logs + other).
- External cache fill now also stores images without a resolvable `gid:pageNo` as temporary URL-keyed records, following the temporary-cache lifecycle.
- Panel fixes: storage group shows real migration cache bytes, migration progress counts only actually migrated entries, the new-image write-stop notice formats sizes, `/s/` hit rate shows `hits / reads` detail, the quota reset button shows the GP cost and the confirm box collapses when account data refreshes, and the check-in tab explains the Dawn event.
- Multi-page preload scheduling with focused-tab priority, per-page queue reconciliation/dedupe, and live concurrency/queue counters in the panel.
- Migration with per-entry verification, resume after interruption, cancel button, and progress display.
- Built-in auto-pager for `/g/` gallery pages in addition to `/s/` reader pages.
- Live reader image loading status line (cache hits, retries, failures) in the floating panel.
- Cache-first first-visit adoption of the stored setting when the per-origin hint is missing.
- Slimmed release package (~0.2 MB): design assets (icon candidates, 1024px source) are excluded from builds and backed up separately.
- Debounced runtime-state persistence, batched log writes, and serialized state updates in the service worker.
- Cache statistics now count read attempts (hit or miss) as visits; gallery metadata hits only count resource reads.

## 0.1.0

- Started the public version line at `0.1.0`; visible extension names, popup text, runtime mode, and storage notices no longer describe the package as a formal test build.
- Added the first offline local-test scaffold.
- Added shared pure JavaScript modules for storage, statistics, cleanup, migration, account parsing, Dawn parsing, reset body construction, formatting, and runtime coexistence.
- Added deterministic HTML/data fixtures and a generator for PNG image fixtures.
- Added Node test coverage for first-phase behaviors.
- Expanded the Page Preload-style floating panel with planned storage, image, logs, account/quota reset, Dawn, statistics, cleanup, migration, language, and debug controls.
- Kept settings inside the floating panel with immediate apply behavior and offline simulated backend responses.
- Made the language setting apply to the floating panel and popup together, avoiding mixed Chinese/English action buttons and quick settings.
- Added an about group inside the floating panel with current version, GitHub icon/link, GitHub-only source notice, free/open-source notice, paid-copy resale warning, and GitHub Release update/download wiring.
- Reduced the extension popup to a lightweight pointer so account status, cache, statistics, check-in, and settings stay in the page floating panel.
- Added a colors group for customizing status and matrix dot colors with dot buttons, color pickers, and hex inputs.
- Added a 7-day throttled GitHub update check path and a clickable title notice for available updates.
- Removed placeholder GitHub-home links and fake update language; update checks only query real GitHub Releases when a project repository and Release API are set.
