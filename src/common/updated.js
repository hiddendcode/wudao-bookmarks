/* 悟道书签管理器 · “已更新”提示页
 * ============================================================
 * 这个页面只在新版本安装完成之后被后台脚本打开
 * （runtime.onInstalled 且 reason === "update"）。
 *
 * 它和沙拉查词那类“打开浏览器后跳转到一个页面提示更新”是同一个做法。
 * 必须说清楚：**页面本身不参与更新**。更新始终由浏览器完成，这里只负责
 * 把“新版本已经生效”这件事第一次明确告诉你 —— 它同时也是更新成功的证据。
 *
 * MV3 的默认 CSP 是 script-src 'self'，所以逻辑必须放在这个外部 js 里，
 * 不能写内联 <script>。
 */
(function () {
  var api = (typeof browser !== "undefined" && browser.runtime) ? browser
          : ((typeof chrome !== "undefined" && chrome.runtime) ? chrome : null);

  /* 每个版本的更新要点。发新版本时在这里补一条，页面会自动取当前版本对应的内容。 */
  var NOTES = {
    "1.4.6": [
      "新版本装好后会自动打开本页，明确告诉你更新已经生效",
      "本页只在更新完成时出现，平时不会打扰你",
      "书签数据、独立/同步模式、快捷键等设置全部保持不变"
    ],
    "1.4.5": [
      "浏览器里的扩展图标换成了新设计"
    ],
    "1.4.4": [
      "浏览器启动时会更早地检查一次新版本"
    ]
  };

  function $(id) { return document.getElementById(id); }

  /* 跟随系统深浅色（manager.html 是手动切主题，这个单页跟随系统即可） */
  try {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      document.documentElement.setAttribute("data-theme", "light");
    }
  } catch (e) { /* 保持默认深色 */ }

  /* 当前版本号：直接问浏览器，不写死 */
  var ver = "";
  try { if (api && api.runtime && api.runtime.getManifest) ver = api.runtime.getManifest().version; } catch (e) { ver = ""; }
  if (ver) $("ver").textContent = ver;

  /* 旧版本号由后台脚本用 ?from=x.y.z 传进来 */
  var prev = "";
  try { prev = new URLSearchParams(location.search).get("from") || ""; } catch (e) { prev = ""; }
  if (prev && prev !== ver) {
    $("prev").textContent = prev;
  } else {
    /* 拿不到旧版本号就整段撤掉，别显示一个破折号糊弄人 */
    var s = $("sub");
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }

  /* 更新要点 */
  var ul = $("notes");
  if (ul) {
    var notes = NOTES[ver];
    if (notes && notes.length) {
      for (var i = 0; i < notes.length; i++) {
        var li = document.createElement("li");
        li.textContent = notes[i];
        ul.appendChild(li);
      }
    } else if (ul.parentNode) {
      ul.parentNode.removeChild(ul);
    }
  }

  function openManager() {
    var url = "manager.html";
    try { if (api && api.runtime && api.runtime.getURL) url = api.runtime.getURL("manager.html"); } catch (e) {}
    try {
      if (api && api.tabs && api.tabs.create) {
        var r = api.tabs.create({ url: url });
        if (r && r.catch) r.catch(function () {});
        window.close();
        return;
      }
    } catch (e) { /* 落到 window.open */ }
    try { window.open(url, "_blank"); } catch (e2) {}
    try { window.close(); } catch (e3) {}
  }

  var openBtn = $("open");
  if (openBtn) openBtn.addEventListener("click", openManager);

  var closeBtn = $("close");
  if (closeBtn) closeBtn.addEventListener("click", function () { try { window.close(); } catch (e) {} });

  /* Esc 关闭 */
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { try { window.close(); } catch (e2) {} }
  });
})();
