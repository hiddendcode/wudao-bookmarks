"use strict";
/* ================= 悟道书签管理器 =================
 * 数据模型: DB = { folders:[{id,name,parentId,emoji?,sys?}], items:[{id,folderId,name,url,icon?,desc?,added?,pin?,usage?}] }
 * 双模式数据层:
 *   网页模式  — localStorage(key=xingchen_bm_v1) + 内嵌 SEED_DATA 初始数据
 *   扩展模式  — 直接读写浏览器书签(bookmarks API)：真同步；置顶/计数/描述/emoji 存 storage.local overlay
 *   Mock 模式 — ?mock=1 用内存假书签树模拟扩展环境，供离线测试
 */
const SEED_DATA = {"folders":[],"items":[]};
const LS_KEY = "xingchen_bm_v1", LS_PREFS = "xingchen_bm_prefs";
/* 本包是否内置了初始书签。分发版为空 —— 绝不能在没有种子数据时对用户的真实书签执行「恢复初始」 */
const HAS_SEED = Array.isArray(SEED_DATA.items) && SEED_DATA.items.length > 0;

/* ---------- 浏览器环境检测 ---------- */
const HAS_BROWSER_BM = typeof browser !== "undefined" && browser.bookmarks;
const HAS_CHROME_BM = typeof chrome !== "undefined" && chrome.bookmarks && typeof window !== "undefined";
const NATIVE_BM = HAS_BROWSER_BM ? browser.bookmarks : (HAS_CHROME_BM ? chrome.bookmarks : null);
const NATIVE_STORAGE = (typeof browser !== "undefined" && browser.storage) ? browser.storage.local : ((typeof chrome !== "undefined" && chrome.storage) ? chrome.storage.local : null);
const IS_EXT_MODE = !!NATIVE_BM;
const IS_MOCK = !IS_EXT_MODE && /mock=1/.test(String(typeof location !== "undefined" ? location.search : ""));
const SYS_ROOTS = {
  "menu________": "☰ 书签菜单",
  "toolbar_____": "📌 书签工具栏",
  "unfiled_____": "🗂 未分类书签",
  "mobile______": "📱 移动书签"
};
const DEFAULT_ROOT = "toolbar_____"; // 扩展模式在“顶层”新建时的默认容器

/* ---------- Mock：内存假书签树（模拟扩展 API，供测试） ---------- */
if (IS_MOCK) {
  let seq = 100;
  const nid = p => p + (++seq);
  window.__mockTree = [{
    id: "root________", title: "", type: "folder",
    children: [
      { id: "menu________", title: "menu", type: "folder", children: [
        { id: nid("mf"), title: "菜单示例夹", type: "folder", children: [
          { id: nid("mb"), title: "菜单书签A", url: "https://menu-a.example.com/", type: "bookmark" }
        ] }
      ]},
      { id: "toolbar_____", title: "toolbar", type: "folder", children: [
        { id: nid("tb"), title: "工具栏书签B", url: "https://toolbar-b.example.com/", type: "bookmark" },
        { id: nid("tf"), title: "工具栏文件夹", type: "folder", children: [
          { id: nid("tfc"), title: "深层书签C", url: "https://deep-c.example.com/", type: "bookmark" }
        ] }
      ]},
      { id: "unfiled_____", title: "unfiled", type: "folder", children: [] }
    ]
  }];
  const evs = { onCreated: [], onRemoved: [], onChanged: [], onMoved: [] };
  const fire = n => evs[n].forEach(f => { try { f(); } catch (e) {} });
  const clone = o => JSON.parse(JSON.stringify(o));
  const findNode = id => { let r = null; (function walk(ns) { ns.forEach(n => { if (n.id === id) r = n; if (n.children) walk(n.children); }); })(window.__mockTree); return r; };
  const findParentArr = id => { let r = null; (function walk(ns) { ns.forEach(n => { if (n.children && n.children.some(c => c.id === id)) r = n.children; else if (n.children) walk(n.children); }); })(window.__mockTree); return r; };
  window.__BM_MOCK__ = {
    getTree: async () => clone(window.__mockTree),
    create: async opts => {
      const p = findNode(opts.parentId); if (!p) throw new Error("父节点不存在: " + opts.parentId);
      p.children = p.children || [];
      const node = opts.url !== undefined ? { id: nid("mk"), title: opts.title || "", url: opts.url, type: "bookmark" } : { id: nid("mk"), title: opts.title || "", type: "folder", children: [] };
      const idx = (opts.index === undefined || opts.index >= p.children.length) ? p.children.length : opts.index;
      p.children.splice(idx, 0, node);
      fire("onCreated"); return clone(node);
    },
    remove: async id => {
      const arr = findParentArr(id); if (!arr) throw new Error("节点不存在: " + id);
      const i = arr.findIndex(x => x.id === id);
      const node = arr[i];
      if (node.type === "folder" && node.children && node.children.length) throw new Error("文件夹非空，不能删除");
      arr.splice(i, 1); fire("onRemoved");
    },
    removeTree: async id => { const arr = findParentArr(id); if (!arr) throw new Error("节点不存在"); arr.splice(arr.findIndex(x => x.id === id), 1); fire("onRemoved"); },
    update: async (id, ch) => { const n = findNode(id); if (!n) throw new Error("节点不存在"); if (ch.title !== undefined) n.title = ch.title; if (ch.url !== undefined) n.url = ch.url; fire("onChanged"); },
    move: async (id, opts) => {
      const arr = findParentArr(id); if (!arr) throw new Error("节点不存在");
      const i = arr.findIndex(x => x.id === id);
      const node = arr.splice(i, 1)[0];
      const p = findNode(opts.parentId); p.children = p.children || [];
      const idx = (opts.index === undefined || opts.index >= p.children.length) ? p.children.length : opts.index;
      p.children.splice(idx, 0, node); fire("onMoved");
    },
    onCreated: { addListener: f => evs.onCreated.push(f) },
    onRemoved: { addListener: f => evs.onRemoved.push(f) },
    onChanged: { addListener: f => evs.onChanged.push(f) },
    onMoved: { addListener: f => evs.onMoved.push(f) }
  };
  const mockStore = {};
  window.__STORAGE_MOCK__ = {
    get: async keys => { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in mockStore) out[k] = mockStore[k]; }); return out; },
    set: async obj => { Object.assign(mockStore, obj); }
  };
}
let BM = NATIVE_BM, EXT_STORAGE = NATIVE_STORAGE;
if (IS_MOCK) { BM = window.__BM_MOCK__; EXT_STORAGE = window.__STORAGE_MOCK__; }
const IS_SYNC_MODE = IS_EXT_MODE || IS_MOCK; // 需要与浏览器书签同步的模式

/* ---------- 扩展模式：书签树 → DB ---------- */
async function loadFromBookmarks() {
  const tree = await BM.getTree();
  const folders = [], items = [];
  const walk = (children, parentId) => {
    (children || []).forEach(ch => {
      if (ch.type === "separator") return;
      if (ch.url === undefined) { // 文件夹
        const isSys = SYS_ROOTS.hasOwnProperty(ch.id);
        const fo = { id: ch.id, name: (ch.title || "").trim() || (isSys ? SYS_ROOTS[ch.id] : "未命名文件夹"), parentId };
        if (isSys) { fo.name = SYS_ROOTS[ch.id]; fo.sys = 1; }
        folders.push(fo);
        walk(ch.children, ch.id);
      } else if (ch.url) {
        const it = { id: ch.id, folderId: parentId, name: (ch.title || ch.url).trim() || ch.url, url: ch.url };
        if (ch.dateAdded) it.added = Math.floor(ch.dateAdded / 1000);
        items.push(it);
      }
    });
  };
  (tree[0] && tree[0].children ? tree[0].children : []).forEach(cont => {
    const isSys = SYS_ROOTS.hasOwnProperty(cont.id);
    const fo = { id: cont.id, name: SYS_ROOTS[cont.id] || (cont.title || "未命名文件夹"), parentId: "root" };
    if (isSys) fo.sys = 1;
    folders.push(fo);
    walk(cont.children, cont.id);
  });
  const ov = await loadOverlay();
  folders.forEach(f => { const o = ov.f[f.id]; if (o && o.emoji) f.emoji = o.emoji; });
  items.forEach(it => { const o = ov.i[it.id]; if (o) { if (o.pin) it.pin = o.pin; if (o.usage) it.usage = o.usage; if (o.desc) it.desc = o.desc; if (o.icon) it.icon = o.icon; } });
  return { folders, items };
}
/* ---------- overlay：置顶/点击计数/描述/自定义图标/emoji（浏览器书签存不下这些字段，单独存） ---------- */
const OVERLAY_KEY = "wudao_overlay_v1";
async function loadOverlay() {
  try { const got = await EXT_STORAGE.get(OVERLAY_KEY); return (got && got[OVERLAY_KEY]) || { f: {}, i: {} }; }
  catch (e) { return { f: {}, i: {} }; }
}
async function saveOverlay() {
  const f = {}, i = {};
  DB.folders.forEach(x => { if (x.emoji && !x.sys) f[x.id] = { emoji: x.emoji }; });
  DB.items.forEach(x => { const o = {}; if (x.pin) o.pin = x.pin; if (x.usage) o.usage = x.usage; if (x.desc) o.desc = x.desc; if (x.icon) o.icon = x.icon; if (Object.keys(o).length) i[x.id] = o; });
  try { await EXT_STORAGE.set({ [OVERLAY_KEY]: { f, i } }); } catch (e) { toast("保存置顶/常用计数失败：" + (e.message || e), "bad"); }
}
/* ---------- diff 增量同步：内存 DB → 浏览器书签 ---------- */
let syncBaseline = null, syncing = false, syncChain = Promise.resolve();
function buildSnapshot(db) {
  const f = new Map(), order = new Map();
  db.folders.forEach(x => { f.set(x.id, { name: x.name, parentId: x.parentId }); order.set(x.id, []); });
  order.set("root", []);
  const i = new Map();
  db.items.forEach(it => { i.set(it.id, { folderId: it.folderId, name: it.name, url: it.url }); if (order.has(it.folderId)) order.get(it.folderId).push(it.id); });
  return { f, i, order };
}
async function syncToBookmarks() {
  if (!syncBaseline) { syncBaseline = buildSnapshot(DB); return false; }
  const base = syncBaseline, cur = buildSnapshot(DB);
  let touched = false;
  const idMap = {}; // 旧临时 id → 浏览器真实 id
  const realId = id => idMap[id] || id;
  const curFolderOrder = fid => cur.order.get(fid) || [];
  /* 1) 移动：已有节点换父/换序 */
  for (const [fid, baseList] of base.order) {
    const curList = (cur.order.get(fid) || []).slice();
    let baseOrder2 = baseList.slice();
    for (let ci = 0; ci < curList.length; ci++) {
      if (baseOrder2[ci] === curList[ci]) continue;
      const mvId = curList[ci];
      if (!base.i.has(mvId)) continue; // 新建的走 create
      if (base.i.get(mvId).folderId !== realId(fid)) continue; // 换父的单独处理
      await BM.move(mvId, { parentId: realId(fid), index: ci });
      baseOrder2 = baseOrder2.filter(x => x !== mvId);
      baseOrder2.splice(ci, 0, mvId);
      touched = true;
    }
  }
  for (const [iid, info] of cur.i) {
    if (!base.i.has(iid)) continue;
    const b = base.i.get(iid);
    const targetFid = realId(info.folderId);
    if (b.folderId !== targetFid) {
      const list = curFolderOrder(info.folderId).filter(x => base.i.has(x));
      const idx = Math.max(0, list.indexOf(iid));
      await BM.move(iid, { parentId: targetFid, index: idx });
      touched = true;
    }
  }
  /* 2) 新建：先文件夹（父先建），再书签 */
  const newFolders = DB.folders.filter(x => !base.f.has(x.id) && !x.sys).sort((a, b) => folderPath(a.id).length - folderPath(b.id).length);
  for (const fo of newFolders) {
    const created = await BM.create({ title: fo.name, parentId: realId(fo.parentId) });
    idMap[fo.id] = created.id;
    fo.id = created.id; touched = true;
  }
  for (const it of DB.items) {
    if (base.i.has(it.id)) continue;
    const list = cur.order.get(it.folderId) || [];
    const idx = list.indexOf(it.id);
    const created = await BM.create({ title: it.name, url: it.url, parentId: realId(it.folderId), index: idx < 0 ? undefined : idx });
    idMap[it.id] = created.id;
    it.id = created.id; touched = true;
  }
  /* 3) 改名/改网址 */
  for (const fo of DB.folders) {
    const rid = realId(fo.id);
    if (!base.f.has(rid) || fo.sys) continue;
    const b = base.f.get(rid);
    if (b && b.name !== fo.name) { await BM.update(rid, { title: fo.name }); touched = true; }
  }
  for (const it of DB.items) {
    const rid = realId(it.id);
    if (!base.i.has(rid)) continue;
    const b = base.i.get(rid);
    if (b && (b.name !== it.name || b.url !== it.url)) { await BM.update(rid, { title: it.name, url: it.url }); touched = true; }
  }
  /* 4) 删除：书签先删，文件夹最后删（此时内容已移走） */
  for (const [iid] of base.i) if (!cur.i.has(iid)) { try { await BM.remove(iid); touched = true; } catch (e) {} }
  for (const [fid] of base.f) {
    if (cur.f.has(fid)) continue;
    try { await BM.remove(fid); touched = true; }
    catch (e) { try { await BM.removeTree(fid); touched = true; } catch (e2) { console.warn("[悟道] 文件夹删除失败:", fid, e2); } }
  }
  syncBaseline = buildSnapshot(DB);
  return touched;
}
/* 浏览器书签外部变化 → 自动刷新（仅在同步模式下；自己写回期间的事件忽略） */
if (IS_EXT_MODE && BM && BM.onCreated) {
  let evtTimer = null;
  const onChangeEvt = () => {
    if (syncing) return;
    if (useStandalone()) return; /* 独立模式不监听浏览器书签变化 */
    clearTimeout(evtTimer);
    evtTimer = setTimeout(async () => {
      try { DB = await loadFromBookmarks(); syncBaseline = buildSnapshot(DB); render(); }
      catch (e) { console.warn("[悟道] 书签重载失败:", e); }
    }, 300);
  };
  [BM.onCreated, BM.onRemoved, BM.onChanged, BM.onMoved].forEach(ev => ev && ev.addListener(onChangeEvt));
}
/* 扩展 storage 变化（其它标签页改了 prefs / 独立数据）→ 本页同步 */
if (IS_EXT_MODE && EXT_STORAGE && EXT_STORAGE.onChanged) {
  EXT_STORAGE.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.wudao_prefs) {
      try { Object.assign(pref, changes.wudao_prefs.newValue || {}); applyPrefs(); } catch (e) {}
    }
    if (changes[STANDALONE_KEY] && useStandalone()) {
      /* 独立数据被其它窗口改了，本窗口重新加载 */
      (async () => { try { DB = await loadStandalone(); render(); } catch (e) {} })();
    }
  });
}

/* ---------- 工具 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const hostOf = u => { try { return new URL(u).hostname; } catch (e) { return ""; } };
const isSafeUrl = u => /^(https?:|ftp:|file:)/i.test(u || "");
const isJsUrl = u => /^javascript:/i.test(u || "");
/* ---------- 本地文件（file://）链接的访问权限 ----------
 * 两个浏览器的机制不一样，但有一点相同：**扩展自己打不开这个开关，只能引导用户去点**。
 *   · Chrome / Edge 118+：扩展详情页最底部的「允许访问文件网址」
 *     （对应 API extension.isAllowedFileSchemeAccess）
 *   · Firefox：file:///* 是**可选权限**，用户在 about:addons 的「权限与数据」里
 *     打开「访问您计算机上的本地文件」（对应 API permissions.contains）
 * 没授权时浏览器都是**静默拦截** —— 不报错、不弹窗，表现就是"点了没反应"。
 * 所以先查权限，没权限就明确告诉用户去哪儿点，而不是让点击石沉大海。 */
const isFileUrl = u => /^file:/i.test(u || "");
/* about: 特权页面（about:debugging / about:config 等）：Firefox 与 Chrome 都禁止
 * 扩展通过任何 API 打开，唯一出路是让用户自己粘贴到地址栏 —— 与脚本书签同款处理。 */
const isAboutUrl = u => /^about:/i.test(u || "");
/* 受限协议的统一兜底：复制到剪贴板 + 明确告诉用户下一步怎么做 */
function copyUrlWithTip(url, msg) {
  const tip = msg || "地址已复制，粘贴到浏览器地址栏即可访问";
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        () => toast(tip, "ok"),
        () => toast("复制失败，请手动复制该地址到地址栏打开", "warn"));
    } else {
      toast("请手动复制该地址到地址栏打开：" + url, "warn");
    }
  } catch (e) { toast("请手动复制该地址到地址栏打开：" + url, "warn"); }
}

let _fileAccess = null;   // 缓存，避免每次点击都问一遍
const FILE_TIP_CHROMIUM = "本地文件链接需要先授权：打开 chrome://extensions → 找到本扩展 → 点「详细信息」→ 拉到页面最底部 → 打开「允许访问文件网址」，然后再点一次";
const FILE_TIP_GECKO    = "本地文件链接需要先授权：打开 about:addons → 本扩展 →「权限与数据」→ 打开「访问您计算机上的本地文件」，然后再点一次";

/* 判断当前是不是 Firefox（本段自包含，方便单独跑测试） */
function isGeckoRuntime() {
  try { return typeof browser !== "undefined" && !!browser.runtime; } catch (e) { return false; }
}
function fileAccessTip() { return isGeckoRuntime() ? FILE_TIP_GECKO : FILE_TIP_CHROMIUM; }

function checkFileAccess(cb) {
  /* 每次重新检查，不缓存 —— 用户可能刚在 about:addons 里开了权限 */
  _fileAccess = null;
  let done = false;
  const finish = v => { if (done) return; done = true; _fileAccess = !!v; cb(_fileAccess); };

  /* ---- Firefox：不预检权限，直接放行 ----
   * 1.6.2 修复：Firefox 对 file:///* 可选权限的 contains 查询不可靠
   * （用户在 about:addons 开了权限，查询仍可能返回 false），
   * 1.6.1 因此永远提示"未授权"。而打开 file:// 标签页其实不需要 host 权限，
   * 真正的成败由 background 的 open-file-url 实际尝试决定，
   * 失败时它会返回 no-permission / open-failed，再给出对应提示。 */
  if (isGeckoRuntime()) { finish(true); return; }

  /* ---- Chrome / Edge：extension.isAllowedFileSchemeAccess ---- */
  let ext = null;
  try {
    const api = (typeof chrome !== "undefined" && chrome.runtime) ? chrome : null;
    ext = api && api.extension;
  } catch (e) { ext = null; }
  if (!ext || typeof ext.isAllowedFileSchemeAccess !== "function") { finish(true); return; }
  try {
    const r = ext.isAllowedFileSchemeAccess(finish);            // Chrome 走回调签名
    if (r && typeof r.then === "function") r.then(finish).catch(() => finish(true));
  } catch (e) { finish(true); }
}

