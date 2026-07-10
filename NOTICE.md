# Notices

## Original Userscript

- Original script name: `EHentai页面预取（Page Preload）`
- Source: `https://sleazyfork.org/zh-CN/scripts/572532-ehentai%E9%A1%B5%E9%9D%A2%E9%A2%84%E5%8F%96-page-preload`
- Author: `flying37520`
- Observed version: `0.2.0`
- License: `MIT`
- Original storage compatibility target:
  - IndexedDB database: `ehp-preload-cache`
  - Object store: `pages`
  - Key format: `gid:pageNo`
- Original page scope: primarily E-Hentai / ExHentai `/s/` image pages.

This project is a derivative work and must keep the original script name, author, source, and license visible in project documentation and release notes.

## Reference Projects

No third-party project code has been copied at this stage.

- `Super-preloader` (`Super_preloaderPlus_one_New`), `https://github.com/machsix/Super-preloader`, license `GPL-3.0-or-later`. Behavior reference only: EH/EX auto-pager rule shape (`#img`, `#next`/`nexturl`, inserted `sp-exhentai-img-*` fragments) and the `nl()` replacement-page retry model. No GPL source code is copied or translated into this repository. Future interoperability references should point to the upstream Super-preloader project, not a fork branch.
- `EhViewer`, `https://github.com/seven332/EhViewer`, license `Apache-2.0/GPL (varies by fork)`. Behavior reference only for Dawn of a New Day timing and parsing expectations. No source code is copied or translated into this repository.
