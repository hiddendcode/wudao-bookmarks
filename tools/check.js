/* 校验 src/<browser>/manifest.json 版本、commands 与本地化键完整性 */
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "src");
for (const d of ["firefox", "chrome"]) {
  const dir = path.join(SRC, d);
  const raw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
  const m = JSON.parse(raw);
  const zhcn = JSON.parse(fs.readFileSync(path.join(dir, "_locales/zh_CN/messages.json"), "utf8"));
  const en = JSON.parse(fs.readFileSync(path.join(dir, "_locales/en/messages.json"), "utf8"));
  const need = [...raw.matchAll(/__MSG_(\w+)__/g)].map(x => x[1]);
  const missing = need.filter(k => !zhcn[k] || !en[k]);
  console.log(d, "version", m.version, "commands:", Object.keys(m.commands || {}).join(","), "missing-msg:", missing.length ? missing.join(",") : "none");
}