/* 打开任意 URL：file:// 在 Firefox 中需要走 background script，其他直接打开 */
function openUrlAnywhere(url) {
  /* Firefox 的 file:// URL：sidebar 上下文打不开，必须委托给 background script */
  if (/^file:/i.test(url) && isGeckoRuntime()) {
    try {
      if (browser.runtime && browser.runtime.sendMessage) {
        const p = browser.runtime.sendMessage({ type: "open-file-url", url: url });
        if (p && typeof p.then === "function") {
          p.then(res => {
            if (res && res.ok) return;
            if (res && res.err === "no-permission") { toast(fileAccessTip(), "warn"); return; }
            /* 平台禁令兜底（Firefox tabs.create 不支持 file:）：复制链接引导粘贴 */
            copyUrlWithTip(url, "浏览器限制插件直接打开本地文件：链接已复制，粘贴到地址栏即可访问");
          }).catch(() => {
            copyUrlWithTip(url, "浏览器限制插件直接打开本地文件：链接已复制，粘贴到地址栏即可访问");
          });
          return;
        }
      }
    } catch (e) { /* 落到普通方式 */ }
  }
  /* 非 file:// 或 Chrome：直接打开 */
  let api = null;
  try {
    api = (typeof browser !== "undefined" && browser.runtime) ? browser
        : ((typeof chrome !== "undefined" && chrome.runtime) ? chrome : null);
  } catch (e) { api = null; }
  try {
    if (api && api.tabs && api.tabs.create) {
      const r = api.tabs.create({ url: url });
      if (r && r.catch) r.catch(() => {
        if (!window.open(url, "_blank", "noopener")) toast("打不开链接", "warn");
      });
      return;
    }
  } catch (e) { /* 落到 window.open */ }
  try { if (!window.open(url, "_blank", "noopener")) toast("打不开链接", "warn"); } catch (e) {}
}

/* file:// 链接的统一入口 */
function openFileUrl(url) {
  checkFileAccess(ok => { if (ok) openUrlAnywhere(url); else toast(fileAccessTip(), "warn"); });
}
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtTime = sec => { if (!sec) return ""; const d = new Date(sec * 1000); const p = n => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()); };

function toast(msg, type) {
  const t = document.createElement("div");
  t.className = "toast" + (type ? " " + type : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 2400);
  setTimeout(() => t.remove(), 2800);
}

/* ---------- 独立模式存储：扩展 storage.local / localStorage 双写兜底 ----------
 * 用户在「配置 → 数据源」里选「独立模式」时，本扩展把书签存在 storage.local，
 * 与浏览器书签栏完全隔离 —— 新装即为空白，便于从零整理自己的收藏。
 */
const STANDALONE_KEY = "wudao_standalone_db_v1";
function useStandalone() {
  /* 仅扩展环境支持独立模式（web 模式无 storage.local，退回 localStorage）；
     默认独立（pref.syncMode!=="sync"），新装即空白。Mock 不参与。 */
  return IS_EXT_MODE && pref.syncMode !== "sync";
}
async function loadStandalone() {
  /* 优先扩展 storage.local；web / 兜底走 localStorage */
  if (EXT_STORAGE) {
    try {
      const got = await EXT_STORAGE.get(STANDALONE_KEY);
      if (got && got[STANDALONE_KEY]) {
        const db = got[STANDALONE_KEY];
        if (db && Array.isArray(db.folders) && Array.isArray(db.items)) return db;
      }
    } catch (e) { /* 落 localStorage */ }
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const db = JSON.parse(raw);
      if (db && Array.isArray(db.folders) && Array.isArray(db.items)) return db;
    }
  } catch (e) {}
  /* 新装 / 全空：返回空白，让用户自己加书签 */
  return { folders: [], items: [] };
}
async function saveStandalone() {
  const data = { folders: DB.folders, items: DB.items };
  if (EXT_STORAGE) {
    try { await EXT_STORAGE.set({ [STANDALONE_KEY]: data }); return; } catch (e) { /* 落 localStorage */ }
  }
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); }
  catch (e) { toast("保存失败：存储空间不足，请先导出备份并清理", "bad"); }
}

/* ---------- 状态 ---------- */
let DB = null;
let state = { view: "home", folder: null, q: "", locatingId: null };
let expandedSec = new Set();
let pref = { theme: "dark", dense: false, manage: false, navFold: false, navH: 0, lang: "zh",
  /* 数据源模式：standalone=独立本地存储(新装默认)，sync=实时读写浏览器书签 */
  syncMode: "standalone",
  /* 自定义页面内快捷键：默认 1=切换侧栏, 2=新标签页打开, /=聚焦搜索。
     用户可在「配置 → 快捷键」里重新录制。空字符串=禁用该快捷键。 */
  hkToggle: "1",
  hkOpenTab: "2",
  hkSearch: "/"
};

/* ---------- i18n 多语言 ---------- */
const I18N = {
  zh: {
    searchBookmarks: "搜索书签：名称 / 网址",
    searchWeb: "搜网页",
    newTab: "新标签页",
    donate: "捐助",
    settings: "配置",
    density: "宽松",
    densityOn: "紧凑",
    addBookmark: "添加书签",
    manage: "管理",
    home: "主页",
    frequent: "常用",
    bookmarkMenu: "书签菜单",
    bookmarkToolbar: "书签工具栏",
    uncategorized: "未分类书签",
    mobileBookmarks: "移动书签",
    moveBookmarks: "移动书签",
    dedup: "重复清理",
    addFolder: "文件夹",
    expand: "展开",
    frequentTop: "常用 / 置顶",
    hoverRemove: "(hover 可  移除，不删书签)",
    addBookmarkBtn: "＋ 书签",
    computerFiles: "电脑文件",
    localTools: "本地渗透工具",
    enter: "进入 →",
    configManage: " 管理",
    addSubfolder: "＋ 子夹",
    configCenter: "配置中心",
    importBookmarks: "导入书签",
    exportBackup: "导出 / 备份",
    shortcuts: "快捷键",
    dataSource: "数据源",
    customShortcutsDesc: "自定义本管理器内的快捷键，仅在管理器（侧边栏 / 新标签页 / 独立窗口）获得焦点时生效。",
    recordHint: "点击输入框后按下想要的组合键即可录制；按 Esc 取消录制，按 Backspace 清空。",
    globalHint: "提示：浏览器级的全局快捷键（无需焦点也可触发）请在浏览器扩展管理页 → 键盘快捷键中设置，本表显示的是默认值。",
    toggleSidebar: "① 切换侧边栏显示 / 关闭（替代单击扩展图标）",
    openInNewTab: "② 从新标签页中打开本管理器",
    focusSearch: "③ 聚焦搜索框",
    restoreDefault: "恢复默认",
    standaloneMode: "独立模式（数据存在本机，不上传）",
    syncMode: "同步模式（实时读写浏览器书签）",
    importFromBrowser: "从浏览器书签导入",
    close: "关闭",
    lang: "语言",
    langZh: "中文",
    langEn: "English",
    addFolderBtn: "＋ 文件夹",
    toolbarBookmarks: "工具栏书签",
    emptyBookmarks: "还没有任何书签，点击右上角 ➕ 添加",
    emptyFolder: "此文件夹暂无书签",
    showAll: "▼ 显示全部",
    collapse: "▲ 收起",
    totalItems: "个",
  },
  en: {
    searchBookmarks: "Search bookmarks: name / URL",
    searchWeb: "Search web",
    newTab: "New tab",
    donate: "Donate",
    settings: "Settings",
    density: "Spacious",
    densityOn: "Compact",
    addBookmark: "Add bookmark",
    manage: "Manage",
    home: "Home",
    frequent: "Frequent",
    bookmarkMenu: "Bookmark Menu",
    bookmarkToolbar: "Bookmarks Toolbar",
    uncategorized: "Uncategorized",
    mobileBookmarks: "Mobile Bookmarks",
    moveBookmarks: "Move Bookmarks",
    dedup: "Deduplicate",
    addFolder: "Folder",
    expand: "Expand",
    frequentTop: "Frequent / Pinned",
    hoverRemove: "(hover to ✕ remove, won't delete bookmark)",
    addBookmarkBtn: "+ Bookmark",
    computerFiles: "Local Files",
    localTools: "Local Tools",
    enter: "Enter →",
    configManage: "⚙ Manage",
    addSubfolder: "+ Subfolder",
    configCenter: "Settings",
    importBookmarks: "Import",
    exportBackup: "Export / Backup",
    shortcuts: "Shortcuts",
    dataSource: "Data Source",
    customShortcutsDesc: "Custom shortcuts only work when the manager (sidebar / new tab / standalone window) has focus.",
    recordHint: "Click an input then press the desired key combination to record; Esc to cancel, Backspace to clear.",
    globalHint: "Tip: Browser-level global shortcuts (work without focus) can be set in the browser extension management page → Keyboard shortcuts. This table shows defaults.",
    toggleSidebar: "① Toggle sidebar show/hide (alternative to clicking extension icon)",
    openInNewTab: "② Open manager in a new tab",
    focusSearch: "③ Focus search box",
    restoreDefault: "Restore default",
    standaloneMode: "Standalone (data stored locally, never uploaded)",
    syncMode: "Sync mode (read/write browser bookmarks in real-time)",
    importFromBrowser: "Import from browser bookmarks",
    close: "Close",
    lang: "Language",
    langZh: "中文",
    langEn: "English",
    addFolderBtn: "+ Folder",
    toolbarBookmarks: "Toolbar Bookmarks",
    emptyBookmarks: "No bookmarks yet. Click ➕ in the top right to add",
    emptyFolder: "No bookmarks in this folder",
    showAll: "▼ Show all",
    collapse: "▲ Collapse",
    totalItems: "items",
  }
};
function t(key) { return (I18N[pref.lang] && I18N[pref.lang][key]) || I18N.zh[key] || key; }

let dragItem = null;

async function loadDB() {
  /* 先读 prefs，再决定数据源 —— 否则 pref.syncMode 还没读到就走了旧分支 */
  try { Object.assign(pref, JSON.parse(localStorage.getItem(LS_PREFS) || "{}")); } catch (e) {}
  if (IS_MOCK) {
    DB = await loadFromBookmarks();
    syncBaseline = buildSnapshot(DB);
  } else if (IS_EXT_MODE && !useStandalone()) {
    DB = await loadFromBookmarks();
    syncBaseline = buildSnapshot(DB);
  } else if (IS_EXT_MODE && useStandalone()) {
    DB = await loadStandalone();
  } else {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { DB = JSON.parse(raw); if (!DB || !Array.isArray(DB.folders) || !Array.isArray(DB.items)) throw 0; }
      else { DB = JSON.parse(JSON.stringify(SEED_DATA)); saveStandalone(); toast("已载入初始书签数据：" + DB.items.length + " 个书签"); }
    } catch (e) { DB = JSON.parse(JSON.stringify(SEED_DATA)); saveStandalone(); toast("本地数据损坏，已恢复初始数据", "warn"); }
    let cleaned = 0;
    DB.items.forEach(i => { if ("excluded" in i) { delete i.excluded; cleaned++; } });
    if (cleaned) { saveStandalone(); console.log("[悟道] 已清理 " + cleaned + " 条历史屏蔽标记"); }
  }
}
function persist() {
  if (IS_MOCK || (IS_EXT_MODE && !useStandalone())) {
    syncChain = syncChain.then(async () => {
      syncing = true;
      let needRender = false;
      try {
        needRender = await syncToBookmarks();
        await saveOverlay();
      } catch (e) { toast("同步到浏览器书签失败：" + (e.message || e), "bad"); }
      finally { syncing = false; if (needRender) render(); }
    });
    return;
  }
  /* 独立模式 / 网页模式：写到独立存储 */
  saveStandalone();
}
function savePrefs() {
  localStorage.setItem(LS_PREFS, JSON.stringify(pref));
  /* prefs 跨标签共享：通过扩展 storage 同步给其它打开的窗口 */
  if (EXT_STORAGE) {
    try { EXT_STORAGE.set({ wudao_prefs: pref }); } catch (e) {}
  }
}

/* ---------- 文件夹辅助 ---------- */
const ROOT = "root";
const folderById = id => id === ROOT ? { id: ROOT, name: "书签工具栏", parentId: null } : DB.folders.find(f => f.id === id);
const childFolders = pid => DB.folders.filter(f => f.parentId === pid);
const folderItems = fid => DB.items.filter(i => i.folderId === fid);
function folderPath(fid) {
  const path = []; let cur = fid, guard = 0;
  while (cur && cur !== ROOT && guard++ < 50) {
    const f = folderById(cur);
    if (!f) break;
    path.unshift(f); cur = f.parentId;
  }
  return path;
}
function folderTreeCount(fid) {
  let n = folderItems(fid).length;
  childFolders(fid).forEach(f => { n += folderTreeCount(f.id); });
  return n;
}
const AUTO_EMOJI = [
  [/搜|search/i, "🔎"], [/网安|安全|sec|hack|攻|漏|ctf/i, "🛡️"], [/^ai$|ai工具|人工智能/i, "🤖"],
  [/编程|代码|开发|教程|学习/i, "📚"], [/中医|医|药|健康/i, "🌿"], [/工具/i, "🔧"],
  [/办公|oa|公文/i, "💼"], [/资源|破解|收藏|下载/i, "📦"], [/软件/i, "💾"],
  [/网站|合集|导航|收藏夹/i, "🌐"], [/奇安信/i, "🛰️"], [/购物|淘宝|电商/i, "🛒"],
  [/视频|电影|影视|b站|bilibili/i, "🎬"], [/音乐/i, "🎵"], [/新闻|资讯|头条/i, "📰"], [/临时|未分类/i, "🗂️"]
];
function autoEmoji(name) { for (const [re, e] of AUTO_EMOJI) if (re.test(name)) return e; return "📁"; }
const folderEmoji = f => f && (f.sys ? "" : (f.emoji || autoEmoji(f.name || "")));

/* ---------- favicon ----------
 * 双层策略，根治图标位黑块 / 灰块：
 *   预览层 —— Chromium 内置 chrome://favicon（浏览器本地缓存，命中毫秒级显示），
 *             只做“乐观预览”，永远不作为终止链路的依据
 *   权威层 —— 网络源 fetch 成 blob，解码到 canvas 做像素级验证后才显示，
 *             这是唯一能终止链路的依据
 * 为什么这么设计（实测踩坑）：
 *   - chrome://favicon 未命中时会返回 1x1 透明图或纯灰默认图，但 img 的 load
 *     事件照样触发（“假成功”）；旧逻辑误信后提前终止，真正能取到图标的源
 *     不再执行 —— 这就是搜狐这类有图标的站也显示灰块的原因
 *   - 站点根 /favicon.ico 经常 403（搜狐）/ 404（夸克）/ 返回 HTML（百度
 *     开发者搜索这类 SPA）
 *   - 第三方 iowen 已关停、DuckDuckGo / Google 在国内不可达
 * 像素验证规则（实测真站全过、假图全拦）：位图尺寸 ≥8、非透明像素 ≥20%、
 *   彩色像素（RGB 通道极差 >25）≥4%
 *     icon.horse 假站 = 256x256 纯灰（彩色 0%）；Yandex 假站 = 1x1 透明
 */
const IS_FIREFOX = /Firefox\//.test(navigator.userAgent);

/* 权威链候选：via=fetch 可像素验证；via=img 无法跨源读像素，仅作朴素兜底 */
function faviconSources(it) {
  const h = hostOf(it.url);
  const srcs = [];
  /* 用户手动指定的图标：最优先，img 直载（用户自己填的，可信） */
  if (it.icon && /^https?:/i.test(it.icon)) srcs.push({ u: it.icon, via: "img" });
  if (h) {
    /* ① icon.horse：服务端真实解析页面 <link rel=icon>，返回高清图，国内可达，带 CORS */
    srcs.push({ u: "https://icon.horse/icon/" + h, via: "fetch" });
    /* ② Yandex：稳定返回 16x16 真图，国内可达，带 CORS；假站返回 1x1 透明 */
    srcs.push({ u: "https://favicon.yandex.net/favicon/" + h, via: "fetch" });
    /* ③ 根 favicon.ico：朴素直连，部分小站只有这一个 */
    srcs.push({ u: "https://" + h + "/favicon.ico", via: "img" });
    /* ④ DuckDuckGo / Google：国外网络环境兜底（国内不可达，超时即弃） */
    srcs.push({ u: "https://icons.duckduckgo.com/ip3/" + h + ".ico", via: "img" });
    srcs.push({ u: "https://www.google.com/s2/favicons?sz=64&domain=" + h, via: "img" });
  }
  /* 预览源：Chromium 本地缓存（Firefox 无此能力） */
  const preview = (!IS_FIREFOX && /^https?:/i.test(it.url || ""))
    ? "chrome://favicon/size/64@1x/" + it.url : "";
  return { srcs, preview };
}

/* fetch 图像 blob，AbortController 限时，连接挂起到点即放弃 */
function fetchBlob(u, ms) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), ms);
  return fetch(u, { referrerPolicy: "no-referrer", credentials: "omit", cache: "no-cache", signal: ctrl.signal })
    .then(r => r.ok ? r.blob() : null)
    .catch(() => null)
    .then(b => { clearTimeout(tm); return b; });
}

/* 像素级验证：blob 由自身 fetch 取得，canvas 不 taint，可合法读像素。
 * 通过返回 objectURL；不通过（透明 / 纯灰默认图 / 太小）返回 null */
async function validIconURL(blob) {
  if (!blob || blob.size < 64 || !/^image\//.test(blob.type || "")) return null;
  let bmp = null;
  try { bmp = await createImageBitmap(blob); } catch (e) { return null; }
  const w = bmp.width, h = bmp.height;
  if (w < 8 || h < 8) { try { bmp.close(); } catch (e) {} return null; }
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  let data;
  try {
    ctx.drawImage(bmp, 0, 0);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (e) { try { bmp.close(); } catch (e2) {} return null; }
  let opaque = 0, colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 30) {
      opaque++;
      if (Math.max(data[i], data[i+1], data[i+2]) - Math.min(data[i], data[i+1], data[i+2]) > 25) colored++;
    }
  }
  try { bmp.close(); } catch (e) {}
  const total = w * h;
  if (opaque / total < 0.2 || colored / total < 0.04) return null;
  return URL.createObjectURL(blob);
}

/* img 直载兜底：成功且尺寸 ≥8 才采用，超时 / 失败返回 null */
function loadImgURL(u, ms) {
  return new Promise(res => {
    const img = new Image();
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(tm); res(v); } };
    const tm = setTimeout(() => finish(null), ms);
    try { img.referrerPolicy = "no-referrer"; } catch (e) {}
    img.onload = () => finish(img.naturalWidth >= 8 ? u : null);
    img.onerror = () => finish(null);
    img.src = u;
  });
}

