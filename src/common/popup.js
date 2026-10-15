/* 悟道书签管理器 · 备用弹窗脚本（外链，避免被 MV3 的 script-src 'self' 拦截）
 * 正常情况下单击图标会开侧边栏 / 独立窗口；这个弹窗是备用入口。
 */
(function () {
  var btn = document.getElementById("openTab");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var api = (typeof browser !== "undefined" && browser.runtime) ? browser
            : ((typeof chrome !== "undefined" && chrome.runtime) ? chrome : null);
    var url = (api && api.runtime && api.runtime.getURL) ? api.runtime.getURL("manager.html") : "manager.html";
    try {
      if (api && api.tabs && api.tabs.create) {
        var r = api.tabs.create({ url: url });
        if (r && r.catch) r.catch(function () { window.open(url, "_blank"); });
        return;
      }
    } catch (e) { /* 落到 window.open */ }
    window.open(url, "_blank");
  });
})();
