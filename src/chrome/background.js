/* 悟道书签管理器 · 后台脚本
 *
 * Chrome / Edge 跑 service worker，Firefox 跑 event page —— 代码两边通用（都只在顶层注册监听器）。
 * 单击扩展图标时：
 *   ① Chrome / Edge 114+：打开原生侧边栏 sidePanel（可拖宽度、可停靠）
 *   ② Firefox：打开自带侧边栏 sidebar_action（可在「查看 → 侧边栏」里切到左侧停靠）
 *   ③ 其余情况：打开一个带默认尺寸的独立窗口，可自由缩放 / 最大化 / 移动
 *   ④ 最后兜底：开新标签页，保证点图标永远有反应
 *
 * 全局快捷键（manifest.commands，可在浏览器扩展管理页自定义）：
 *   Alt+1 = 切换侧边栏显示 / 关闭（替代单击扩展图标）
 *   Alt+2 = 从新标签页打开管理器
 *
 * 窗口尺寸记在 storage.local，下次沿用上次调好的大小（并按当前屏幕裁剪，避免跑到屏幕外）。
 */
const LS_WIN = "wudao_win_size";
const DEFAULT_WIN = { width: 1280, height: 900 };

const api = (typeof browser !== "undefined" && browser.runtime) ? browser
          : ((typeof chrome !== "undefined" && chrome.runtime) ? chrome : null);

/* ---------- 工具 ---------- */
function getURL(p) {
  try { return api.runtime.getURL(p); } catch (e) { return p; }
}
function store() {
  try { return api.storage && api.storage.local ? api.storage.local : null; } catch (e) { return null; }
}
function readWinSize(cb) {
  const st = store();
  if (!st) return cb(null);
  try {
    const r = st.get(LS_WIN);
    if (r && typeof r.then === "function") r.then(v => cb(v && v[LS_WIN])).catch(() => cb(null));
    else cb(r && r[LS_WIN]);                       // Chrome 回调风格兜底
  } catch (e) { cb(null); }
}
/* 把记住的尺寸夹进当前屏幕可用区域 */
function clampToScreen(size) {
  const base = { width: DEFAULT_WIN.width, height: DEFAULT_WIN.height, left: 40, top: 40 };
  if (!size || !isFinite(size.width) || !isFinite(size.height)) return base;
  const out = { width: Math.max(640, Math.round(size.width)), height: Math.max(480, Math.round(size.height)) };
  if (isFinite(size.left) && isFinite(size.top)) { out.left = Math.round(size.left); out.top = Math.round(size.top); }
  try {
    const w = api.windows;
    if (w && w.getLastFocused) {
      const r = w.getLastFocused({ populate: false });
      const done = info => {
        try {
          if (info && info.left != null && info.width && info.height) {
            out.width = Math.min(out.width, Math.max(640, info.width));
            out.height = Math.min(out.height, Math.max(480, info.height));
            /* 让窗口完整落在屏幕内，否则会出现"被拉出去找不回来"的窗口 */
            const maxLeft = info.left + info.width - out.width;
            const maxTop = info.top + info.height - out.height;
            out.left = Math.min(Math.max(out.left, info.left), Math.max(info.left, maxLeft));
            out.top = Math.min(Math.max(out.top, info.top), Math.max(info.top, maxTop));
          }
        } catch (e) { /* 保持默认值 */ }
      };
      if (r && typeof r.then === "function") r.then(done).catch(() => {});
      else if (typeof r === "object" && r && typeof r.then !== "function") { /* 忽略 */ }
    }
  } catch (e) { /* 没有 windows API 就不裁剪 */ }
  return out;
}

/* ---------- ② 独立窗口（可缩放） ---------- */
function openWindow() {
  const url = getURL("manager.html");
  const w = api.windows;
  if (w && w.create) {
    readWinSize(saved => {
      const opts = clampToScreen(saved);
      opts.url = url; opts.type = "popup"; opts.focused = true;
      let r;
      try { r = w.create(opts); } catch (e) { r = null; }
      if (r && typeof r.then === "function") {
        r.then(win => rememberSize(win && win.id)).catch(() => openTab(url));
      } else {
        rememberSize(r && r.id);
      }
    });
    return;
  }
  openTab(url);
}
function openTab(url) {
  try {
    if (api.tabs && api.tabs.create) {
      const r = api.tabs.create({ url: url });
      if (r && r.catch) r.catch(() => { try { window.open(url, "_blank"); } catch (e) {} });
      return;
    }
  } catch (e) { /* 忽略 */ }
  try { window.open(url, "_blank"); } catch (e) {}
}
/* 记住窗口尺寸，下次沿用 */
function rememberSize(winId) {
  const st = store();
  if (!st || !winId || !api.windows || !api.windows.onBoundsChanged) return;
  const save = win => {
    if (!win || win.id !== winId || win.state !== "normal") return;
    if (!isFinite(win.width) || !isFinite(win.height)) return;
    try { st.set({ [LS_WIN]: { width: win.width, height: win.height, left: win.left, top: win.top } }); } catch (e) {}
  };
  try {
    api.windows.onBoundsChanged.addListener(win => { if (win && win.id === winId) save(win); });
  } catch (e) {}
}