function buildIcon(it, size) {
  const box = document.createElement("div"); box.className = "ico";
  /* 先放首字母：加载全过程都不会出现空块 */
  const letter = document.createElement("span");
  letter.textContent = (it.name || "?").charAt(0).toUpperCase();
  box.appendChild(letter);
  const paint = url => {
    box.textContent = "";
    const img = document.createElement("img"); img.alt = ""; img.src = url;
    box.appendChild(img);
  };
  const { srcs, preview } = faviconSources(it);
  let settled = false;
  /* 预览层：本地缓存命中时秒回，先显示；尺寸 <16 的透明假图直接忽略 */
  if (preview) {
    const p = new Image();
    p.onload = () => { if (!settled && p.naturalWidth >= 16) paint(preview); };
    p.onerror = () => {};
    p.src = preview;
  }
  /* 权威层：逐源 fetch + 像素验证，通过才 settle */
  (async () => {
    for (const s of srcs) {
      if (settled) break;
      let url = null;
      if (s.via === "fetch") {
        const blob = await fetchBlob(s.u, 6000);
        if (blob) url = await validIconURL(blob);
      } else {
        url = await loadImgURL(s.u, 6000);
      }
      if (url && !settled) { settled = true; paint(url); return; }
    }
    /* 权威链全失败：若预览曾“假成功”盖住 letter（可能是纯灰默认图），
       统一回退首字母，保证绝不留下灰块 */
    if (!settled && box.querySelector("img")) {
      box.textContent = ""; box.appendChild(letter);
    }
  })();
  return box;
}

/* ---------- 卡片 ---------- */
function buildCard(it, inFav) {
  const a = document.createElement("a");
  a.className = "bcard"; a.dataset.id = it.id;
  if (state.locatingId === it.id) { a.classList.add("locate-flash"); setTimeout(() => { a.classList.remove("locate-flash"); }, 2600); }
  const safe = isSafeUrl(it.url);
  if (safe) { a.href = it.url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
  a.appendChild(buildIcon(it));
  const meta = document.createElement("div"); meta.className = "meta";
  const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = it.name; meta.appendChild(nm);
  if (it.desc) { const ds = document.createElement("div"); ds.className = "ds"; ds.textContent = it.desc; meta.appendChild(ds); }
  else if (hostOf(it.url)) { const ds = document.createElement("div"); ds.className = "ds"; ds.textContent = hostOf(it.url); meta.appendChild(ds); }
  a.appendChild(meta);
  if (it.pin) { const p = document.createElement("span"); p.className = "pinmark"; p.textContent = "📌"; a.appendChild(p); }
  if (isJsUrl(it.url)) { const t = document.createElement("span"); t.className = "script-tag"; t.textContent = "脚本"; a.title = "这是 JavaScript 脚本书签，点击复制代码"; a.appendChild(t); }

  const ops = document.createElement("div"); ops.className = "ops";
  const bEdit = document.createElement("button"); bEdit.dataset.tip = "编辑"; bEdit.textContent = "✏️";
  bEdit.onclick = e => { e.preventDefault(); e.stopPropagation(); openBmModal(it.id); };
  const bPin = document.createElement("button"); bPin.dataset.tip = it.pin ? "取消置顶" : "置顶";
  bPin.textContent = it.pin ? "📌" : "⭐";
  bPin.onclick = e => { e.preventDefault(); e.stopPropagation(); it.pin = it.pin ? 0 : 1; persist(); render(); toast(it.pin ? "已置顶" : "已取消置顶"); };
  ops.appendChild(bPin);
  if (inFav) {
    const bX = document.createElement("button"); bX.className = "danger"; bX.dataset.tip = "从常用移除（只清零计数，不删除书签；下次点击会重新进入常用）"; bX.textContent = "✕";
    bX.onclick = e => {
      e.preventDefault(); e.stopPropagation();
      it.pin = 0; it.usage = 0;
      persist(); render(); toast("已从常用移除，书签保留；下次点击会重新计入", "ok");
    };
    ops.appendChild(bX);
  }
  ops.appendChild(bEdit);
  a.appendChild(ops);
  a.addEventListener("contextmenu", e => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { act: "open", label: "↗ 新标签页打开" },
      { act: "copy", label: "🔗 复制链接" },
      { sep: true },
      { act: "edit", label: "✏️ 编辑书签" }
    ], { it: it });
  });

  a.addEventListener("click", e => {
    /* about: 特权页（about:debugging 等）：浏览器禁止扩展打开，复制地址引导粘贴 */
    if (isAboutUrl(it.url)) { e.preventDefault(); copyUrlWithTip(it.url, "浏览器禁止插件直接打开 about: 页面：地址已复制，粘贴到地址栏即可访问"); return; }
    if (!isSafeUrl(it.url) && !isJsUrl(it.url)) { e.preventDefault(); toast("该网址协议不支持直接打开，请点击编辑修改", "warn"); return; }
    if (isJsUrl(it.url)) { e.preventDefault(); navigator.clipboard && navigator.clipboard.writeText(it.url).then(() => toast("脚本书签已复制，可粘贴到浏览器地址栏使用", "ok"), () => toast("复制失败", "bad")); return; }
    if (isFileUrl(it.url)) {
      /* file:// 不能交给 <a target="_blank"> 自己跳：Chrome 118 起没有文件访问权限时
         浏览器会静默拦掉，用户只会看到"点了没反应"。改成自己判断 + 明确提示。 */
      e.preventDefault();
      it.usage = (it.usage || 0) + 1; persist();
      openFileUrl(it.url);
      return;
    }
    it.usage = (it.usage || 0) + 1; persist();
  });

  if (pref.manage && safe) {
    a.draggable = true;
    const dh = document.createElement("span"); dh.className = "drag-handle"; dh.dataset.tip = "拖动排序 / 拖到分类标签可移入该文件夹"; dh.textContent = "⋮⋮"; a.appendChild(dh);
    a.addEventListener("dragstart", e => { dragItem = it; a.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", it.id); } catch (ex) {} });
    a.addEventListener("dragend", () => { dragItem = null; a.classList.remove("dragging"); $$(".bcard").forEach(x => x.classList.remove("dragover")); });
    a.addEventListener("dragover", e => { e.preventDefault(); if (dragItem && dragItem !== it) a.classList.add("dragover"); });
    a.addEventListener("dragleave", () => a.classList.remove("dragover"));
    a.addEventListener("drop", e => {
      e.preventDefault(); a.classList.remove("dragover");
      if (!dragItem || dragItem === it) return;
      if (dragItem.folderId === it.folderId) { moveItemBefore(dragItem, it, e.clientX, a); return; }
      /* 跨文件夹移动：插入到目标书签前/后 */
      const rect = a.getBoundingClientRect();
      const after = e.clientX - rect.left > rect.width / 2;
      const moved = dragItem; dragItem = null;
      const items = DB.items;
      items.splice(items.indexOf(moved), 1);
      moved.folderId = it.folderId;
      items.splice(items.indexOf(it) + (after ? 1 : 0), 0, moved);
      persist(); render();
      const fname = it.folderId === ROOT ? "工具栏" : (folderById(it.folderId) || {}).name;
      toast("已移动到「" + fname + "」", "ok");
    });
  }
  return a;
}
function moveItemBefore(drag, target, clientX, el) {
  const rect = el.getBoundingClientRect();
  const after = clientX - rect.left > rect.width / 2;
  const items = DB.items;
  const di = items.indexOf(drag);
  items.splice(di, 1);
  const ni = items.indexOf(target);
  items.splice(ni + (after ? 1 : 0), 0, drag);
  persist(); render();
}

/* ---------- 渲染 ---------- */
function render() {
  renderStat(); renderNav(); renderMain();
  /* 文件夹增删、密度/主题切换后行高会变，重新夹一次高度，避免留下空白或裁切 */
  if (typeof refreshNavHeight === "function") refreshNavHeight();
}
function renderStat() {
  const pin = DB.items.filter(i => i.pin).length;
  let mode = "";
  if (IS_MOCK) mode = " · 模拟扩展模式（测试）";
  else if (IS_EXT_MODE) mode = useStandalone() ? " · 独立模式（扩展本地存储）" : " · 已连接浏览器书签（实时同步）";
  $("#statLine").textContent = DB.items.length + " 书签 · " + DB.folders.length + " 文件夹 · 置顶 " + pin + mode;
}
function renderNav() {
  const nav = $("#navBar"); nav.innerHTML = "";
  /* 管理模式下：拖书签到分类标签 = 移入该文件夹 */
  function addChipDrop(btn, f) {
    btn.addEventListener("dragover", e => { if (pref.manage && dragItem && dragItem.folderId !== f.id) { e.preventDefault(); btn.classList.add("dragover-folder"); } });
    btn.addEventListener("dragleave", () => btn.classList.remove("dragover-folder"));
    btn.addEventListener("drop", e => {
      e.preventDefault(); btn.classList.remove("dragover-folder");
      if (!pref.manage || !dragItem || dragItem.folderId === f.id) return;
      const moved = dragItem; dragItem = null;
      moved.folderId = f.id;
      persist(); render();
      toast("已移动到「" + f.name + "」", "ok");
    });
  }
  const mk = (label, val, cnt, cls, fid) => {
    const b = document.createElement("button");
    const active = (val === "folder") ? (state.view === "folder" && state.folder === fid) : (state.view === val);
    b.className = "chip" + (active ? " active" : "") + (cls ? " " + cls : "");
    b.dataset.val = val;
    b.innerHTML = label + (cnt != null ? ' <span class="cnt">' + cnt + "</span>" : "");
    b.onclick = () => {
      if (val === "home") { state = { ...state, view: "home", folder: null }; }
      else if (val === "folder") { state = { ...state, view: "folder", folder: b.dataset.fid }; }
      else { state = { ...state, view: val, folder: null }; }
      render(); window.scrollTo({ top: 0, behavior: "smooth" });
    };
    return b;
  };
  /* 文件夹 chip 工厂：单击进入 / 双击编辑 / 右键菜单 / 拖入移动 */
  function folderChip(f) {
    const b = mk(esc(folderEmoji(f)) + " " + esc(f.name), "folder", folderTreeCount(f.id), null, f.id);
    b.dataset.fid = f.id;
    b.dataset.tip = folderPath(f.id).map(x => x.name).join(" / ") || "顶层";
    b.ondblclick = e => { e.preventDefault(); openFdModal(f.id, null); };
    b.addEventListener("contextmenu", e => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { act: "fdEdit", label: "✏️ 编辑文件夹" },
        { act: "fdNewChild", label: "📁 新建子文件夹" },
        { sep: true },
        { act: "fdDelete", label: "🗑 删除文件夹" }
      ], { f: f });
    });
    addChipDrop(b, f);
    return b;
  }
  /* 按层级深度分组：一级入第一行，二级第二行，以此类推 */
  const byDepth = {};
  let maxDepth = 1;
  DB.folders.forEach(f => {
    if (f.parentId !== ROOT && !folderById(f.parentId)) return; // 孤儿文件夹跳过
    const d = f.parentId === ROOT ? 1 : Math.max(1, folderPath(f.id).length);
    (byDepth[d] = byDepth[d] || []).push(f);
    if (d > maxDepth) maxDepth = d;
  });
  /* 第一行：功能入口 + 全部一级文件夹 */
  const row1 = document.createElement("div"); row1.className = "nav-row";
  row1.appendChild(mk("🏠 " + t("home"), "home"));
  const favN = DB.items.filter(i => i.pin || i.usage).length;
  row1.appendChild(mk("⭐ " + t("frequent"), "favorites", favN));
  const toolbarN = folderItems(ROOT).length;
  if (toolbarN) { const tb = mk("📌 " + t("bookmarkToolbar"), "toolbar", toolbarN); addChipDrop(tb, { id: ROOT, name: t("bookmarkToolbar") }); row1.appendChild(tb); }
  (byDepth[1] || []).forEach(f => row1.appendChild(folderChip(f)));
  const dupN = dupGroups().length;
  row1.appendChild(mk("🧹 " + t("dedup"), "duplicates", dupN || null, dupN ? "warn" : ""));
  const addF = document.createElement("button");
  addF.className = "chip"; addF.dataset.tip = t("addFolder"); addF.textContent = t("addFolderBtn");
  addF.onclick = () => openFdModal(null, ROOT);
  row1.appendChild(addF);
  nav.appendChild(row1);
  /* 第 2..N 行：每层文件夹一行，一眼看全 */
  for (let d = 2; d <= maxDepth; d++) {
    const list = byDepth[d] || [];
    if (!list.length) continue;
    const row = document.createElement("div"); row.className = "nav-row nav-sub";
    list.forEach(f => row.appendChild(folderChip(f)));
    nav.appendChild(row);
  }
}

/* ---------- 分类栏高度：手动收缩 / 逐行展开 ---------- */
const NAV_PAD = 18;                    // nav 上下 padding 合计
let navFull = 0, navMin = 0;           // 实测：全部展开高度 / 只留首行的收起高度
let navDrag = null;
const NAV_KEY_STEP = 28, NAV_KEY_STEP_BIG = 90;

function measureNav() {
  const nav = $("#navBar");
  if (!nav) return;
  const prev = nav.style.maxHeight;
  nav.style.maxHeight = "none";
  /* 用 offsetHeight 而不是 scrollHeight：flex 滚动容器在部分浏览器里 scrollHeight 会漏掉下内边距 */
  navFull = Math.ceil(nav.getBoundingClientRect().height);
  const first = nav.querySelector(".nav-row");
  const gap = parseFloat(getComputedStyle(nav).rowGap) || 0;
  const oneRow = first
    ? Math.ceil(first.getBoundingClientRect().bottom - nav.getBoundingClientRect().top + gap + 1)
    : 32 + NAV_PAD;
  /* 首行本身太高时（例如窄屏换行很多），最多只留半屏，保证"缩小"一定有效 */
  navMin = Math.max(34, Math.min(oneRow, Math.round(window.innerHeight * 0.5)));
  nav.style.maxHeight = prev;
}
/* 设置分类栏高度（px），自动夹在「只留首行」与「全部展开」之间 */
function setNavHeight(h, opts) {
  const nav = $("#navBar");
  if (!nav) return;
  if (!navFull) measureNav();
  const max = Math.max(navMin, navFull);
  const v = Math.round(Math.min(Math.max(h, navMin), max));
  const foldedChanged = (v <= navMin + 2) !== !!pref.navFold;
  pref.navH = v;
  pref.navFold = v <= navMin + 2;
  nav.style.setProperty("--nav-h", v + "px");
  if (foldedChanged) syncNavUI();
  scrollActiveChipIntoView();
  if (!opts || opts.save !== false) savePrefs();
}
function syncNavUI() {
  const nav = $("#navBar"), btn = $("#navFold"), txt = $("#navFoldTxt");
  if (!nav || !btn) return;
  const folded = !!pref.navFold;
  btn.textContent = folded ? "▴ 展开" : "▾ 收起";
  btn.setAttribute("aria-expanded", folded ? "false" : "true");
  btn.setAttribute("aria-label", folded ? "展开全部分类" : "收起分类栏");
  btn.title = folded ? "展开全部分类" : "收起分类栏（只保留首行）";
  if (txt) txt.textContent = folded ? "已收起 · 点右侧展开全部" : "拖动此条可逐行收起 / 展开";
}
/* 高度变化后，保证当前选中的分类标签仍在可见区域内（已收起到只剩首行时回到顶部） */
function scrollActiveChipIntoView() {
  const nav = $("#navBar");
  if (!nav) return;
  if (pref.navFold) { nav.scrollTop = 0; return; }
  const act = nav.querySelector(".chip.active");
  if (!act) return;
  const nr = nav.getBoundingClientRect(), ar = act.getBoundingClientRect();
  if (ar.top < nr.top) nav.scrollTop -= (nr.top - ar.top) + 6;
  else if (ar.bottom > nr.bottom) nav.scrollTop += (ar.bottom - nr.bottom) + 6;
}
function toggleNavFold() {
  /* 不要提前改 pref.navFold：setNavHeight 需要靠新旧状态对比来触发按钮文案刷新 */
  setNavHeight(pref.navFold ? navFull : navMin);
}
/* 重新测量并夹回当前偏好高度：供 render / 窗口尺寸 / 密度主题变化后自愈使用 */
function refreshNavHeight() {
  if (!navFull) return;                       // initNavGrip 还没测量过就先不管
  measureNav();
  setNavHeight(pref.navFold ? navMin : (Number(pref.navH) || navFull), { save: false });
}
function initNavGrip() {
  const nav = $("#navBar"), grip = $("#navGrip"), btn = $("#navFold");
  if (!nav || !grip || !btn) return;
  measureNav();
  const want = pref.navFold ? navMin : (Number(pref.navH) || navFull);
  setNavHeight(want, { save: false });
  syncNavUI();
  btn.addEventListener("click", e => { e.stopPropagation(); toggleNavFold(); });
  grip.addEventListener("dblclick", e => {
    if (e.target.closest && e.target.closest(".nav-fold")) return;   // 双击按钮不当作恢复全部
    setNavHeight(navFull); toast("分类栏已恢复全部展开", "ok");
  });
  /* 指针事件统一处理鼠标 / 触摸 / 触控笔；指针捕获保证拖出把手后仍能继续拖 */
  grip.addEventListener("pointerdown", e => {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest && e.target.closest(".nav-fold")) return;  // 点按钮不启动拖拽
    navDrag = { y: e.clientY, h: nav.getBoundingClientRect().height, pid: e.pointerId };
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    document.body.classList.add("nav-resizing");
    e.preventDefault();
  });
  grip.addEventListener("pointermove", e => {
    if (!navDrag || e.pointerId !== navDrag.pid) return;
    setNavHeight(navDrag.h + (e.clientY - navDrag.y), { save: false });
  });
  const endDrag = e => {
    if (!navDrag || (e && e.pointerId !== navDrag.pid)) return;
    try { grip.releasePointerCapture(navDrag.pid); } catch (_) {}
    navDrag = null;
    document.body.classList.remove("nav-resizing");
    savePrefs();
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  /* 键盘可达：↑↓ 微调（Shift 加速），Home 收起，End 展开全部 */
  grip.addEventListener("keydown", e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = Number(pref.navH) || nav.getBoundingClientRect().height;
    const step = e.shiftKey ? NAV_KEY_STEP_BIG : NAV_KEY_STEP;
    if (e.key === "ArrowDown") setNavHeight(cur + step);
    else if (e.key === "ArrowUp") setNavHeight(cur - step);
    else if (e.key === "Home") setNavHeight(navMin);
    else if (e.key === "End") setNavHeight(navFull);
    else return;
    e.preventDefault();
  });
}
let navRzTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(navRzTimer);
  navRzTimer = setTimeout(refreshNavHeight, 160);
});

