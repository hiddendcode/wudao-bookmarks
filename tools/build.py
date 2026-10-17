"""组装并打包扩展：src/common + src/<browser> 覆盖合并 -> dist/ 中文命名产物。
ZIP 条目名强制正斜杠（AMO 校验要求），打包后自验证。"""
import json
import os
import shutil
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist")
TMP = os.path.join(ROOT, ".build_tmp")


def get_version():
    with open(os.path.join(SRC, "firefox", "manifest.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def compose(browser, tmp):
    """common 打底，浏览器目录覆盖（manifest.json / background.js / _locales）。"""
    if os.path.exists(tmp):
        shutil.rmtree(tmp)
    shutil.copytree(os.path.join(SRC, "common"), tmp)
    bdir = os.path.join(SRC, browser)
    for root, _dirs, files in os.walk(bdir):
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), bdir)
            dst = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(root, name), dst)


def pack(src_dir, out_path):
    if os.path.exists(out_path):
        os.remove(out_path)
    count = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(src_dir):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, src_dir).replace(os.sep, "/")
                z.write(full, rel)
                count += 1
    with zipfile.ZipFile(out_path) as z:
        names = z.namelist()
        bad = [n for n in names if "\\" in n]
        assert not bad, f"backslash entries: {bad[:3]}"
        assert "manifest.json" in names, "manifest.json not at root"
    print(f"  {count} files -> {out_path}")


def main():
    version = get_version()
    os.makedirs(DIST, exist_ok=True)
    targets = {
        "firefox": f"悟道书签管理器-浏览器扩展-firefox_{version}.xpi",
        "chrome": f"悟道书签管理器-浏览器扩展-chrome-edge_{version}.zip",
    }
    for browser, name in targets.items():
        print(f"[build] {browser}")
        compose(browser, TMP)
        pack(TMP, os.path.join(DIST, name))
    shutil.rmtree(TMP, ignore_errors=True)
    print(f"done, version {version}")


if __name__ == "__main__":
    main()