/* ---------- 侧边栏开关（命令触发） ---------- */
/* 1.6.3 修复「快捷键只能隐藏不能再显示」：
 * Chrome 的用户手势令牌约 1ms 即失效，onCommand 的 async 监听器里
 * 任何 await / microtask 跳转都可能消耗它，导致 sidePanel.open() 报
 * "may only be called in response to a user gesture" 被静默 catch 掉。
 * 因此：监听器必须同步，open()/close() 必须是 handler 里第一个 API 调用。
 * 另外 Chrome 141+ 终于有了 sidePanel.close()，配合 onOpened/onClosed
 * 事件（141/142+）跟踪开关状态，可以实现真正的双向切换。 */

/* 按窗口跟踪侧边栏开关状态（service worker 重启会丢失，靠事件刷新） */
const panelOpenByWin = Object.create(null);
try {
  if (api && api.sidePanel && api.sidePanel.onOpened) {
    api.sidePanel.onOpened.addListener(info => { if (info && info.windowId != null) panelOpenByWin[info.windowId] = true; });
  }
  if (api && api.sidePanel && api.sidePanel.onClosed) {
    api.sidePanel.onClosed.addListener(info => { if (info && info.windowId != null) panelOpenByWin[info.windowId] = false; });
  }
} catch (e) { /* 旧版 Chrome 没有这两个事件，退化为"只能开" */ }

function toggleSidebarSync(tab) {
  /* Firefox：同步 toggle（FF 127+，本项目最低 142） */
  if (api.sidebarAction && api.sidebarAction.toggle) {
    try { api.sidebarAction.toggle(); return; } catch (e) { /* fall through */ }
  }
  /* Chrome / Edge sidePanel */
  if (api.sidePanel && api.sidePanel.open) {
    const wid = tab && tab.windowId != null ? tab.windowId : undefined;
    const opts = wid != null ? { windowId: wid } : {};
    /* 已知该窗口面板开着，且有 close()（Chrome 141+）：关闭它，实现切换 */
    if (wid != null && panelOpenByWin[wid] && api.sidePanel.close) {
      try {
        const r = api.sidePanel.close(opts);
        if (r && r.then) r.then(() => { panelOpenByWin[wid] = false; }).catch(() => {});
      } catch (e) { /* 忽略 */ }
      return;
    }
    try {
      const r = api.sidePanel.open(opts);
      if (r && r.then) {
        r.then(() => { if (wid != null) panelOpenByWin[wid] = true; })
         .catch(() => {
           /* open 被拒（常见原因：面板其实已经开着）—— 有 close() 就关掉，
            * 这样即使状态跟踪丢了（SW 重启），第二次按快捷键也能关 */
           if (api.sidePanel.close) {
             try {
               const c = api.sidePanel.close(opts);
               if (c && c.then) c.then(() => { if (wid != null) panelOpenByWin[wid] = false; }).catch(() => {});
             } catch (e) { /* 忽略 */ }
           }
         });
      }
      return;
    } catch (e) { /* 落下面板窗口 */ }
  }
  /* 兜底：开窗口 */
  openWindow();
}