function sectionHead(emoji, name, count, curId, openable) {
  const head = document.createElement("div"); head.className = "sec-head";
  const h2 = document.createElement("h2");
  h2.innerHTML = '<span class="ic">' + emoji + "</span> " + esc(name) + ' <span class="cnt">' + count + "</span>";
  if (curId && curId !== ROOT) h2.dataset.tip = "双击编辑文件夹";
  h2.ondblclick = () => { if (curId && curId !== ROOT) openFdModal(curId, null); };
  head.appendChild(h2);
  const ops = document.createElement("div"); ops.className = "to";
  if (openable && curId && curId !== ROOT) {
    const b = document.createElement("button"); b.className = "mini"; b.textContent = t("enter");
    b.onclick = () => { state.view = "folder"; state.folder = curId; render(); window.scrollTo({ top: 0 }); };
    ops.appendChild(b);
  }
  if (curId && curId !== ROOT) {
    const b = document.createElement("button"); b.className = "mini"; b.textContent = t("configManage");
    b.onclick = () => openFdModal(curId, null);
    ops.appendChild(b);
  }
  const bNew = document.createElement("button"); bNew.className = "mini"; bNew.textContent = t("addBookmarkBtn");
  bNew.onclick = () => openBmModal(null, curId || ROOT);
  ops.appendChild(bNew);
  if (curId && curId !== ROOT) {
    const bSub = document.createElement("button"); bSub.className = "mini"; bSub.textContent = t("addSubfolder");
    bSub.onclick = () => openFdModal(null, curId);
    ops.appendChild(bSub);
  }
  head.appendChild(ops);
  return head;
}
function subChipsBar(fid) {
  const subs = childFolders(fid);
  if (!subs.length) return null;
  const bar = document.createElement("div"); bar.className = "subchips";
  subs.forEach(f => {
    const b = document.createElement("button"); b.className = "chip";
    b.innerHTML = esc(folderEmoji(f)) + " " + esc(f.name) + ' <span class="cnt">' + folderTreeCount(f.id) + "</span>";
    b.dataset.tip = "单击进入 · 双击编辑 · 管理模式下可拖书签入内";
    b.onclick = () => { state.view = "folder"; state.folder = f.id; render(); window.scrollTo({ top: 0 }); };
    b.ondblclick = e => { e.preventDefault(); openFdModal(f.id, null); };
    b.addEventListener("contextmenu", e => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { act: "fdEdit", label: "✏️ 编辑文件夹" },
        { act: "fdNewChild", label: "📁 新建子文件夹" },
        { sep: true },
        { act: "fdDelete", label: "🗑 删除文件夹" }
      ], { f: f });
    });
    b.addEventListener("dragover", e => { if (pref.manage && dragItem && dragItem.folderId !== f.id) { e.preventDefault(); b.classList.add("dragover-folder"); } });
    b.addEventListener("dragleave", () => b.classList.remove("dragover-folder"));
    b.addEventListener("drop", e => {
      e.preventDefault(); b.classList.remove("dragover-folder");
      if (!pref.manage || !dragItem || dragItem.folderId === f.id) return;
      const moved = dragItem; dragItem = null;
      moved.folderId = f.id;
      persist(); render();
      toast("已移动到「" + f.name + "」", "ok");
    });
    bar.appendChild(b);
  });
  return bar;
}
function gridOf(items, inFav) {
  const g = document.createElement("div"); g.className = "grid";
  items.forEach(it => g.appendChild(buildCard(it, inFav)));
  return g;
}
function emptyBox(txt) { const d = document.createElement("div"); d.className = "empty"; d.textContent = txt; return d; }

function renderMain() {
  const m = $("#main"); m.innerHTML = "";
  if (state.view === "home") renderHome(m);
  else if (state.view === "folder") renderFolder(m, state.folder);
  else if (state.view === "toolbar") renderFolder(m, ROOT, "📌 工具栏");
  else if (state.view === "favorites") renderFav(m);
  else if (state.view === "duplicates") renderDups(m);
}
function renderHome(m) {
  const pinned = DB.items.filter(i => i.pin).sort((a, b) => (b.pin || 0) - (a.pin || 0));
  const used = DB.items.filter(i => !i.pin && i.usage).sort((a, b) => (b.usage || 0) - (a.usage || 0)).slice(0, 24);
  if (pinned.length || used.length) {
    const sec = document.createElement("section"); sec.className = "cat";
    sec.appendChild(sectionHead("⭐", t("frequentTop") + " " + t("hoverRemove"), pinned.length + used.length, null, false));
    sec.appendChild(gridOf(pinned.concat(used), true));
    m.appendChild(sec);
  }
  const tItems = folderItems(ROOT);
  if (tItems.length) {
    const sec = document.createElement("section"); sec.className = "cat";
    sec.appendChild(sectionHead("📌", t("toolbarBookmarks"), tItems.length, ROOT, false));
    sec.appendChild(gridOf(tItems));
    m.appendChild(sec);
  }
  childFolders(ROOT).forEach(f => {
    const total = folderTreeCount(f.id);
    if (!total) return;
    const sec = document.createElement("section"); sec.className = "cat";
    sec.appendChild(sectionHead(esc(folderEmoji(f)), f.name, total, f.id, true));
    const subs = subChipsBar(f.id); if (subs) sec.appendChild(subs);
    const all = folderItems(f.id);
    const showAll = expandedSec.has(f.id);
    const list = showAll ? all : all.slice(0, 12);
    if (list.length) sec.appendChild(gridOf(list));
    if (all.length > 12) {
      const more = document.createElement("div"); more.className = "showmore";
      more.textContent = showAll ? t("collapse") + "（" + all.length + " " + t("totalItems") + "）" : t("showAll") + " " + all.length + " " + t("totalItems");
      more.onclick = () => { showAll ? expandedSec.delete(f.id) : expandedSec.add(f.id); render(); };
      sec.appendChild(more);
    }
    m.appendChild(sec);
  });
  if (!m.children.length) m.appendChild(emptyBox(t("emptyBookmarks")));
}
function renderFolder(m, fid, titleOverride) {
  const f = folderById(fid); if (!f) { state.view = "home"; return render(); }
  const crumb = document.createElement("div"); crumb.className = "crumb";
  const home = document.createElement("a"); home.textContent = "🏠 " + t("home"); home.onclick = () => { state.view = "home"; state.folder = null; render(); };
  crumb.appendChild(home);
  const path = folderPath(fid);
  path.forEach((p, idx) => {
    const sep = document.createElement("span"); sep.className = "sep"; sep.textContent = "›"; crumb.appendChild(sep);
    if (idx === path.length - 1) { const s = document.createElement("span"); s.className = "cur"; s.textContent = folderEmoji(p) + " " + p.name; crumb.appendChild(s); }
    else { const a = document.createElement("a"); a.textContent = p.name; a.onclick = () => { state.folder = p.id; render(); }; crumb.appendChild(a); }
  });
  m.appendChild(crumb);
  const items = folderItems(fid);
  const sec = document.createElement("section"); sec.className = "cat";
  sec.appendChild(sectionHead(esc(folderEmoji(f)), titleOverride || f.name, items.length, fid, false));
  const subs = subChipsBar(fid); if (subs) sec.appendChild(subs);
  if (items.length) sec.appendChild(gridOf(items));
  else sec.appendChild(emptyBox(t("emptyFolder")));
  m.appendChild(sec);
}
function renderFav(m) {
  const pinned = DB.items.filter(i => i.pin).sort((a, b) => (b.pin || 0) - (a.pin || 0));
  const used = DB.items.filter(i => !i.pin && i.usage).sort((a, b) => (b.usage || 0) - (a.usage || 0));
  if (pinned.length) {
    const sec = document.createElement("section"); sec.className = "cat";
    sec.appendChild(sectionHead("📌", "置顶书签（hover 可 ✕ 移除，不删书签）", pinned.length, null, false));
    sec.appendChild(gridOf(pinned, true)); m.appendChild(sec);
  }
  if (used.length) {
    const sec = document.createElement("section"); sec.className = "cat";
    sec.appendChild(sectionHead("📈", "使用排行（点击自动计数，hover 可 ✕ 移除）", used.length, null, false));
    sec.appendChild(gridOf(used, true)); m.appendChild(sec);
  }
  if (!pinned.length && !used.length) m.appendChild(emptyBox("暂无常用书签：置顶（卡片上的 ⭐）或点击书签后，会自动出现在这里"));
}
function normUrl(u) {
  try { const x = new URL(u); return (x.hostname + x.pathname).toLowerCase().replace(/\/+$/, ""); } catch (e) { return String(u || "").toLowerCase(); }
}
function dupGroups() {
  const map = new Map();
  DB.items.forEach(it => { const k = normUrl(it.url); if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(it); });
  return Array.from(map.values()).filter(g => g.length > 1);
}
function renderDups(m) {
  const groups = dupGroups();
  const sec = document.createElement("section"); sec.className = "cat";
  const head = document.createElement("div"); head.className = "sec-head";
  head.innerHTML = "<h2>🧹 重复书签 <span class='cnt'>" + groups.length + " 组</span></h2>";
  const ops = document.createElement("div"); ops.className = "to";
  if (groups.length) {
    const b = document.createElement("button"); b.className = "mini"; b.textContent = "⚡ 每组保留第一条，清掉其余";
    b.onclick = () => {
      if (!confirm("将删除 " + (groups.reduce((s, g) => s + g.length - 1, 0)) + " 个重复书签（每组保留第一个）。继续？")) return;
      const del = new Set(groups.flatMap(g => g.slice(1)).map(i => i.id));
      DB.items = DB.items.filter(i => !del.has(i.id));
      persist(); render(); toast("清理完成", "ok");
    };
    ops.appendChild(b);
  }
  head.appendChild(ops); sec.appendChild(head);
  if (!groups.length) { sec.appendChild(emptyBox("没有发现重复书签 👍")); m.appendChild(sec); return; }
  groups.forEach(g => {
    const gd = document.createElement("div"); gd.className = "dupgroup";
    const gh = document.createElement("div"); gh.className = "gh";
    gh.innerHTML = '<span class="n">' + g.length + " 个重复</span> " + '<span class="url-full">' + esc(g[0].url) + "</span>";
    gd.appendChild(gh);
    g.forEach((it, idx) => {
      const r = document.createElement("div"); r.className = "gr";
      r.appendChild(buildIcon(it));
      const nmcol = document.createElement("div"); nmcol.className = "nmcol";
      const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = (idx === 0 ? "✅ " : "• ") + it.name; nmcol.appendChild(nm);
      const uf = document.createElement("span"); uf.className = "url-full"; uf.textContent = it.url; nmcol.appendChild(uf);
      r.appendChild(nmcol);
      const pt = document.createElement("span"); pt.className = "pt";
      pt.title = folderPath(it.folderId).map(f => f.name).join(" / ") || "工具栏";
      pt.textContent = folderPath(it.folderId).map(f => f.name).join(" / ") || "工具栏"; r.appendChild(pt);
      const b = document.createElement("button"); b.textContent = "编辑";
      b.onclick = () => openBmModal(it.id); r.appendChild(b);
      const bd = document.createElement("button"); bd.textContent = "删除";
      bd.onclick = () => { if (confirm('删除书签「' + it.name + '」？')) { DB.items = DB.items.filter(x => x.id !== it.id); persist(); render(); } };
      r.appendChild(bd);
      gd.appendChild(r);
    });
    sec.appendChild(gd);
  });
  m.appendChild(sec);
}

/* ---------- 书签模态 ---------- */
let editingBm = null;
let bmPicker = null, fdPicker = null;
/* Firefox 式文件夹树形选择器：点击行 = 选中并展开/收起子级 */
function initFolderPicker(rootId, selectedId, excludeId, disabled) {
  const root = $("#" + rootId);
  const lab = root.querySelector(".fp-lab");
  const tree = root.querySelector(".fp-tree");
  let selId = selectedId || ROOT;
  const expanded = new Set();
  folderPath(selId).forEach(f => expanded.add(f.id));
  function labelOf(fid) {
    if (fid === ROOT || !folderById(fid)) return "📌 顶层（书签工具栏）";
    const f = folderById(fid);
    const path = folderPath(fid).map(x => x.name).join(" / ");
    return folderEmoji(f) + " " + f.name + "（" + path + "）";
  }
  function updateShow() { lab.textContent = labelOf(selId); }
  function renderTree() {
    tree.innerHTML = "";
    const mkRow = (f, depth) => {
      const kids = childFolders(f.id).filter(c => c.id !== excludeId);
      const row = document.createElement("div");
      row.className = "fp-row" + (f.id === selId ? " sel" : "");
      row.style.paddingLeft = (9 + depth * 16) + "px";
      const a2 = document.createElement("span"); a2.className = "fp-a2";
      a2.textContent = kids.length ? (expanded.has(f.id) ? "▾" : "▸") : "·";
      const nm = document.createElement("span"); nm.className = "fp-nm"; nm.textContent = folderEmoji(f) + " " + f.name;
      row.appendChild(a2); row.appendChild(nm);
      row.onclick = () => {
        selId = f.id; updateShow();
        if (kids.length) expanded.has(f.id) ? expanded.delete(f.id) : expanded.add(f.id);
        renderTree();
      };
      tree.appendChild(row);
      if (expanded.has(f.id)) kids.forEach(k => mkRow(k, depth + 1));
    };
    const rootRow = document.createElement("div");
    rootRow.className = "fp-row" + (selId === ROOT ? " sel" : "");
    rootRow.innerHTML = '<span class="fp-a2">▾</span><span class="fp-nm">📌 顶层（新建默认入' + (IS_SYNC_MODE ? "书签工具栏" : "工具栏") + '）</span>';
    rootRow.onclick = () => { selId = ROOT; updateShow(); renderTree(); };
    tree.appendChild(rootRow);
    childFolders(ROOT).forEach(f => { if (f.id !== excludeId) mkRow(f, 0); });
  }
  const show = root.querySelector(".fp-show");
  root.classList.remove("open");
  show.style.cursor = disabled ? "not-allowed" : "pointer";
  show.onclick = () => { if (disabled) { toast("编辑文件夹时不能修改父级（防止循环嵌套）", "warn"); return; } root.classList.toggle("open"); if (root.classList.contains("open")) renderTree(); };
  updateShow();
  return { get: () => selId, close: () => root.classList.remove("open") };
}
document.addEventListener("click", e => { if (!e.target.closest || !e.target.closest(".fpicker")) $$(".fpicker").forEach(p => p.classList.remove("open")); });
function openBmModal(id, presetFolder) {
  editingBm = id ? DB.items.find(i => i.id === id) : null;
  $("#bmTitle").textContent = editingBm ? "编辑书签" : "添加书签";
  $("#bmName").value = editingBm ? editingBm.name : "";
  $("#bmUrl").value = editingBm ? editingBm.url : "";
  $("#bmDesc").value = editingBm && editingBm.desc ? editingBm.desc : "";
  $("#bmIcon").value = editingBm && editingBm.icon ? editingBm.icon : "";
  $("#bmUrlErr").style.display = "none";
  const targetFolder = editingBm ? editingBm.folderId : (presetFolder || (state.view === "folder" ? state.folder : ROOT) || ROOT);
  bmPicker = initFolderPicker("bmFolderPicker", targetFolder, null, false);
  $("#bmDelete").style.display = editingBm ? "" : "none";
  $("#bmDelete").textContent = editingBm ? "🗑 删除" : "";
  showMask("#bmMask");
  setTimeout(() => $("#bmName").focus(), 60);
}
$("#bmSave").onclick = () => {
  const name = $("#bmName").value.trim(), url = $("#bmUrl").value.trim();
  if (!name) { toast("请填写名称", "warn"); return; }
  if (!url) { toast("请填写网址", "warn"); return; }
  if (!isSafeUrl(url) && !isJsUrl(url)) { $("#bmUrlErr").style.display = "block"; return; }
  const folderId = bmPicker ? bmPicker.get() : ROOT;
  const saveFolderId = (IS_SYNC_MODE && folderId === ROOT) ? DEFAULT_ROOT : folderId;
  if (!folderById(saveFolderId)) { toast("目标文件夹不存在", "bad"); return; }
  if (editingBm) {
    Object.assign(editingBm, { name, url, desc: $("#bmDesc").value.trim() || undefined, icon: $("#bmIcon").value.trim() || undefined, folderId: saveFolderId });
  } else {
    const it = { id: uid("b"), folderId: saveFolderId, name, url, added: Math.floor(Date.now() / 1000) };
    if ($("#bmDesc").value.trim()) it.desc = $("#bmDesc").value.trim();
    if ($("#bmIcon").value.trim()) it.icon = $("#bmIcon").value.trim();
    DB.items.push(it);
  }
  persist(); hideMask(); render(); toast(editingBm ? "已保存" : "已添加", "ok");
};
$("#bmDelete").onclick = () => {
  if (!editingBm) return;
  if (!confirm('删除书签「' + editingBm.name + '」？此操作不可撤销。')) return;
  DB.items = DB.items.filter(i => i.id !== editingBm.id);
  persist(); hideMask(); render(); toast("已删除", "ok");
};

/* ---------- 文件夹模态 ---------- */
const EMOJI_POOL = ["📁","🔎","🛡️","🤖","📚","🌿","🔧","💼","📦","💾","🌐","🛰️","🛒","🎬","🎵","📰","🗂️","💡","🔥","⭐","🎯","🧰","🚀","🎮","🏦","🏥","🧪","✈️","🏠","📎"];
let editingFd = null;
(function initEmojiPicker() {
  const box = $("#fdEmojis");
  EMOJI_POOL.forEach(e => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = e; b.style.cssText = "font-size:18px;background:transparent;border:1px solid var(--border);border-radius:8px;width:34px;height:34px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;margin:0 6px 6px 0";
    b.onclick = () => { $("#fdEmoji").value = e; };
    box.appendChild(b);
  });
})();
function openFdModal(id, parentId) {
  const probe = id ? folderById(id) : null;
  if (probe && probe.sys) { toast("系统文件夹（浏览器内置）不可编辑或删除", "warn"); return; }
  editingFd = id ? folderById(id) : null;
  $("#fdTitle").textContent = editingFd ? "管理文件夹" : "新建文件夹";
  $("#fdName").value = editingFd ? editingFd.name : "";
  $("#fdEmoji").value = editingFd ? (editingFd.emoji || autoEmoji(editingFd.name)) : "📁";
  const targetParent = editingFd ? (editingFd.parentId || ROOT) : (parentId || ROOT);
  fdPicker = initFolderPicker("fdParentPicker", targetParent, editingFd ? editingFd.id : null, !!editingFd);
  $("#fdDelete").style.display = editingFd ? "" : "none";
  showMask("#fdMask");
  setTimeout(() => $("#fdName").focus(), 60);
}
$("#fdSave").onclick = () => {
  const name = $("#fdName").value.trim();
  if (!name) { toast("请填写文件夹名称", "warn"); return; }
  const emoji = $("#fdEmoji").value.trim();
  if (editingFd) {
    editingFd.name = name; editingFd.emoji = emoji;
  } else {
    let parentId = fdPicker ? fdPicker.get() : ROOT;
    if (IS_SYNC_MODE && parentId === ROOT) parentId = DEFAULT_ROOT;
    const f = { id: uid("f"), name, parentId };
    if (emoji) f.emoji = emoji;
    DB.folders.push(f);
  }
  persist(); hideMask(); render(); toast("已保存", "ok");
};
function deleteFolder(f) {
  if (!f) return;
  if (f.sys) { toast("系统文件夹（浏览器内置）不可删除", "warn"); return; }
  const n = folderTreeCount(f.id);
  if (!confirm('删除文件夹「' + f.name + '」？\n其中 ' + n + ' 个书签及子文件夹将上移到其父文件夹，不会被删除。')) return;
  const pid = f.parentId || ROOT;
  DB.folders.filter(x => x.parentId === f.id).forEach(x => { x.parentId = pid; });
  DB.items.filter(i => i.folderId === f.id).forEach(i => { i.folderId = pid; });
  DB.folders = DB.folders.filter(x => x.id !== f.id);
  if (state.view === "folder" && folderPath(state.folder).some(x => x.id === f.id)) { state.view = "home"; state.folder = null; }
  persist(); hideMask(); render(); toast("文件夹已删除，内容已上移", "ok");
}
$("#fdDelete").onclick = () => { if (editingFd) deleteFolder(editingFd); };

