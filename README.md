# 悟道书签管理器

> 完全私有化的本地书签管理器，支持 Chrome / Edge / Firefox。  
> 可视化书签管理、双搜索栏、拖拽整理、去重、导入导出，支持与浏览器书签实时互通。不收集任何用户数据，即插即用。

🌐 **项目主页**：<https://wudaoshuqianguanliqi-0p8rwg6179h.qoder.zone/>  
📥 **下载地址**：[GitHub Releases](https://github.com/hiddendcode/wudao-bookmarks/releases)
📥**Firefox 用户**: [<img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg" width="129" height="45" alt="Get the Firefox Add-on" />](https://addons.mozilla.org/en-US/firefox/addon/%E6%82%9F%E9%81%93%E4%B9%A6%E7%AD%BE%E7%AE%A1%E7%90%86%E5%99%A8/) 

[![GitHub release](https://img.shields.io/github/v/release/hiddendcode/wudao-bookmarks?display_name=tag)](https://github.com/hiddendcode/wudao-bookmarks/releases)
[![GitHub issues](https://img.shields.io/github/issues/hiddendcode/wudao-bookmarks)](https://github.com/hiddendcode/wudao-bookmarks/issues)

---

## 📥 下载安装

前往 [Releases 页面](https://github.com/hiddendcode/wudao-bookmarks/releases) 下载最新版本。

| 浏览器 | 下载格式 | 安装方式 |
| :---: | :---: | :--- |
| Chrome / Edge | `.zip` | 解压后打开 `chrome://extensions/`，开启“开发者模式”，点击“加载已解压的扩展程序”，选择解压目录 |
| Firefox | `.xpi` | 打开 `about:addons`，选择“从文件安装附加组件”；若提示未签名，可使用 `about:debugging#/runtime/this-firefox` 临时加载 |

> 建议始终从 Releases 页面下载，不要直接下载源码压缩包。

---

## 🚀 核心功能

- **可调大小侧边栏**：Chrome / Edge 原生 `sidePanel`，可拖宽、可停靠；Firefox 使用 `sidebar_action`
- **双搜索栏**：上方搜书签（名称 / 网址 / 描述 / 标签），下方选择搜索引擎搜网页，支持百度、Google、Bing 等 40+ 引擎
- **分层分类导航**：一级 / 二级 / 三级文件夹分层换行展示，可手动收起展开，拖拽到分类标签即可跨文件夹移动
- **重复清理**：一键扫描全库重复书签，按网址归并
- **导入导出**：支持本应用备份 JSON、Firefox 书签 JSON、浏览器导出 HTML（Netscape）
- **深浅主题 + 紧凑 / 宽松双密度**
- **本地存储不上传服务器**

## ✨ 新增功能

- **独立空白模式**：新装默认空白独立存储，与浏览器书签完全隔离；可在配置中一键切换为同步模式
- **自定义快捷键**：`1` 切换侧栏 / `2` 新标签页打开 / `/` 聚焦搜索；全局快捷键 `Alt+1` / `Alt+2`
- **像素级图标验证**：`icon.horse` + Yandex 双 CORS 源 + canvas 像素验证，根治图标不显示问题

## 🔒 数据安全

- **独立模式**：数据存在扩展 `storage.local`，不上传任何服务器
- **同步模式**：直接读写浏览器书签，实时互通
- **可随时导出 JSON / HTML 备份**

---

## 🔐 隐私政策

<details>
<summary>点击查看隐私政策与权限说明</summary>

### 数据收集

本扩展不收集任何用户个人数据。

### 数据存储

- 书签数据存储在浏览器本地（`chrome.storage.local` / `localStorage`）
- 不上传到任何服务器

### 权限说明

- `bookmarks`：读写浏览器书签，仅同步模式启用时使用
- `storage`：存储扩展配置和独立模式书签数据
- `sidePanel`：打开侧边栏
- `favicon`：获取网站图标
- `host_permissions`：访问 `icon.horse` / Yandex 等 favicon 服务

### 第三方服务

仅用于获取网站图标：

- `icon.horse`
- `favicon.yandex.net`
- `icons.duckduckgo.com`

为显示网站图标，扩展可能会向上述服务发送目标网站的域名 / URL，但不会发送你的书签标题、文件夹、标签或本地存储内容。

</details>

---

## ☕ 捐助

如果「悟道书签管理器」帮到了你，欢迎请作者喝杯咖啡。捐助完全自愿，不影响任何功能。

| 微信支付 | 支付宝 |
| :---: | :---: |
| <img width="220" src="https://github.com/user-attachments/assets/a81adee3-25d9-4b10-853e-a042d2d3d1cb" alt="微信付款码" /> | <img width="220" src="https://github.com/user-attachments/assets/de3d23fc-0277-4d51-9a71-664cbdcfcb72" alt="支付宝付款码" /> |

---

## ❓ 反馈与建议

如果你遇到问题或有功能建议，欢迎提交 [Issue](https://github.com/hiddendcode/wudao-bookmarks/issues)。

如果这个项目对你有帮助，欢迎点一个 ⭐ Star 支持一下。