/* ---------- 启动逻辑 ---------- */
(function init() {
  if (!api || !api.action) return;

  let sidePanelReady = false;
  try {
    if (api.sidePanel && api.sidePanel.setPanelBehavior) {
      /* Chrome / Edge 116+：单击图标直接开侧边栏（此时 Chrome 不再派发 onClicked，下面那个监听只是保险） */
      sidePanelReady = true;
      const r = api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      if (r && r.catch) r.catch(() => { sidePanelReady = false; });
    } else if (api.sidePanel && api.sidePanel.open) {
      /* Chrome 114-115：setPanelBehavior 还不存在，靠 onClicked 调 open() */
      sidePanelReady = true;
    } else if (api.sidebarAction && api.sidebarAction.open) {
      /* Firefox：sidebar_action 声明后单击默认就会开侧边栏，这里再显式兜一次 */
      sidePanelReady = true;
    }
  } catch (e) { sidePanelReady = false; }

  try {
    api.action.onClicked.addListener(async tab => {
      /* 单击图标切换：先尝试关闭已打开的侧边栏，关不掉再打开 */
      /* Firefox sidebar */
      if (api.sidebarAction && api.sidebarAction.open && api.sidebarAction.close) {
        try {
          let isOpen = false;
          try {
            const r = api.sidebarAction.isOpen({});
            isOpen = r && typeof r.then === "function" ? await r : !!r;
          } catch (e) { isOpen = false; }
          if (isOpen) { await api.sidebarAction.close(); return; }
          else { const r = api.sidebarAction.open(); if (r && r.catch) await r; return; }
        } catch (e) { /* fall through */ }
      }
      /* Chrome / Edge sidePanel：无法从后台关闭，只能打开 */
      if (sidePanelReady && api.sidePanel && api.sidePanel.open) {
        try {
          const r = api.sidePanel.open(tab && tab.windowId != null ? { windowId: tab.windowId } : {});
          if (r && r.catch) { await r; return; }
          return;
        } catch (e) { /* 落下面板窗口 */ }
      }
      openWindow();
    });
  } catch (e) { /* 连 onClicked 都不可用时，只能靠侧边栏自身行为 */ }

  /* ---------- 全局快捷键（manifest.commands） ---------- */
  try {
    if (api.commands && api.commands.onCommand) {
      /* 关键：监听器不能用 async —— Chrome 手势令牌约 1ms 失效，
       * await 会消耗它导致 sidePanel.open() 被静默拒绝（1.6.2 的 bug）。 */
      api.commands.onCommand.addListener((command, tab) => {
        if (command === "open-in-new-tab") {
          openTab(getURL("manager.html"));
          return;
        }
        if (command === "toggle-sidebar") {
          toggleSidebarSync(tab);
          return;
        }
      });
    }
  } catch (e) { /* commands API 不可用：忽略 */ }
})();

/* ============================================================
 * 在线更新（官方商店自动更新）
 * ============================================================
 * 分发渠道是官方商店（Chrome Web Store / Edge 加载项 / Firefox AMO），
 * 新版本的下载和安装本来就由商店负责。这一段只做三件事，让更新更快、更看得见：
 *
 *   ① 浏览器启动 / 扩展冷启动时，主动催一次更新检查，
 *      不必干等浏览器按自己的节奏（Chrome 大约每几小时才轮一次）慢慢发现新版本；
 *   ② 新版本已经下载好、只等重启生效时，在图标上挂一个角标提示用户；
 *   ③ 扩展真正更新完成后，把角标清掉。
 *
 * 刻意守住的几条红线（都是为了不把"自动更新"搞坏）：
 *   · 不新增任何权限。requestUpdateCheck / onUpdateAvailable 属于 runtime，无需声明权限；
 *     而一旦新增权限，浏览器会在更新后把扩展停用、等用户手动点同意 —— 那才是真正
 *     会让"自动更新"失效的做法。
 *   · 不写 update_url。商店会自己接管更新地址；手写会被 Chrome 忽略，
 *     Edge 加载项提交时带 update_url 反而会引发更新源混乱。
 *   · 不调用 runtime.reload() 自动重启扩展 —— 那会把用户正开着的侧边栏/窗口打断。
 *     新版本由浏览器在下次启动时自然生效，这里只负责提示。
 *   · Firefox 没有 requestUpdateCheck，能力探测不到就静默跳过，交给 AMO 自己更新。
 *   · 全部包在 try/catch 里：更新检查再怎么出问题，也绝不能影响书签管理本身。
 */
const LS_UPDATE_AT = "wudao_update_checked_at";   // 上次主动检查的时间戳
const UPDATE_CHECK_GAP = 6 * 60 * 60 * 1000;      // 两次主动检查至少间隔 6 小时

/* 取一下本地化的按钮标题，用来复原 tooltip */
function actionTitle() {
  try {
    if (api.i18n && api.i18n.getMessage) return api.i18n.getMessage("extActionTitle") || "";
  } catch (e) { /* 忽略 */ }
  return "";
}

/* 角标：提示"新版本已就绪，重启浏览器后生效" */
function setUpdatingBadge(on) {
  try {
    if (!api.action || !api.action.setBadgeText) return;
    if (on) {
      api.action.setBadgeText({ text: "NEW" });
      if (api.action.setBadgeBackgroundColor) api.action.setBadgeBackgroundColor({ color: "#ff4444" });
      if (api.action.setTitle) {
        const t = actionTitle();
        api.action.setTitle({ title: (t ? t + " - " : "") + "有新版本可用！重启浏览器后生效" });
      }
    } else {
      api.action.setBadgeText({ text: "" });
      if (api.action.setTitle) api.action.setTitle({ title: actionTitle() || "悟道书签管理器" });
    }
  } catch (e) { /* 角标失败不影响任何功能 */ }
}