/* ---------- 模态通用 ---------- */
function showMask(sel) { $(sel).classList.add("show"); }
function hideMask() { $$(".mask").forEach(x => x.classList.remove("show")); }
document.addEventListener("click", e => {
  if (e.target.classList && e.target.classList.contains("mask")) hideMask();
  if (e.target.closest && e.target.closest("[data-close]")) hideMask();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { hideMask(); $("#suggestBox").classList.remove("show"); }
  /* 搜索快捷键的默认 / 与 Ctrl+K 已由下方「全局快捷键监听」按 pref.hkSearch 处理；
     保留这里只是为了向后兼容旧 pref（hkSearch 字段缺失时也能用 / 聚焦）。 */
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select";
  if (!pref.hkSearch && !typing && (e.key === "/" || (e.ctrlKey && e.key.toLowerCase() === "k"))) { e.preventDefault(); $("#searchInput").focus(); }
});

/* ---------- 顶栏按钮 ---------- */
$("#btnAdd").onclick = () => openBmModal(null, state.view === "folder" ? state.folder : null);
$("#brandHome").onclick = () => { state.view = "home"; state.folder = null; render(); window.scrollTo({ top: 0, behavior: "smooth" }); };
$("#btnManage").onclick = () => {
  pref.manage = !pref.manage; savePrefs();
  applyPrefs();
  render();
  toast(pref.manage ? "管理模式：拖卡片可排序，拖到分类标签可移入其他文件夹" : "已退出管理模式");
};
$("#btnTheme").onclick = () => {
  pref.theme = pref.theme === "dark" ? "light" : "dark"; savePrefs(); applyPrefs();
};
$("#btnDensity").onclick = () => { pref.dense = !pref.dense; savePrefs(); applyPrefs(); };
$("#btnLang").onclick = () => { pref.lang = pref.lang === "zh" ? "en" : "zh"; savePrefs(); applyPrefs(); render(); };
/* 在浏览器新标签页中打开本应用：仅扩展页可用（能拿到 runtime / tabs API） */
function openManagerInTab() {
  const api = (typeof browser !== "undefined" && browser.runtime) ? browser
            : ((typeof chrome !== "undefined" && chrome.runtime) ? chrome : null);
  if (!api || !api.runtime) { toast("当前环境无法打开新标签页", "warn"); return; }
  let url;
  try { url = api.runtime.getURL("manager.html"); } catch (e) { toast("无法获取插件地址", "bad"); return; }
  try {
    if (api.tabs && api.tabs.create) {
      const r = api.tabs.create({ url: url });
      if (r && r.catch) r.catch(() => { if (!window.open(url, "_blank")) toast("浏览器拦截了新窗口，请允许弹出窗口", "warn"); });
      return;
    }
  } catch (e) { /* 落到 window.open 兜底 */ }
  if (!window.open(url, "_blank")) toast("浏览器拦截了新窗口，请允许弹出窗口", "warn");
}
if (IS_EXT_MODE) $("#btnOpenTab").style.display = "";
$("#btnOpenTab").onclick = openManagerInTab;
function applyLang() {
  const L = key => t(key);
  /* 顶栏静态元素 */
  const si = $("#searchInput"); if (si) si.placeholder = L("searchBookmarks") + "…";
  const ei = $("#engineInput"); if (ei) ei.placeholder = L("searchWeb") + "…";
  const ot = $("#btnOpenTab"); if (ot) ot.innerHTML = "⛶ <span>" + L("newTab") + "</span>";
  const ba = $("#btnAdd"); if (ba) ba.innerHTML = "➕ <span>" + L("addBookmark") + "</span>";
  const bm = $("#btnManage"); if (bm) bm.innerHTML = pref.manage ? "🛠 <span>" + L("manage") + "</span>" : "🛠 <span>" + L("manage") + "</span>";
  /* 配置中心标签页 */
  document.querySelectorAll(".modal .etabs .tab").forEach(tab => {
    const dt = tab.dataset.dt;
    if (dt === "import") tab.textContent = L("importBookmarks");
    else if (dt === "export") tab.textContent = L("exportBackup");
    else if (dt === "shortcuts") tab.textContent = L("shortcuts");
    else if (dt === "sync") tab.textContent = L("dataSource");
    else if (dt === "lang") tab.textContent = L("lang");
  });
}
function applyPrefs() {
  document.documentElement.dataset.theme = pref.theme;
  document.body.classList.toggle("dense", !!pref.dense);
  document.body.classList.toggle("manage", !!pref.manage);
  $("#btnTheme").textContent = pref.theme === "dark" ? "🌙" : "☀️";
  const den = $("#btnDensity");
  den.innerHTML = pref.dense ? '▤ <span>' + t("densityOn") + '</span>' : '▥ <span>' + t("density") + '</span>';
  den.classList.toggle("density-on", !!pref.dense);
  den.dataset.tip = pref.dense ? "当前：紧凑模式（点击切回宽松）" : "当前：宽松模式（点击切换紧凑）";
  $("#btnManage").classList.toggle("danger-on", !!pref.manage);
  const langBtn = $("#btnLang");
  if (langBtn) langBtn.textContent = pref.lang === "zh" ? "EN" : "中";
  applyLang();
}

/* ---------- 捐助 ---------- */
/* 作者内置收款码（随扩展分发，所有用户可见）。
 * 这里是 880px 宽的 JPEG base64，离线可用、不依赖任何外链。
 * 仅展示作者收款码，用户不可替换。 */
const DEV_DONATE = {
  wechat: "data:image/jpeg;base64,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0utT4bLZrSV5euwJJiqYCBBUCpJ5dKsHOA5c8Y0AzjCmAOUo/GtLrU+Gy2a0leXrsDIlT1AcoQqFeIQapshYATHqIZaQUmc2CPxrS61PhstmtJXl67A3rjC0gqdExAYxx25zgQIl4BgiAjkNCgi3TMBMw5B+NaXWp8Nls1pK8vXYGqR9YH7wq5MgX3jVg6aiYAsoGQw/aHYlwsg0AIBwmcaYeXj8a0utT4bLZrSV5euwZTZIatDBlUAKFh2JilrWJs5XcurolmD7wnLVihjFhwA8RiUviLVblERwe0fi2l1qfDZbNaSvL12EHSgFAnYEKuDqhgjE5ZnRXB0j2/vCt7eH/UARGJNLjMyidXSH4tpdanw2WzWkry9djp8e0utT4bLZrSV5evcVpdanw2WzWkry9e4rS61PhstmtJXl69xWl1qfDZbNaSvL17itLrU+Gy2a0leXr3FaXWp8Nls1pK8vXuK0utT4bLZrSV5evcVpdanw2WzWkry9e4rS61PhstmtJXl69xWl1qfDZbNaSvL12OcTQWJcWlpD9oIq6dYR8YOT6wmiuqUTFcZs+UYapOXIVx9OYwZs5KnjMf8AcYl85WRUAiw1LADX4Npdanw2WzWkry9djtAAg8ER8AiUKYJDhXL2ZKjWCLJlSEwDQoZBDBzj9Ylqx6HDMQOWUeYQ5XUxJhSEBEM+Xs6j7GoGKgQDZ6B8G0utT4bLZrSV5euxzGXEmBKZjBmj8JmSICmnm+gwDWcgFA/csJy+ao4WAGfhAspuYokMGQeES+QimcFXI5uz4Vpdanw2WzWkry9e4rS61Phstms6vL17itLrU+GyyR4RouIKZjQAgYKh3AYwEDCNmicvCu3FSZgybMVdUgUKYQ5xe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GL248weoxe3HmD1GDrqqaZhH/sarZxubVmEIVs65JqzAMKy12jpJjBiiTIYO8AARzQlL3S2gmMJWedH06BCVm0i6w9f4DopqaZaw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jjjjjjjjjjjjjjjjjnHv/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AOQx5/8A/v8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A7/nDOVrzzBKuanRL7b/7z/8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A71z4DbLzh88888888s98uaCCnn3Fz1yx474+67wy++68z/8ADpmrLanm/nPffPPPPPPPPPPPPPPPPPPPCNXHLHLPfH/7XDT/AE21z53031w6xwz7zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzy36tMUtzzzjjjzzzjTzTzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzRMb330XTzwRRTBzzhiTjjzyzzzTiRzjzTzzzzzzzzzzzzzzzzzzzzzwwHb+kZH7xTBAyhRihjDBzwhQDzzyTygTzzzzzzzzzzzzzzzzzzzzzzx6wGR3f1nzDwDxCxRTwADzyQBgzwhQQDzzzzzzzzzzzzzzzzzzzzzzzyPXowz777xzTxTxTzzzjTzxziiTxwCyjzzzzzzzzzzzzzzzzzzzzzzzyj2/T/wC47888EcooU8ogEEoksMYU8IoU88888888888888888888888888zOybU8888c88sccMMM8s888M88M8cc888888888888888888888888tt8888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888//EACwRAAIBAgMHBAMBAQEAAAAAAAERACExQVGhQGFxgbHB0VCR8PEQMOEgcID/2gAIAQMBAT8Q/wCy3lrxRfh/gVt/m/8Ahfk0/wA0/wBWof8AWK2LdCiGeYrygTkIEiSNL5mBAR3Q3C+Bl5kiDyMLcFQWc5ZEczq4SSinH+RqwdRpaqpnHwYVQ4nlugv6kAOccmQM0U3vImGlps0pB6kkaVoHljApHCeMo9FkKq29zJCBAUR+OMcGA+OMbhs9IDD3gAVsm/fwjRqY1Kgmr4QOZgSuBQ4jIwk4gr3qHhLRzmMgANhoU334QgS7rXb2hk8vpUUdhCoABvKCGgzAJivI8QHxGA+bJOFnceIPBK2YI7S5UYA94Q+hkG4HxxQ4MlwosGUOwCYIUBE15R146CPKkoxOUxAWe1Yc4EMkgHXcYRv0UL5t5wwqhE2QqZQyQkMVBgIldoq8FhCXUVBsoKplfRIADmvAw6rB3jny68IAcVshf1KomMAV6CUqEQIrYPDOFtIMIr/UPLWAcaQuYRJuoC4hZELKqzhzlqbEi83EckBLcxWu6kBMjRasQCQylcEAq2QIesMS2QjCgAfGAxrZkgEo926L6iCfc+oPAQEo2KCW94p5BitnvPvI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",
  alipay: "data:image/jpeg;base64,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+2i5z7jYotSOFJ03C+dt9LXt4MeVbAuLbnbXDaHOc2UL124DXTgNduA104A+arlBOxoljejbb5m2XWf9xN9TM5euG0a4bQbOm+2x2czHZb7E80biyV0yb1COMSAhkTOE6Un2mm3nmBE6Km+qWeKiwRPUd4pM2ytJMvJcnQu7ymWzdtpR6liBc17I9KETa1a4bQ4HWqVrDK0Ta167bgbPENLHZ1NeFYYJUnaGw7IFQpmjifRQsPV3bbDLirksrcktCJ+daNeJjSq/zsjclRNbZrdtDoosVuOwm6lh2t20a4bQZOW+215db3haI5ILGOnEAkcQCRxAJHEAkcQCRxAJHEAkcQCRxBJHEAkPzpa8Lvtouc/bUXOftqLnP21Fzn7ai5z9tRc58NE2qHC5LELKUtjbfbTTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063jTreNOt4063i6NoLqKohaFiA9Df8JFznwmRjucLiSrSLP0Y8gtSU9MtzZf8FFznwWxDc4rCSbSC/YjcS1p2y6vltRLS15IucC7V+xSfRKnRqbVqZartQpiDqKCdu90Q3uiBCgpTbsaHG9xpsVqrESZOfapIXuBbcTbdS+0HqCktm+EQ3yiG+EQTr06q7Ye4lJ1ftZnG9yJ2qFJaUql1LqJVpK2gONoQSjV2Lk9HEqq89ySpjN9IBS6l1DzrU5KNXYuThS4lpFOyxwsMXhI4FLbtqlPYrIXJLkKr4CLnPgxBNShO26r75vF+DXvL1Xi/Bu3l9VyfE6IyOvJCRMuQrT1F6NXR9St68pQvS3LE65hOKRtrEcehdGI5MhSMBxiZAmqkIQt9XRVH7bilEebEqxEhQNTiTEuRH/cY/wAdkgM9YoPtdSzVSZ6WpyCntOUgq6eolnTLGFBWxU3Ji5BuFAGsmxPI9j/9XfPlfQ22uHm2xXldla+ANu1E40p4A7xYHa26l9r6UovRNKVyMQFp1+/j0xamUSJtSpmxJyslVVutqqSNBW/0AdXNMe6JXRKtvVNVv1ykNtXdEmtb6MqlcnTpnlTe4bZgm8K/ARc58GN20taNro5GN4KkZ51qBSrQqdSG2HA+lPoxq8strNaV15t0eV/WTIlSuylP4kDhUhOjJuTpWgy+94dHi1EE1TLio5zbJ1GLdNivIxPkhQRj/AL1dEKRuLPo/uJdDEvorB6KwILfIklnTbGJTdaobDbHrcKkMpNyZ/clihIN9OAXOCo11304jfTiERxihMKCK8rscqLXE9G8tSIjUjeFD41qiUJS1qOc+nNDUYpb21PVLJFya5ZJXtpOSILlVqJr+kfc5OFqK2yjUhutdUKcp2JQp0t71Y3FHfVYgYQWe2KDL29Ump6mS7ZVb4tXwEXOfBjN/nadtaeNEhtWBYsWlISGtMY4qw53udxsbaCVJFyNx+ve2OtLWJGuUJnJwta0tSFNHVUuIR2IjlStybGYptFP7j19tqtk/lwjptCWeLl+RpifIigjH+AvstMtV91PJ6UlN6liHqWINJxByKW1/wBvtWvFLVKlfV79e8hlvNMf9j/feW8on5Oou20EV5XZWlLqOhSREgYWwq1rkyUglsIp5SXdSUShbUDUaibqo29/VnH2yV7VuByAgu01C/dUVpbFiZnU3oFjz1oKlLpRRa6ud6pAe4GHPy7073StLvZKzPK2fARc58GIK6ewwy0m10d0q2zdixEET4jWbD/wRTpb433mCyt9yWI9NvLtMD51hQzpVStktoW8n3/RJjyk5U3J41Q49C1p2u11X+vqstVtZLY4EOBOyMf47FfdMr5beSAHuCGpMV6Q819c7hb3SG+vmk+x07hXNidxsbG5W3n7Yryuwwy0mw0yskW0t8tJPf8AVrSngHNOjuJam1OuSNhCBWI/SqtZKf4Z0nKv3VBVOXca89bFxlXF+TfzJ0N9WUprb6uRbEsus9kuV+c/4CLnPgo1V6JSjV2LU4r/ADS2MlmGJkhKSwLGZIuDczbuOcmm5eYgQ2NyYKWEw8xuQFtqXxC9sqsWhZHilKnTFt4TJ7EhAc2ujlYhbyG8sFs5JTjsY0JyKmw5tqa7OzZvQnT7eLo8gra1IN2pCGwpOtBjeUatcGUpxNbmghs2qmz1Lj7WFCchI2OTRa53kEWJijmAww5BHykagOLZY5C22llq1kIWmpEdiNJWL/UFttLLXBsqtVByb719Esf+krC1HceU2s/oT1rOW4K/DwC1oKWqNjiusb0qg+5Sd8BFznwmp3MazEa8leX87w93h/8ACXuRDcW5OZrkd8FFznwyjryL0ssUFUtmBA1enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041enGr041gnGsE41gnGsE41gnGsE41gnGsE41gnGsE41gnGsE41gnGsE41gnGsE41gnGsE41gnGsE41gnGsE41gnGsE41gnGsE41gnGsE4umBNKKpWpOoYZcbd8JFzn7ai5z9tRc5+2ouc/bUXOftqLnP21Fzn7ai5z4P91ZIVcpsTMKBLbu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3phu9MN3pgqjyBXa+Q0xFZ8FFznwYU0WrFPh+k1oJg0Wty/4CLnPgw0qhbF+lTkql7R8BFznwYl0D9Km3Q/gIuc+DEegfpU26H8BFznwYj0D9Km3Q/gIuc+DEegfpU26H8BFznwYj0D9Km3Q/gIuc+DEegfpU26H8BFznwYj0D35TkTm1SHW76NbPo1s+jWz6NbPo1s+jWz6NbPo1u+jEbyteE+zKcicmqQ62fBrZ9Gtn0a2fRrZ9Gtn0a2fRrZ9Gtn0Yjelzun2zZWchi+tn0a2fRrd9GtnwRk8xVH/Y8mXEtOtn0YsdFbtH9mQJS7N8q1s+DWz4IyeYpYNuXHxe0KNbvo1u+jWz6NbPo1s+jWz6NbPo1s+jW76MTSBxd3X3zbofwEXOfBiPQPfmTudmajHtz4Luo4MOo4MOo4MOo4MOo4Luouwy622nF1JNwjyqxTajS8aGoOzEdlJRwXdRwXdRwXdRwXdRwXdRwXdRwXdRdhl1ttOL+ibhHllim1Gk4ztQjEmIlKCUNZj0xcF3UcF3UcF3UcF3UMaK9taBfX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FbJEL34m5ii5tTK+OzNGdCvCqkhbZYWt0FNhjtIHWevFIfL5WNebbiEMZJ6yT14qWfKBuROizTidO2aSB7tNxWPq53N7LU2KMWMaLBijaZXxgHPd61chZd7XdZxeVx2sNmdg0E46nKtu35Lwz9WOGsv2CNtl2xRsv3Lrr2i1aq3xKIFM0HtzoQX7+cm1TVItvydvVijqjblY8wz5kJHvkYQLOQU7JXi52lzjnx01VlLuR+7Zp86ZszbpdIXDPbjiykr2sZpYNBQjjYGMHUE97a6Zgcbbo6ll3yPnmGhz+rFEJHuDWutujQUABYB1KSUlzJHMuWtKbAz1QNPagJKyWSO31Sg0ZgMypZRJdyLr1lmnFHcqH05b1t60yomqX1L2erexERSmneTbfYpZ5J3TzSCy85RyyvcY2fyupWaFDMSY5Iz6zevG6V/wHaU+V5tc42n2GDaN4+xmzlRO9Zqvwvt/TrH5HvSuF7qZ1lX35mj1W9nsUG0bx9kvxuLHDrCsmjbN+ugrPBIPiuZkXMyLmZFzMi5mRczIuZkXMyLmZFzMi5mRczIuZkXMyLmZFzMi5mRczIuZkXMyLmZFzMi5mRczIuZkXMyLmZFzMi5mRczIuZkXMyLmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouZk+i5mT6LmZPouTBIT70RE1sA7RnKLnuLnHrPscG0bx/N0G0bx/N0G0bx/N0G0bx/N0G0bx/N0G0bx/N0G0bx/N0G0bx9is60Jq1xjadEQ0qxlNH73C1avFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBavFuBav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X8DLPNePPKW1H8s5mn+FT3kP3oPztQ0VX4noChOWym+SVb7egiPxQQR/lIHsrYWc1vQ5behy29Dls6HLZ0OWzoctnQ5bOgltOvqOVHer+ol/9FL/AFryFnH+tbk1UaF/q9RKMIkyFKOf9PDwf//aAAwDAQACAAMAAAAQlvf9999999999999999999999999999999999999999999999999vnoP99999999999999999999999999999999999999999999999999999D199999999999999999999999999999999999999999999999999999s999999999999999999999999999999999999999999999999999999V999999+816z/AOP8cNtf4scce+M8888vvfPPvffm9vPPdv8Abz3r33331X333330NkPtI3QxqoZXlfYudrrMDtQAm9p3/N+KPreK1mnOGT/33331X333331V0U44h9IsIkneaZQRMGscaiervIAbuIZXIXb5FDv3l333331X333333m32bZuDRkyp02rjaFgigH14mK6/YjPd9OfD72aNYBvX33331X333333Rw6qvW2ZtfRBa81vA/7QZigwL4PuC/79SjDn0yhgOVP33331X333332b2hOu5YHqZ6xs6+xyKq4JLT3ThqEz5nzb4y19c0TgOz33331X33333087zww8121w3y1/wAeN9MfOeftNv8AnvDXL7f/AMx608466733331X333333333333333333333333333333333333333333333333333331X333333333/wA+8888888888888888888888888888888//wD/AH3333331X33333333m8UEEEEEEEEEEEkEEEU0EEEEEEEEEEEEEEU15n/wB999999V99999999tTPpOKp5mFF/av2RX1a+UK03v97kvOrBh0C8xFy9999999V99999999/pJsGU5AvgDCT8XEfb7vN+2e9ryQS8X+wz+Qt929999999V99999999+g2fw48fjkMG0ZetHIUc8IOf+rcuKT0Iv0Xs43s9999999V99999999/Kxxsdv6g884I/c+/NM6SnsOHOMM9I8u99MNi+/8AffffffVfffffffaVfffffffffffffffffffffffffffffffffffffffffffffVffffffffffffffffffffffffffffffffffffffffffffffffffffffVfffffffffffffffffffffffffffffffffffffffffffffPffffffffVfffffffffbRTDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDnd/ffffffVffffffffalfPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPL/8A3333331X33333332rzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzf3333331X33333332rzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxT3333331X33333332rzzzjDDDDDzTzzzzTzzzjzzTTjzTzDDDDDTzzxT3333331X33333332rzzxTDjDSiiQAACiQwCBCzizwgxSwAQwwjTzzxT3333331X33333332rzzxTSwyBxyDDDSAwBwAySwxRRThRATyjBTzzxT3333331X33333332rzzxRRTwjzwRDzRQgzRCzSBSjQijQCxyihTzzxT3333331X33333332rzzxRBzyDzhRRSDhTAwxSiByTyDzwCziCBTzzxT3333331X33333332rzzxCzjCRTwzgChAxShjzwTRzCDzQBzzxxTzzxT3333331X33333332rzzxzjDzCBAASzwzRAQTDAhCxABDRjzzyDzzzxT3333331X33333332rzzzxTgTTzygwCBBTjBzRCwxBwxhgCAQiTzzzxT3333331X33333332rzzzBCCTiQwTSBTShTQBQzTDzjwjzwhQTDzzzxT3333331X33333332rzziyyjTATyRSgSwyjxRQwzDTjDCxziQARzzzxT3333331X33333332rzyyjzCCjDyhSgQwTTxAQxzzxBRTxSBygjzzzxT3333331X33333332rzzxwxwDgCABCCiThyxRCzTywSRzyiSzQDzzzxT3333331X33333332rzzzyjSyQhywAxQ45JktklM3RhSTzxQQQDzzzxT3333331X33333332rzzzywzAhDDQyCQMsWzRlqxZQSAjDTCjQDzzzxT3333331X33333332rzzwAAgxgzzjgDCMkhBr2/hVihiARiQTwTTzzxT3333331X33333332rzzyASjAgAhDighDbngzt55CyQBAxQzCRTTzzxT3333331X33333332rzzxSyTwQgyjzTzs9WTGRT8XwSQgDzhxihTzzxT3333331X33333332rzzzCCzxzSgzwAiDPIoVBlHdRQAAzCjBwhzzzxT3333331X33333332rzzwABDiRyzxzhBDnrrZM4i0jggwhijSijTzzxT3333331X33333332rzzyBhiwwjwTzjCGUlygushOTghiRDwDizzzzxT3333331X33333332rzzxCxwzjzyzRRiQxADyBq0QwyiyDhAAjTzzzxT3333331X33333332rzzwwzhwDjggzgiDCDRjnyzD2niTTQADwzzzzxT3333331X33333332rzzzSAARQyBgzTwRyyGGWUWEAExjjhQSRzzzzxb3333331X33333332rzzwADAyDgDCQxxTzzThwiyzUAjhRwQBCjzzzwL3333331X33333332rzzxjCQBxzjxADSyiyRwjCiUwAxQSjAyCzzzzwL3333331X33333332rzzxTCBAARizTThxhCjQTDRyigkjxDxSDTzzzwb3333331X33333332rzzxRTDDAjRjyzjSQTxgywixSHgCxjwRjhzzzxT3333331X33333332rzzxSgQwihxjgjTzBRDyDyiACgwzTVSWmTzzzxT3333331X33333332rzzxSgTyiijzxxhSQTBxyyAiDH2mTHk0gRTzzxT3333331X33333332rzzxTBTyyhxzyBRTwBwSSxxDDTyjSgHnn3XzzxT3333331X33333332rzzxTzzzyjzjwhBwgQghRzwThCzSGX23kmXzzxT3333331X33333332rzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxT3333331X33333332rzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxT3333331X33333332rzzzzzzzzzzzzzzzzzzzzzzzzzz7DPPPf3rzzxT3333331X33333332rzzzkpOZeUqPTzzzzzzzzzzzzyy+nwRY0YZzzxT3333331X33333332rzzz6RlnBdptzzzzzzzzzzzzzzh7p3Cape7zzxT3333331X33333332rzzw+twM9+Fvzzzzzzzzzzzzzyy2QO/P5JvTzxT3333331X33333332rzzzzzzzzzzzzzzzzzzzzzzzzzyyD3313pTzzxT3333331X33333332rzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxj3333331X333333331Pzzzzzzzzzzzzzzzzzzzzzzz3zzz3zzz3zzwRb3333331X33333333z53/333/8A999/999/999//wDff/8A33//AN9//wDffTvfffffffVffffffffffffffffffffffffffffffffffffffffffffffffffffffVffffffffffffffffffffffffffffffffffffffffffffffffffffffVdcccccccccccccccccccccccccccccccccccccccccccccccccccccQjDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDvPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPKhAS7ukPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP8A/mHe9DSgNDwBjyBDyhTjzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyl4eT6kiRJdE1RhyjBDSDzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzmRFUT6vyy+0/BgDywCBijzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz4XIaAauxi7OrzgzyxyhCDzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzy4/Z6x85zjB9TD3jDAwBCTzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzwPDHPO3MzzzwjTzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyzTzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzTSDzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxzz/8QAKxEAAQIEBAUFAQEBAAAAAAAAAQARITFhoTBBUcFxkbHR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"
};
function openDonate() {
  $("#donWechatImg").src = DEV_DONATE.wechat;
  $("#donAlipayImg").src = DEV_DONATE.alipay;
  showMask("#donMask");
}
function previewDonate(field) {
  $("#lbImg").src = DEV_DONATE[field];
  showMask("#imgMask");
}
$("#btnDonate").onclick = openDonate;
$("#donWechatImg").onclick = () => previewDonate("wechat");
$("#donAlipayImg").onclick = () => previewDonate("alipay");
/* 放大预览只关自己，别把底下的捐助弹窗一起关掉 */
$("#imgMask").addEventListener("click", e => {
  if (e.target === e.currentTarget) { e.stopPropagation(); e.currentTarget.classList.remove("show"); }
});

/* ---------- 搜索：书签搜索（主） + 网页引擎搜索（副） ---------- */
const DEFAULT_ENGINES = [
  { n: "百度", u: "https://www.baidu.com/s?wd={q}" },
  { n: "必应", u: "https://www.bing.com/search?q={q}" },
  { n: "谷歌", u: "https://www.google.com/search?q={q}" },
  { n: "夸克", u: "https://quark.sm.cn/s?q={q}" },
  { n: "搜狗", u: "https://www.sogou.com/web?query={q}" },
  { n: "DuckDuckGo", u: "https://duckduckgo.com/?q={q}" }
];
const LS_ENGINES = "xingchen_bm_engines";
function loadEngines() {
  try { const raw = JSON.parse(localStorage.getItem(LS_ENGINES)); if (Array.isArray(raw) && raw.length) return raw; } catch (e) {}
  return DEFAULT_ENGINES.map(e => ({ n: e.n, u: e.u }));
}
let engines = loadEngines();
function saveEngines() { try { localStorage.setItem(LS_ENGINES, JSON.stringify(engines)); } catch (e) { toast("保存引擎失败", "bad"); } fillEngineSelect(); }
/* 1.6.4：引擎选择器按"当前选中项"的文字宽度自适应收窄——
 * 原生 select 默认按最长选项（DuckDuckGo）撑宽，选中"百度"时右边会空一大截 */
function sizeEngineSelect() {
  const sel = $("#engineSelect");
  if (!sel) return;
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  const t = opt ? opt.textContent : "";
  let px = 0;
  for (const ch of t) px += /[^\x00-\xff]/.test(ch) ? 14 : 8;
  sel.style.width = Math.min(px + 34, 140) + "px";
}
function fillEngineSelect() {
  const sel = $("#engineSelect");
  const cur = Math.min(+sel.value || 0, engines.length - 1);
  sel.innerHTML = "";
  engines.forEach((en, i) => { const o = document.createElement("option"); o.value = i; o.textContent = en.n || ("引擎" + (i + 1)); sel.appendChild(o); });
  if (cur >= 0) sel.value = cur;
  if (!sel._sized) { sel._sized = true; sel.addEventListener("change", sizeEngineSelect); }
  sizeEngineSelect();
}
fillEngineSelect();
const engineUrl = (en, q) => String(en.u || "").replace("{q}", encodeURIComponent(q));
/* 引擎管理弹窗 */
let engDragIdx = null;
function renderEngList() {
  const list = $("#engList"); list.innerHTML = "";
  if (!engines.length) { list.innerHTML = '<div class="none" style="padding:14px">暂无搜索引擎，点下方按钮添加</div>'; return; }
  engines.forEach((en, i) => {
    const row = document.createElement("div"); row.className = "eng-row"; row.draggable = true;
    const hnd = document.createElement("span"); hnd.className = "hnd"; hnd.textContent = "⋮⋮"; hnd.dataset.tip = "拖动调整顺序"; row.appendChild(hnd);
    const eName = document.createElement("input"); eName.className = "eName"; eName.value = en.n || ""; eName.placeholder = "名称";
    eName.onchange = () => { en.n = eName.value.trim() || "未命名"; saveEngines(); };
    row.appendChild(eName);
    const eUrl = document.createElement("input"); eUrl.className = "eUrl"; eUrl.value = en.u || ""; eUrl.placeholder = "https://…/?q={q}";
    eUrl.onchange = () => {
      const v = eUrl.value.trim();
      if (!/^https?:\/\//i.test(v)) { toast("网址需以 http/https 开头", "warn"); eUrl.value = en.u || ""; return; }
      if (!v.includes("{q}")) { toast("网址中需要包含 {q} 作为搜索词占位", "warn"); eUrl.value = en.u || ""; return; }
      en.u = v; saveEngines();
    };
    row.appendChild(eUrl);
    const up = document.createElement("button"); up.className = "eb"; up.textContent = "↑"; up.dataset.tip = "上移";
    up.onclick = () => { if (i === 0) return; const t = engines[i - 1]; engines[i - 1] = engines[i]; engines[i] = t; saveEngines(); renderEngList(); };
    row.appendChild(up);
    const down = document.createElement("button"); down.className = "eb"; down.textContent = "↓"; down.dataset.tip = "下移";
    down.onclick = () => { if (i === engines.length - 1) return; const t = engines[i + 1]; engines[i + 1] = engines[i]; engines[i] = t; saveEngines(); renderEngList(); };
    row.appendChild(down);
    const del = document.createElement("button"); del.className = "eb del"; del.textContent = "🗑"; del.dataset.tip = "删除该引擎";
    del.onclick = () => {
      if (engines.length <= 1) { toast("至少保留 1 个搜索引擎", "warn"); return; }
      if (!confirm("删除搜索引擎「" + (en.n || "") + "」？")) return;
      engines.splice(i, 1); saveEngines(); renderEngList(); toast("已删除", "ok");
    };
    row.appendChild(del);
    row.addEventListener("dragstart", () => { engDragIdx = i; row.classList.add("dragging"); });
    row.addEventListener("dragend", () => { engDragIdx = null; row.classList.remove("dragging"); });
    row.addEventListener("dragover", e => { e.preventDefault(); if (engDragIdx != null && engDragIdx !== i) row.classList.add("dragover"); });
    row.addEventListener("dragleave", () => row.classList.remove("dragover"));
    row.addEventListener("drop", e => {
      e.preventDefault(); row.classList.remove("dragover");
      if (engDragIdx == null || engDragIdx === i) return;
      const [moved] = engines.splice(engDragIdx, 1);
      engines.splice(i, 0, moved);
      engDragIdx = null; saveEngines(); renderEngList(); toast("顺序已调整", "ok");
    });
    list.appendChild(row);
  });
}
$("#btnEngMgr").onclick = () => { renderEngList(); showMask("#engMask"); };
$("#engAdd").onclick = () => {
  engines.push({ n: "新引擎", u: "https://www.example.com/search?q={q}" });
  saveEngines(); renderEngList();
  const rows = $$("#engList .eng-row");
  if (rows.length) { const last = rows[rows.length - 1]; last.querySelector(".eName").focus(); last.querySelector(".eName").select(); }
};
let selIdx = -1;
let curRows = []; // [{type:'folder', f} | {type:'bm', it}]
const sIn = $("#searchInput"), sBox = $("#suggestBox");
function hl(text, q) {
  const t = esc(text); if (!q) return t;
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t;
  return t.slice(0, i) + "<mark>" + t.slice(i, i + q.length) + "</mark>" + t.slice(i + q.length);
}
function renderSuggest() {
  const q = sIn.value.trim();
  if (!q) { sBox.classList.remove("show"); curRows = []; return; }
  const lq = q.toLowerCase();
  const folders = DB.folders.filter(f => f.name.toLowerCase().includes(lq)).slice(0, 6);
  const bms = DB.items.filter(it => it.name.toLowerCase().includes(lq) || it.url.toLowerCase().includes(lq) || (it.desc || "").toLowerCase().includes(lq)).slice(0, 10);
  curRows = folders.map(f => ({ type: "folder", f })).concat(bms.map(it => ({ type: "bm", it })));
  selIdx = -1;
  let html = "";
  if (folders.length) {
    html += '<div class="gtitle">📁 匹配的文件夹 <b>' + folders.length + '</b>（选中后回车进入）</div>';
    folders.forEach(f => {
      const idx = curRows.findIndex(r => r.type === "folder" && r.f.id === f.id);
      const path = folderPath(f.id).map(x => x.name).join(" / ");
      const cnt = folderTreeCount(f.id);
      html += '<div class="row folder" data-idx="' + idx + '"><span class="lf">' + esc(folderEmoji(f)) + '</span><span class="nm">' + hl(f.name, q) + '<span class="cnt">' + cnt + ' 个书签</span></span><span class="pth">' + esc(path || "顶层") + "</span></div>";
    });
  }
  if (bms.length) {
    html += '<div class="gtitle">🔖 匹配的书签 <b>' + bms.length + '</b>（单击/回车定位到所在位置，右键打开）</div>';
    bms.forEach(it => {
      const idx = curRows.findIndex(r => r.type === "bm" && r.it.id === it.id);
      const path = folderPath(it.folderId).map(f => f.name).join(" / ") || "工具栏";
      html += '<div class="row" data-idx="' + idx + '"><span class="lf"></span>' + '<span class="nm">' + hl(it.name, q) + '</span><span class="pth">' + esc(path) + " · " + esc(hostOf(it.url) || it.url.slice(0, 40)) + "</span></div>";
    });
  }
  if (!curRows.length) html += '<div class="none">没有匹配「' + esc(q) + '」的书签或分类</div>';
  html += '<div class="foot"><span>↑↓ 选择 · Enter 定位 · 右键可打开 · Esc 关闭</span><span>单击文件夹进入，单击书签定位</span></div>';
  sBox.innerHTML = html;
  sBox.classList.add("show");
  $$("#suggestBox .row").forEach(r => {
    const srow = curRows[+r.dataset.idx];
    if (srow && srow.type === "bm") {
      const sph = r.querySelector(".lf");
      if (sph) { const sic = buildIcon(srow.it); sic.classList.add("lf"); sph.replaceWith(sic); }
    }
    r.onclick = () => pickRow(+r.dataset.idx);
    r.onmouseenter = () => { selIdx = +r.dataset.idx; markSel(); };
    r.addEventListener("contextmenu", e => {
      const row = curRows[+r.dataset.idx];
      if (!row || row.type !== "bm") return;
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { act: "open", label: "↗ 新标签页打开" },
        { act: "copy", label: "🔗 复制链接" },
        { sep: true },
        { act: "edit", label: "✏️ 编辑书签" }
      ], { it: row.it });
    });
  });
}
function markSel() { $$("#suggestBox .row").forEach(r => r.classList.toggle("sel", +r.dataset.idx === selIdx)); }
function pickRow(idx) {
  const row = curRows[idx];
  if (!row) return;
  sBox.classList.remove("show"); sIn.value = ""; sIn.blur();
  if (row.type === "folder") {
    state.view = "folder"; state.folder = row.f.id;
    render(); window.scrollTo({ top: 0 });
    toast("已进入文件夹「" + row.f.name + "」");
  } else locateBookmark(row.it);
}
/* 定位：跳到书签所在文件夹并高亮它（不打开链接） */
function locateBookmark(it) {
  if (!it) return;
  state.view = "folder"; state.folder = it.folderId;
  state.locatingId = it.id;
  render();
  const card = document.querySelector('.bcard[data-id="' + it.id + '"]');
  if (card) card.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => { if (state.locatingId === it.id) { state.locatingId = null; render(); } }, 2600);
  const p = folderPath(it.folderId).map(f => f.name).join(" / ") || "工具栏";
  toast("已定位到「" + p + " · " + it.name + "」");
}
/* 右键菜单（动态项） */
let ctxTarget = null; // { it } 或 { f }
function showCtxMenu(x, y, items, target) {
  ctxTarget = target || null;
  const m = $("#ctxMenu");
  m.innerHTML = "";
  items.forEach(it => {
    if (it.sep) { const s = document.createElement("div"); s.className = "ctx-sep"; m.appendChild(s); return; }
    const d = document.createElement("div"); d.className = "ctx-item"; d.dataset.act = it.act; d.textContent = it.label;
    m.appendChild(d);
  });
  m.classList.add("show");
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}
function hideCtxMenu() { const m = $("#ctxMenu"); m.classList.remove("show"); m.innerHTML = ""; ctxTarget = null; }
$("#ctxMenu").addEventListener("click", e => {
  const el = e.target.closest(".ctx-item");
  if (!el) return;
  const act = el.dataset.act, t = ctxTarget;
  hideCtxMenu();
  if (!t) return;
  if (act === "open" && t.it) { openMatched(t.it); }
  else if (act === "copy" && t.it) { copyUrlWithTip(t.it.url, "链接已复制，粘贴到地址栏即可访问"); }
  else if (act === "edit" && t.it) { sBox.classList.remove("show"); sIn.value = ""; sIn.blur(); openBmModal(t.it.id); }
  else if (act === "fdEdit" && t.f) { openFdModal(t.f.id, null); }
  else if (act === "fdNewChild" && t.f) { openFdModal(null, t.f.id); }
  else if (act === "fdDelete" && t.f) { deleteFolder(t.f); }
});
document.addEventListener("click", e => { if (!e.target.closest || !e.target.closest("#ctxMenu")) hideCtxMenu(); });
document.addEventListener("scroll", hideCtxMenu, true);
window.addEventListener("resize", hideCtxMenu);
function openMatched(it) {
  if (!it) return;
  it.usage = (it.usage || 0) + 1; persist();
  if (isFileUrl(it.url)) { openFileUrl(it.url); render(); return; }
  if (isAboutUrl(it.url)) { copyUrlWithTip(it.url, "浏览器禁止插件直接打开 about: 页面：地址已复制，粘贴到地址栏即可访问"); render(); return; }
  if (isSafeUrl(it.url)) window.open(it.url, "_blank", "noopener");
  else if (isJsUrl(it.url)) { navigator.clipboard && navigator.clipboard.writeText(it.url); toast("脚本已复制"); }
  else toast("不支持的网址", "warn");
  render();
}
/* 引擎搜索栏 */
function doEngineSearch() {
  const q = $("#engineInput").value.trim();
  if (!q) { toast("请输入要搜索的关键词", "warn"); return; }
  const en = engines[Math.min(+$("#engineSelect").value || 0, engines.length - 1)];
  if (!en || !en.u || !String(en.u).includes("{q}")) { toast("该搜索引擎配置无效，请点 ✎ 检查", "bad"); return; }
  window.open(engineUrl(en, q), "_blank", "noopener");
}
$("#engineGo").onclick = doEngineSearch;
$("#engineInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doEngineSearch(); } });
sIn.addEventListener("input", renderSuggest);
sIn.addEventListener("focus", renderSuggest);
sIn.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); if (curRows.length) { selIdx = (selIdx + 1) % curRows.length; markSel(); } }
  else if (e.key === "ArrowUp") { e.preventDefault(); if (curRows.length) { selIdx = (selIdx - 1 + curRows.length) % curRows.length; markSel(); } }
  else if (e.key === "Enter") {
    e.preventDefault();
    if (selIdx >= 0 && curRows[selIdx]) pickRow(selIdx);
    else if (curRows.length) pickRow(0);
  }
});
document.addEventListener("click", e => { if (!e.target.closest || !e.target.closest(".searchwrap")) sBox.classList.remove("show"); });
document.addEventListener("keydown", e => { if (e.key === "Escape") hideCtxMenu(); });
$("#btnData").onclick = () => {
  $("#dtCount").textContent = DB.items.length;
  $("#dtFolders").textContent = DB.folders.length;
  $("#importResult").className = "result"; $("#importResult").textContent = "";
  $("#syncResult").className = "result"; $("#syncResult").textContent = "";
  $("#hkResult").className = "result"; $("#hkResult").textContent = "";
  refreshSyncTab();
  refreshShortcutsTab();
  showMask("#dtMask");
};
$$(".etabs .tab").forEach(t => {
  t.onclick = () => {
    $$(".etabs .tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    ["import","export","shortcuts","sync"].forEach(k => {
      const idMap = { import: "#dtImport", export: "#dtExport", shortcuts: "#dtShortcuts", sync: "#dtSync" };
      const el = $(idMap[k]);
      if (el) el.style.display = t.dataset.dt === k ? "" : "none";
    });
    if (t.dataset.dt === "shortcuts") refreshShortcutsTab();
    if (t.dataset.dt === "sync") refreshSyncTab();
  };
});
const dz = $("#dropZone"), fi = $("#fileInput");
dz.onclick = () => fi.click();
["dragover", "dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => {
  e.preventDefault();
  dz.classList.toggle("on", ev === "dragover");
  if (ev === "drop" && e.dataTransfer.files.length) handleImportFile(e.dataTransfer.files[0]);
}));
fi.onchange = () => { if (fi.files.length) { handleImportFile(fi.files[0]); fi.value = ""; } };