/* 消化 requestUpdateCheck 的结果（兼容 promise 与老式回调两种签名） */
function applyUpdateStatus(res, _details) {
  const status = (res && res.status) ? res.status : res;
  if (status === "update_available") setUpdatingBadge(true);
  else if (status === "no_update") setUpdatingBadge(false);
  /* "throttled"：刚查过，浏览器让等等 —— 什么都不做 */
}

/* 触发一次更新检查；force=false 时按 6 小时节流，避免拖慢浏览器 */
function requestUpdateCheck(force) {
  if (!api || !api.runtime || typeof api.runtime.requestUpdateCheck !== "function") return;   // Firefox：交给 AMO
  const run = () => {
    try {
      let ret;
      try { ret = api.runtime.requestUpdateCheck(); } catch (e) { ret = undefined; }
      if (ret && typeof ret.then === "function") { ret.then(applyUpdateStatus).catch(() => {}); return; }
      /* 老版本 Chrome 是回调签名，兜底再试一次 */
      try { api.runtime.requestUpdateCheck(applyUpdateStatus); } catch (e) {}
    } catch (e) { /* 静默：检查更新失败绝不影响书签功能 */ }
  };
  const st = store();
  if (!st) { run(); return; }
  try {
    const r = st.get(LS_UPDATE_AT);
    const decide = v => {
      const last = (v && v[LS_UPDATE_AT]) || 0;
      const now = Date.now();
      if (!force && now - last < UPDATE_CHECK_GAP) return;
      try { st.set({ [LS_UPDATE_AT]: now }); } catch (e) {}
      run();
    };
    if (r && typeof r.then === "function") r.then(decide).catch(() => run());
    else decide(r);
  } catch (e) { run(); }
}

/* 新版本装好之后，打开“已更新”页面明确告诉用户。
 * 这是沙拉查词那类扩展“打开浏览器后跳转到一个页面提示更新”的同款做法：
 * 页面不参与更新，只是把“更新已经生效”这件事讲清楚。
 * 注意 tabs.create 不需要 "tabs" 权限（那个权限只用于读取标签页的敏感属性），
 * 所以这里同样没有新增任何权限。 */
function openWhatsNew(prevVersion) {
  try {
    if (!api.tabs || !api.tabs.create) return;
    let url = getURL("updated.html");
    if (prevVersion) url += "?from=" + encodeURIComponent(prevVersion);
    const r = api.tabs.create({ url: url });
    if (r && r.catch) r.catch(() => {});
  } catch (e) { /* 打不开就算了，绝不能影响书签功能 */ }
}

/* ---------- 把上面这些挂到启动 / 安装事件上 ---------- */
(function initUpdate() {
  if (!api || !api.runtime) return;

  /* 新版本已下载完成，只等重启生效 */
  try {
    if (api.runtime.onUpdateAvailable && api.runtime.onUpdateAvailable.addListener) {
      api.runtime.onUpdateAvailable.addListener(() => setUpdatingBadge(true));
    }
  } catch (e) { /* 不支持就忽略 */ }

  /* 扩展被更新 / 首次安装 */
  try {
    if (api.runtime.onInstalled && api.runtime.onInstalled.addListener) {
      api.runtime.onInstalled.addListener(details => {
        const reason = details && details.reason;
        if (reason === "update") {
          setUpdatingBadge(false);                              // 新版本已经生效，撤掉角标
          openWhatsNew(details && details.previousVersion);      // 打开“已更新”页面
        }
        requestUpdateCheck(reason === "install");               // 新装立刻查一次
      });
    }
  } catch (e) { /* 不支持就忽略 */ }

  /* 浏览器启动：这是"用户一打开浏览器就能自动更新"的关键一步，强制查一次。
     浏览器一天也就启动几回，不用担心负担；真查得太勤，Chrome 自己会回 'throttled'。 */
  try {
    if (api.runtime.onStartup && api.runtime.onStartup.addListener) {
      api.runtime.onStartup.addListener(() => requestUpdateCheck(true));
    }
  } catch (e) { /* 不支持就忽略 */ }

  /* service worker / event page 冷启动兜底。这条路径一小时可能被唤醒很多次，
     所以走 6 小时节流，避免像 Chrome 文档警告的那样拖慢浏览器。 */
  requestUpdateCheck(false);
})();