function handleImportFile(file) {
  const name = (file.name || "").toLowerCase();
  const rd = new FileReader();
  rd.onload = () => { try { doImport(String(rd.result), name); } catch (e) { showImportResult("bad", "导入失败：" + (e.message || e)); } };
  if (name.endsWith(".html") || name.endsWith(".htm")) rd.readAsText(file, "utf-8");
  else rd.readAsText(file, "utf-8");
}
function showImportResult(cls, msg) { const r = $("#importResult"); r.className = "result " + cls; r.textContent = msg; }
function doImport(text, name) {
  const policy = ($$('input[name="dupPolicy"]').find(r => r.checked) || {}).value || "skip";
  let parsed = null, fmt = "";
  const t = text.trim();
  if (t.startsWith("{")) {
    const obj = JSON.parse(t);
    if (obj && Array.isArray(obj.folders) && Array.isArray(obj.items)) { fmt = "app"; parsed = obj; }
    else if (obj && obj.children && obj.guid != null) { fmt = "firefox"; parsed = parseFirefoxJson(obj); }
    else throw new Error("无法识别的 JSON 格式");
  } else if (/<NETSCAPE-Bookmark/i.test(t) || /<DT><A\s/i.test(t)) { fmt = "html"; parsed = parseNetscapeHtml(t); }
  else throw new Error("无法识别的文件格式（支持：本应用备份 JSON / Firefox 书签 JSON / 浏览器导出 HTML）");
  if (!parsed || !Array.isArray(parsed.folders) || !Array.isArray(parsed.items)) throw new Error("文件解析结果为空");
  const existingUrls = new Set(DB.items.map(i => normUrl(i.url)));
  let added = 0, skipped = 0;
  const findSameFolder = (parentId, name) => DB.folders.find(f => f.parentId === parentId && f.name === name);
  const folderMap = {};
  parsed.folders.forEach(pf => {
    if (pf.parentId === ROOT) {
      const same = findSameFolder(ROOT, pf.name);
      folderMap[pf.id] = same ? same.id : uid("f");
      if (!same) DB.folders.push({ id: folderMap[pf.id], name: pf.name, parentId: ROOT, emoji: pf.emoji || autoEmoji(pf.name) });
    }
  });
  const ensurePath = (pf) => {
    if (!pf) return ROOT;
    if (folderMap[pf.id]) return folderMap[pf.id];
    let pid;
    if (pf.parentId === ROOT || !pf.parentId) pid = ROOT;
    else {
      const parentPf = parsed.folders.find(x => x.id === pf.parentId);
      pid = folderMap[pf.parentId] || ensurePath(parentPf) || ROOT;
    }
    const same = findSameFolder(pid, pf.name);
    folderMap[pf.id] = same ? same.id : uid("f");
    if (!same) DB.folders.push({ id: folderMap[pf.id], name: pf.name, parentId: pid, emoji: pf.emoji || autoEmoji(pf.name) });
    return folderMap[pf.id];
  };
  parsed.items.forEach(pi => {
    if (policy === "skip" && existingUrls.has(normUrl(pi.url))) { skipped++; return; }
    existingUrls.add(normUrl(pi.url));
    const fid = pi.folderId === ROOT || !pi.folderId ? ROOT : ensurePath(parsed.folders.find(f => f.id === pi.folderId) || { id: pi.folderId, parentId: ROOT, name: "未分类导入" });
    const it = { id: uid("b"), folderId: fid, name: pi.name || pi.url, url: pi.url };
    if (pi.icon) it.icon = pi.icon;
    if (pi.desc) it.desc = pi.desc;
    if (pi.added) it.added = pi.added;
    DB.items.push(it); added++;
  });
  persist(); render();
  showImportResult("ok", "导入成功（" + fmtName(fmt) + "）：新增 " + added + " 个书签" + (skipped ? "，跳过重复 " + skipped + " 个" : "") + "。当前共 " + DB.items.length + " 个书签。");
  toast("导入完成", "ok");
}
function fmtName(f) { return { app: "本应用备份", firefox: "Firefox 书签 JSON", html: "浏览器书签 HTML" }[f] || f; }
function parseFirefoxJson(root) {
  const folders = [], items = [];
  const walk = (nodes, pid) => {
    (nodes || []).forEach(n => {
      if (n.type === "text/x-moz-place-container") {
        const name = (n.title || "").trim();
        if (name === "Mozilla Firefox") return;
        const f = { id: uid("f"), name: name || "未命名文件夹", parentId: pid };
        folders.push(f); walk(n.children, f.id);
      } else if (n.type === "text/x-moz-place" && n.uri && !String(n.uri).startsWith("place:")) {
        const it = { id: uid("b"), folderId: pid, name: (n.title || n.uri).trim(), url: n.uri };
        if (n.iconUri && /^https?:/i.test(n.iconUri)) it.icon = n.iconUri;
        if (n.dateAdded) it.added = Math.floor(n.dateAdded / 1e6);
        items.push(it);
      }
    });
  };
  (root.children || []).forEach(c => walk(c.children, ROOT));
  return { folders, items };
}
function parseNetscapeHtml(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const folders = [], items = [];
  const top = doc.querySelector("dl");
  if (!top) throw new Error("HTML 中没有找到书签结构");
  const walk = (dl, pid) => {
    let pending = null;
    Array.from(dl.children).forEach(node => {
      if (node.tagName === "DT") {
        const h3 = node.querySelector(":scope > h3");
        const a = node.querySelector(":scope > a");
        if (h3) {
          const f = { id: uid("f"), name: (h3.textContent || "").trim() || "未命名文件夹", parentId: pid };
          folders.push(f);
          const sub = node.querySelector(":scope > dl");
          if (sub) { walk(sub, f.id); pending = null; }
          else pending = f;
        } else if (a) {
          const url = a.getAttribute("href") || "";
          if (!url || /^place:/i.test(url)) return;
          const it = { id: uid("b"), folderId: pid, name: (a.textContent || "").trim() || url, url };
          let icon = a.getAttribute("icon") || "";
          if (icon && icon.length < 2500 && /^https?:/i.test(icon)) it.icon = icon;
          const ts = +a.getAttribute("add_date");
          if (ts > 1e12) it.added = Math.floor(ts / 1000); else if (ts > 0) it.added = ts;
          items.push(it);
        }
      } else if (node.tagName === "DL") {
        walk(node, pending ? pending.id : pid); pending = null;
      }
    });
  };
  walk(top, ROOT);
  return { folders, items };
}

/* ---------- 导出 ---------- */
function download(name, content, mime) {
  const blob = new Blob([content], { type: (mime || "text/plain") + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
}
$("#expJson").onclick = () => {
  const data = { app: "xingchen-bookmarks", version: 1, exportTime: new Date().toISOString(), folders: DB.folders, items: DB.items };
  download("书签备份-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(data), "application/json");
  toast("备份已导出", "ok");
};
$("#expHtml").onclick = () => {
  const escA = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const lines = ["<!DOCTYPE NETSCAPE-Bookmark-files-1>", "<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->", '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>", "<DL><p>"];
  const emit = (items, subs, depth) => {
    const pad = "    ".repeat(depth);
    items.forEach(it => {
      const attrs = it.added ? ' ADD_DATE="' + it.added + '"' : "";
      lines.push(pad + '<DT><A HREF="' + escA(it.url) + '"' + attrs + ">" + escA(it.name) + "</A>");
    });
    subs.forEach(f => {
      lines.push(pad + "<DT><H3>" + escA(f.name) + "</H3>");
      lines.push(pad + "<DL><p>");
      emit(folderItems(f.id), childFolders(f.id), depth + 1);
      lines.push(pad + "</DL><p>");
    });
  };
  emit(folderItems(ROOT), childFolders(ROOT), 1);
  lines.push("</DL><p>");
  download("书签-浏览器导入-" + new Date().toISOString().slice(0, 10) + ".html", lines.join("\n"), "text/html");
  toast("HTML 已导出，可在浏览器书签管理中导入", "ok");
};
$("#btnReset").onclick = () => {
  /* 分发版没有内置初始书签：此时「恢复初始数据」会把用户真实书签清成空，绝对要挡住 */
  if (!HAS_SEED) { toast("本版本未内置初始书签数据，请改用「清空全部书签」", "warn"); return; }
  const extWarn = IS_EXT_MODE ? "\n\n⚠ 当前为扩展模式：这将直接删除浏览器里现有书签，并写入内置的 " + SEED_DATA.items.length + " 个初始书签（涉及数千次操作，约需十几秒，期间请勿操作）。" : "";
  if (!confirm("重置将清空当前所有修改（含置顶、常用计数），恢复为初始的 " + SEED_DATA.items.length + " 个书签。" + extWarn + "\n建议先导出备份。确定继续？")) return;
  DB = JSON.parse(JSON.stringify(SEED_DATA));
  persist(); hideMask(); render(); toast("已恢复初始数据", "ok");
};
$("#btnClearAll").onclick = () => {
  const extWarn2 = IS_EXT_MODE && !useStandalone() ? "\n\n⚠ 当前为同步模式：将直接删除浏览器里的全部书签！" : (IS_EXT_MODE ? "\n\n当前为独立模式：仅清空扩展自己的本地数据。" : "");
  if (!confirm("将清空全部 " + DB.items.length + " 个书签和 " + DB.folders.length + " 个文件夹，系统变为空白状态。" + extWarn2 + "\n\n也可以随时导入自己备份的书签 / 浏览器书签重新开始。\n建议先导出备份。确定继续？")) return;
  DB.folders = []; DB.items = [];
  state.view = "home"; state.folder = null; expandedSec.clear();
  persist(); hideMask(); render(); toast("已清空，当前为空白书签系统", "ok");
};

/* ---------- 配置中心：快捷键 + 数据源（独立 / 同步） ---------- */
/* 默认快捷键：用户在「配置 → 快捷键」里重新录制后存到 pref */
const DEFAULT_HK = { hkToggle: "1", hkOpenTab: "2", hkSearch: "/" };

/* 把键盘事件转成可读字符串：例如 "1"、"Ctrl+K"、"Alt+Shift+2"。
 * 仅数字 / 字母键允许作为单键快捷键；其它必须搭配 Ctrl / Alt / Shift 之一。 */
function evtToCombo(e) {
  if (e.key === "Escape" || e.key === "Backspace") return e.key;
  /* 修饰键单独按下不算 */
  if (["Control","Shift","Alt","Meta"].includes(e.key)) return null;
  let key = e.key;
  if (key.length === 1) key = key.toUpperCase(); /* 字母统一大写，避免 a / A 分裂 */
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey && key.length > 1) mods.push("Shift"); /* 仅组合键才显示 Shift（避免 1 / ! 混淆） */
  if (e.metaKey) mods.push("Meta");
  /* 单字母 / 数字键允许无修饰直接录入；其它特殊键必须搭修饰键 */
  if (!mods.length && key.length !== 1) return null;
  /* 中文输入法会触发 Process，跳过 */
  if (e.key === "Process") return null;
  return mods.length ? mods.join("+") + "+" + key : key;
}
function comboDisplay(s) { return s ? s : "（未设置）"; }

/* ---------- 全局快捷键（浏览器级，任意网页生效）· 1.6.4 新增 ----------
 * Firefox 提供 commands.update() / reset() / openShortcutSettings()，扩展可以在自己的
 *   配置页里直接改写全局快捷键 —— 所以火狐上这里就是"一键设置"，不用跑去 about:addons。
 * Chrome / Edge 没有这些 API（浏览器刻意不允许扩展改写全局按键），只能跳转到
 *   chrome://extensions/shortcuts 让用户自己设，然后回到本页即可看到真实绑定。
 * 用能力检测（有没有 update）分流，而不是嗅探 UA，后续哪天 Chromium 支持了也能自动生效。 */
function cmdApi() {
  const capi = (typeof browser !== "undefined" && browser.runtime) ? browser
             : ((typeof chrome !== "undefined" && chrome.runtime) ? chrome : null);
  return (capi && capi.commands) ? capi.commands : null;
}
const CAN_EDIT_GLOBAL = (() => { const c = cmdApi(); return !!(c && typeof c.update === "function"); })();
/* 火狐只有 toggle-sidebar；Chrome 还有浏览器原生处理的 _execute_side_panel（只读，用于显示） */
const G_CMD = { toggle: isGeckoRuntime() ? "toggle-sidebar" : "_execute_side_panel", tab: "open-in-new-tab" };
const G_DEFAULT = { toggle: "Alt+1", tab: "Alt+2" };

/* 把键盘事件转成浏览器 commands 能接受的字符串：Ctrl+Alt+Q / Command+Shift+K …
 * 与页内快捷键不同：全局键必须带 Ctrl / Alt / Command / MacCtrl，
 * 单独 Shift+字母 或纯单键浏览器一律拒绝（防止误触劫持普通输入）。 */
function evtToGlobalCombo(e) {
  if (e.key === "Escape" || e.key === "Backspace") return e.key;
  if (["Control", "Shift", "Alt", "Meta", "Process"].includes(e.key)) return null;
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
  let key = e.key;
  if (key.length === 1) key = key.toUpperCase();
  const mods = [];
  if (e.ctrlKey) mods.push(isMac ? "MacCtrl" : "Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Command");
  if (e.shiftKey && key.length > 1) mods.push("Shift");
  const isFuncOrMedia = /^F([1-9]|1[0-9])$/.test(key) || /^Media/.test(key);
  const hasRealMod = mods.some(m => m === "Ctrl" || m === "Alt" || m === "Command" || m === "MacCtrl");
  if (!hasRealMod && !isFuncOrMedia) return null;
  return mods.length ? mods.join("+") + "+" + key : key;
}

function hkMsg(msg, type) {
  const r = $("#hkResult");
  if (r) { r.className = "result" + (type === "bad" ? " bad" : type === "ok" ? " ok" : ""); r.textContent = msg; }
  toast(msg, type === "bad" ? "warn" : "ok");
}

/* 调用浏览器写入绑定；不支持时统一返回失败原因，由上层提示。
 * combo 为 null 表示"恢复默认"，优先走浏览器自带的 reset（能还原 manifest 的 suggested_key） */
function setGlobalShortcut(cmdName, combo, done) {
  const c = cmdApi();
  if (!c || typeof c.update !== "function") { done(false, "当前浏览器不允许扩展改写快捷键"); return; }
  let p;
  try {
    p = (combo === null && typeof c.reset === "function")
      ? c.reset(cmdName)
      : c.update({ name: cmdName, shortcut: combo });
  } catch (err) { done(false, (err && err.message) || String(err)); return; }
  if (p && typeof p.then === "function") p.then(() => done(true, "")).catch(err => done(false, (err && err.message) || String(err)));
  else done(true, "");
}

function applyGlobal(cmdName, combo, inp, okMsg) {
  setGlobalShortcut(cmdName, combo, (ok, err) => {
    if (ok) hkMsg(okMsg, "ok");
    else hkMsg("设置失败：" + err + "（该组合可能已被浏览器或其他扩展占用，换一个试试）", "bad");
    if (inp && inp.blur) inp.blur();
    refreshGlobalShortcuts();
  });
}

/* 刷新快捷键面板：把 pref 里的当前值显示到输入框 */
function refreshShortcutsTab() {
  const fill = (id, val) => { const el = $(id); if (el) el.value = comboDisplay(val); };
  fill("#hkToggle", pref.hkToggle);
  fill("#hkOpenTab", pref.hkOpenTab);
  fill("#hkSearch", pref.hkSearch);
  refreshGlobalShortcuts();
}

/* 实时读取浏览器级全局快捷键的真实绑定（commands.getAll） */
function refreshGlobalShortcuts() {
  const setVal = (el, val) => {
    if (!el) return;
    el.value = val || "";
    el.placeholder = val ? "" : "未绑定 · 点此设置";
    el.style.color = val ? "" : "var(--danger)";
  };
  const note = $("#ghkNote");
  if (note) {
    note.innerHTML = CAN_EDIT_GLOBAL
      ? "✅ 当前是 Firefox，支持<b>在这里直接设置</b>：点输入框 → 按下组合键，立即全局生效，不用去浏览器设置页。"
      : "⚠ Chrome / Edge 不允许扩展改写快捷键，点输入框会<b>直接打开浏览器的快捷键设置页</b>，在那里设好后回到本页即可看到最新绑定。";
  }
  const c = cmdApi();
  if (!c || !c.getAll) { setVal($("#ghkToggle"), ""); setVal($("#ghkOpenTab"), ""); return; }
  try {
    const p = c.getAll();
    const apply = list => {
      let toggleKey = "", tabKey = "";
      (list || []).forEach(cmd => {
        if (!cmd) return;
        if (cmd.name === "open-in-new-tab") tabKey = cmd.shortcut || "";
        /* _execute_side_panel（Chrome 原生打开）与 toggle-sidebar（智能切换）
         * 都属于"切换侧栏"，优先显示已绑定的那个 */
        if ((cmd.name === "_execute_side_panel" || cmd.name === "toggle-sidebar") && cmd.shortcut && !toggleKey) {
          toggleKey = cmd.shortcut;
        }
      });
      setVal($("#ghkToggle"), toggleKey);
      setVal($("#ghkOpenTab"), tabKey);
      updateGlobalClearLabels();
    };
    if (p && typeof p.then === "function") p.then(apply).catch(() => { setVal($("#ghkToggle"), ""); setVal($("#ghkOpenTab"), ""); });
    else apply(p);
  } catch (e) { setVal($("#ghkToggle"), ""); setVal($("#ghkOpenTab"), ""); }
}
/* 有绑定 → 显示「清除」；已清空 → 显示「恢复默认」，一个按钮两种用途 */
function updateGlobalClearLabels() {
  const set = (btnId, inpId) => { const b = $(btnId), i = $(inpId); if (b && i) b.textContent = i.value ? "清除" : "恢复默认"; };
  set("#ghkToggleClear", "#ghkToggle");
  set("#ghkOpenTabClear", "#ghkOpenTab");
}
/* 启动录制：用户点输入框 → 监听 keydown → 存到 pref */
function bindHotkeyInput(inputSel, prefKey) {
  const inp = $(inputSel);
  if (!inp) return;
  inp.addEventListener("focus", () => {
    inp.value = "录制中…按下组合键";
    inp.style.background = "var(--accent-soft)";
  });
  inp.addEventListener("blur", () => {
    inp.style.background = "";
    refreshShortcutsTab();
  });
  inp.addEventListener("keydown", e => {
    e.preventDefault(); e.stopPropagation();
    const combo = evtToCombo(e);
    if (combo === "Escape") { inp.blur(); return; }
    if (combo === "Backspace") {
      pref[prefKey] = ""; savePrefs();
      const r = $("#hkResult"); if (r) { r.className = "result"; r.textContent = "已清空该快捷键"; }
      inp.blur(); return;
    }
    if (!combo) return; /* 修饰键单独按下、不可识别键 */
    /* 检测冲突 */
    const conflicts = [];
    ["hkToggle","hkOpenTab","hkSearch"].forEach(k => {
      if (k !== prefKey && pref[k] === combo) conflicts.push({ hk: k, label: { hkToggle:"切换侧栏", hkOpenTab:"新标签页打开", hkSearch:"聚焦搜索" }[k] });
    });
    if (conflicts.length) {
      const r = $("#hkResult"); if (r) { r.className = "result bad"; r.textContent = "冲突：「" + combo + "」已经绑定到「" + conflicts[0].label + "」"; }
      inp.blur(); return;
    }
    pref[prefKey] = combo; savePrefs();
    const r = $("#hkResult"); if (r) { r.className = "result ok"; r.textContent = "已设置：" + combo + "（关闭配置后生效）"; }
    inp.blur();
  });
}
bindHotkeyInput("#hkToggle", "hkToggle");
bindHotkeyInput("#hkOpenTab", "hkOpenTab");
bindHotkeyInput("#hkSearch", "hkSearch");
$("#hkToggleReset").onclick = () => { pref.hkToggle = DEFAULT_HK.hkToggle; savePrefs(); refreshShortcutsTab(); const r = $("#hkResult"); if (r) { r.className = "result ok"; r.textContent = "已恢复默认：1"; } };
$("#hkOpenTabReset").onclick = () => { pref.hkOpenTab = DEFAULT_HK.hkOpenTab; savePrefs(); refreshShortcutsTab(); const r = $("#hkResult"); if (r) { r.className = "result ok"; r.textContent = "已恢复默认：2"; } };
$("#hkSearchReset").onclick = () => { pref.hkSearch = DEFAULT_HK.hkSearch; savePrefs(); refreshShortcutsTab(); const r = $("#hkResult"); if (r) { r.className = "result ok"; r.textContent = "已恢复默认：/"; } };

/* 打开浏览器的快捷键设置页：
 * 火狐 137+ 有 openShortcutSettings() 可直接唤起；Chromium 可以用 tabs.create 打开
 * chrome://extensions/shortcuts（浏览器允许这个特定地址）；都不行再退回复制地址。 */
function openGlobalShortcutSettings() {
  const c = cmdApi();
  if (c && typeof c.openShortcutSettings === "function") {
    try {
      const p = c.openShortcutSettings();
      if (p && typeof p.then === "function") {
        p.then(() => hkMsg("已打开浏览器的快捷键设置页", "ok")).catch(() => fallbackOpenGlobal());
      } else hkMsg("已打开浏览器的快捷键设置页", "ok");
      return;
    } catch (e) { /* 继续走兜底 */ }
  }
  fallbackOpenGlobal();
}
function fallbackOpenGlobal() {
  const isFF = isGeckoRuntime();
  const isEdge = !isFF && /Edg(e|A|iOS)?\//.test(navigator.userAgent);
  const url = isFF ? "about:addons" : isEdge ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts";
  const capi = (typeof browser !== "undefined" && browser.runtime) ? browser
             : ((typeof chrome !== "undefined" && chrome.runtime) ? chrome : null);
  if (!isFF && capi && capi.tabs && capi.tabs.create) {
    try { capi.tabs.create({ url: url }); hkMsg("已打开快捷键设置页：" + url, "ok"); return; }
    catch (e) { /* 继续走复制兜底 */ }
  }
  const steps = isFF
    ? "已复制 about:addons：粘贴到地址栏回车 → 右上角齿轮 →「管理扩展快捷键」"
    : "已复制 " + url + "：粘贴到地址栏回车 → 找到「悟道书签管理器」→ 点输入框按下组合键";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => hkMsg(steps, "ok"), () => hkMsg("请手动打开：" + url, "bad"));
  } else hkMsg("请手动打开：" + url, "bad");
}

/* 全局快捷键输入框：能改就直接录制写入，不能改就跳浏览器设置页 */
function bindGlobalInput(inputSel, cmdName, defaultCombo) {
  const inp = $(inputSel);
  if (!inp) return;
  inp.addEventListener("focus", () => {
    if (!CAN_EDIT_GLOBAL) { inp.blur(); openGlobalShortcutSettings(); return; }
    inp.value = "按下组合键…"; inp.style.background = "var(--accent-soft)";
  });
  inp.addEventListener("blur", () => { inp.style.background = ""; refreshGlobalShortcuts(); });
  inp.addEventListener("keydown", e => {
    e.preventDefault(); e.stopPropagation();
    const combo = evtToGlobalCombo(e);
    if (combo === "Escape") { inp.blur(); return; }
    if (combo === "Backspace") { applyGlobal(cmdName, "", null, "已清除该全局快捷键"); inp.blur(); return; }
    if (!combo) {
      hkMsg("无效组合：全局快捷键必须带 Ctrl / Alt / Command（只用 Shift 或单个按键浏览器不接受）", "bad");
      inp.blur(); return;
    }
    applyGlobal(cmdName, combo, inp, "已设置全局快捷键：" + combo + "（立即生效）");
  });
}
bindGlobalInput("#ghkToggle", G_CMD.toggle, G_DEFAULT.toggle);
bindGlobalInput("#ghkOpenTab", G_CMD.tab, G_DEFAULT.tab);

/* 清除 / 恢复默认：有绑定就清除，已清空就恢复默认 */
function bindGlobalClear(btnSel, inpSel, cmdName, defaultCombo) {
  const b = $(btnSel);
  if (!b) return;
  b.onclick = () => {
    if (!CAN_EDIT_GLOBAL) { openGlobalShortcutSettings(); return; }
    const inp = $(inpSel);
    const has = inp && inp.value;
    applyGlobal(cmdName, has ? "" : null, null,
      has ? "已清除该全局快捷键" : "已恢复默认：" + defaultCombo);
  };
}
bindGlobalClear("#ghkToggleClear", "#ghkToggle", G_CMD.toggle, G_DEFAULT.toggle);
bindGlobalClear("#ghkOpenTabClear", "#ghkOpenTab", G_CMD.tab, G_DEFAULT.tab);

/* 「打开浏览器快捷键设置页」按钮 */
const btnGlobalHk = $("#btnGlobalHk");
if (btnGlobalHk) btnGlobalHk.onclick = () => { openGlobalShortcutSettings(); };

/* 绑定发生变化时（Firefox 有 onChanged；Chrome 没有事件，改为页面重新可见时重读） */
const cmdApiRef = cmdApi();
if (cmdApiRef && cmdApiRef.onChanged) {
  try { cmdApiRef.onChanged.addListener(() => refreshGlobalShortcuts()); } catch (e) { /* 忽略 */ }
}
document.addEventListener("visibilitychange", () => {
  const box = $("#dtShortcuts");
  if (document.visibilityState === "visible" && box && box.style.display !== "none") refreshGlobalShortcuts();
});

/* 刷新语言面板 */
function refreshLangTab() {
  $$('input[name="langChoice"]').forEach(r => { r.checked = (r.value === pref.lang); });
}
$$('input[name="langChoice"]').forEach(r => {
  r.addEventListener("change", () => {
    pref.lang = r.value; savePrefs(); applyPrefs(); render(); refreshLangTab();
    const lr = $("#langResult"); if (lr) { lr.className = "result ok"; lr.textContent = pref.lang === "zh" ? "已切换为中文" : "Switched to English"; }
  });
});

/* 刷新数据源面板：根据 pref.syncMode 选中 radio，控制「从浏览器导入」按钮显隐 */
function refreshSyncTab() {
  $$('input[name="syncMode"]').forEach(r => { r.checked = (r.value === pref.syncMode); });
  const imp = $("#importBrowserWrap");
  if (imp) imp.style.display = (IS_EXT_MODE && useStandalone()) ? "" : "none";
  /* 显示当前数据量 */
  const r = $("#syncResult");
  if (r) {
    r.className = "result";
    r.textContent = IS_EXT_MODE
      ? "当前模式：" + (useStandalone() ? "独立模式（扩展本地存储）" : "同步模式（实时读写浏览器书签）") + " · 共 " + DB.items.length + " 书签 / " + DB.folders.length + " 文件夹"
      : "网页预览模式：使用 localStorage 存储 · 共 " + DB.items.length + " 书签";
  }
}
$$('input[name="syncMode"]').forEach(r => {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    if (!IS_EXT_MODE) { toast("网页预览模式不支持切换数据源", "warn"); refreshSyncTab(); return; }
    const newMode = r.value;
    if (newMode === pref.syncMode) return;
    const fromLabel = pref.syncMode === "standalone" ? "独立模式" : "同步模式";
    const toLabel = newMode === "standalone" ? "独立模式" : "同步模式";
    const warn = newMode === "sync"
      ? "\n\n切换到同步模式后：当前独立数据会被保留（不会被覆盖），但 UI 将显示浏览器书签栏的内容。在同步模式下删除书签会真的从浏览器删除。"
      : "\n\n切换到独立模式后：将不再读取 / 修改浏览器书签；扩展将使用之前保存的独立数据（若为空则从空白开始）。";
    if (!confirm("确定从「" + fromLabel + "」切换到「" + toLabel + "」？" + warn + "\n\n两种模式各自保存独立数据，切换不会丢失。")) { refreshSyncTab(); return; }
    pref.syncMode = newMode; savePrefs();
    /* 切换后重新加载 DB */
    (async () => {
      try {
        await loadDB();
        applyPrefs();
        render();
        refreshSyncTab();
        toast("已切换到「" + toLabel + "」", "ok");
      } catch (e) { toast("切换失败：" + (e.message || e), "bad"); }
    })();
  });
});
/* 「从浏览器书签导入到独立模式」按钮：仅在独立模式可见 */
$("#btnImportBrowser").onclick = async () => {
  if (!IS_EXT_MODE) { toast("网页预览模式不支持此操作", "warn"); return; }
  if (!useStandalone()) { toast("请先切换到独立模式", "warn"); return; }
  if (!confirm("将清空当前独立数据，再把浏览器书签栏的全部内容复制进来。\n建议先在「导出 / 备份」里导出当前独立数据。\n\n确定继续？")) return;
  try {
    const imported = await loadFromBookmarks();
    DB = { folders: imported.folders, items: imported.items };
    /* 系统根文件夹不要带进独立数据 */
    DB.folders = DB.folders.filter(f => !f.sys);
    state.view = "home"; state.folder = null; expandedSec.clear();
    persist(); render(); refreshSyncTab();
    toast("已从浏览器书签导入 " + DB.items.length + " 个书签", "ok");
  } catch (e) { toast("导入失败：" + (e.message || e), "bad"); }
};

/* ---------- 全局快捷键监听（页面内，需 manager.html 获得焦点） ---------- */
/* 1=hkToggle 切换侧栏(关闭), 2=hkOpenTab 新标签页打开, hkSearch 聚焦搜索 */
document.addEventListener("keydown", e => {
  /* 配置弹窗打开时，让 bindHotkeyInput 优先处理（它 stopPropagation 了，走不到这） */
  /* 处理搜索快捷键 */
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select";
  /* 搜索快捷键：默认 / 或 Ctrl+K，未在输入框时触发 */
  if (!typing && pref.hkSearch && evtToCombo(e) === pref.hkSearch) {
    e.preventDefault(); $("#searchInput").focus(); return;
  }
  if (typing) return; /* 在输入框里不触发下面的快捷键，避免误触 */
  const combo = evtToCombo(e);
  if (!combo) return;
  if (pref.hkToggle && combo === pref.hkToggle) {
    e.preventDefault();
    /* 切换侧栏：Firefox sidebar 里 window.close() 无效，需通过 background 调 sidebarAction.close() */
    if (IS_EXT_MODE) {
      const _api = (typeof browser !== "undefined" && browser.runtime) ? browser
                 : ((typeof chrome !== "undefined" && chrome.runtime) ? chrome : null);
      if (_api && _api.runtime && _api.runtime.sendMessage) {
        try {
          const p = _api.runtime.sendMessage({ type: "close-sidebar" });
          if (p && p.catch) p.catch(() => {});
        } catch (e) {}
      }
      /* Chrome sidePanel 可以 window.close() */
      try { window.close(); } catch (e) {}
      return;
    }
    toast("网页预览模式：此快捷键需在扩展侧栏内使用", "warn");
    return;
  }
  if (pref.hkOpenTab && combo === pref.hkOpenTab) {
    e.preventDefault();
    openManagerInTab();
    toast("已在新标签页打开", "ok");
    return;
  }
}, true);

/* ---------- 初始化 ---------- */
(async function init() {
  await loadDB();
  applyPrefs();
  render();
  initNavGrip();
  /* 只有内置了初始书签时才显示「恢复初始数据」入口：分发版为空，
     留着它等于给用户一个"一键清空我真实书签"的陷阱按钮 */
  const rw = $("#fdResetWrap");
  if (rw) rw.style.display = HAS_SEED ? "" : "none";
})();

/* 浏览器标签页图标（favicon）：书签形渐变底 + 竖排“悟道”醒目两字 */
(function setFavicon() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4d7dff"/><stop offset="1" stop-color="#8a5bff"/></linearGradient></defs>'
    + '<path d="M11 2 h26 c2.2 0 4 1.8 4 4 v32 c0 3.2 -3.8 4.9 -6.3 2.9 L24 33.4 13.3 40.9 C10.8 42.9 7 41.2 7 38 V6 c0-2.2 1.8-4 4-4 z" fill="url(#g)"/>'
    + '<text x="24" y="20.5" text-anchor="middle" font-size="19" font-weight="900" fill="#ffffff" stroke="rgba(20,25,50,.35)" stroke-width="0.8" paint-order="stroke" font-family="\'PingFang SC\',\'Microsoft YaHei\',\'SimHei\',sans-serif">悟</text>'
    + '<text x="24" y="39.5" text-anchor="middle" font-size="19" font-weight="900" fill="#ffffff" stroke="rgba(20,25,50,.35)" stroke-width="0.8" paint-order="stroke" font-family="\'PingFang SC\',\'Microsoft YaHei\',\'SimHei\',sans-serif">道</text>'
    + '</svg>';
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  document.head.appendChild(link);
})();

/* 从书签新标签页切回来时，自动刷新界面（点击计数即时反映到常用区） */
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });
window.addEventListener("focus", () => render());

