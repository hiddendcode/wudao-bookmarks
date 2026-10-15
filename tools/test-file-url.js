/* 悟道书签管理器 · file:// 链接处理逻辑自测
 * ---------------------------------------------------------------
 * manager.js 是个 1800 多行、强依赖 DOM 的文件，整体跑不动。
 * 但"本地文件链接"这段逻辑是自包含的，所以这里把它从源文件里**原样切出来**，
 * 放进一个假的浏览器环境里跑 —— 测的是真正要发布的那段代码文本，不是副本。
 *
 * 跑法：  node tools\test-file-url.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'common', 'manager.js'), 'utf8');

/* 用两个稳定的标记把这一段切出来 */
const START = '/* ---------- 本地文件（file://）链接的访问权限';
const END = 'const uid = p =>';
const i = SRC.indexOf(START);
const j = SRC.indexOf(END);
if (i < 0 || j < 0 || j <= i) {
  console.error('✗ 提取失败：manager.js 里的定位标记找不到了，请检查文件是否被大改');
  process.exit(1);
}
const BLOCK = SRC.slice(i, j);
if (!BLOCK.includes('function openFileUrl') || !BLOCK.includes('function checkFileAccess')) {
  console.error('✗ 提取到的代码块不完整');
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('   \u2713 ' + name); }
  else { fail++; console.log('   \u2717 ' + name + (extra ? '   -> ' + extra : '')); }
}

function makeEnv(opts) {
  opts = opts || {};
  const log = { toasts: [], created: [], queries: 0 };

  const chrome = {
    runtime: {},
    tabs: {
      create: o => {
        if (opts.tabsThrows) throw new Error('tabs.create 炸了');
        log.created.push(o && o.url);
        return Promise.resolve();
      }
    }
  };
  if (opts.fileAccess !== undefined) {
    chrome.extension = {
      isAllowedFileSchemeAccess: cb => { log.queries++; cb(opts.fileAccess); return undefined; }
    };
  }
  if (opts.fileAccessPromise !== undefined) {
    chrome.extension = {
      isAllowedFileSchemeAccess: () => { log.queries++; return Promise.resolve(opts.fileAccessPromise); }
    };
  }

  const sandbox = {
    console, Promise,
    window: { open: () => (opts.windowOpenFails ? null : {}) },
    toast: (msg, type) => { log.toasts.push({ msg: String(msg), type: type }); }
  };
  sandbox.chrome = chrome;
  sandbox.globalThis = sandbox;
  /* 模拟 Firefox：只要存在 browser.runtime，代码就按 Firefox 处理；
     真实 Firefox 里 browser.tabs 也是有的，所以要一起给上 */
  if (opts.withFirefoxNamespace) {
    const b = { runtime: {}, tabs: chrome.tabs };
    if (opts.geckoPerm !== undefined) {
      b.permissions = { contains: () => { log.queries++; return Promise.resolve(opts.geckoPerm); } };
    }
    sandbox.browser = b;
  }
  vm.createContext(sandbox);
  /* 注意：const/let 声明不会挂成 global 的属性，所以显式导出一份句柄出来 */
  vm.runInContext(
    BLOCK + '\n;globalThis.__api = { isFileUrl, checkFileAccess, openFileUrl, openUrlAnywhere, fileAccess: function () { return _fileAccess; } };',
    sandbox
  );
  return { sandbox, api: sandbox.__api, log };
}

const FILE = 'file:///D:/web/tools/';
const flush = async (n = 4) => { for (let k = 0; k < n; k++) await new Promise(r => setImmediate(r)); };

(async () => {

console.log('\n[1] isFileUrl 识别正确');
{
  const { api } = makeEnv({ fileAccess: true });
  check('file:///D:/web/tools/ 认出来了', api.isFileUrl(FILE) === true);
  check('file:// 开头大小写都能认', api.isFileUrl('FILE:///d:/x') === true);
  check('https 不会误判', api.isFileUrl('https://example.com') === false);
  check('空值不会崩', api.isFileUrl(null) === false && api.isFileUrl(undefined) === false);
}

console.log('\n[2] 没授权（Chrome 默认）→ 必须给出可操作的提示，而不是静默失败');
{
  const { api, log } = makeEnv({ fileAccess: false });
  api.openFileUrl(FILE);
  check('没有尝试开标签页', log.created.length === 0, JSON.stringify(log.created));
  check('弹出了提示', log.toasts.length === 1, JSON.stringify(log.toasts));
  const t = log.toasts[0] || {};
  check('提示里说明了去哪儿打开开关', /允许访问文件网址/.test(t.msg), t.msg);
  check('提示里给了 chrome://extensions 路径', /chrome:\/\/extensions/.test(t.msg), t.msg);
  check('用的是 warn 级别', t.type === 'warn', t.type);
}

console.log('\n[3] 已授权 → 正常打开');
{
  const { api, log } = makeEnv({ fileAccess: true });
  api.openFileUrl(FILE);
  check('用 tabs.create 打开了这个 URL', log.created[0] === FILE, JSON.stringify(log.created));
  check('没有多余的提示', log.toasts.length === 0);
}

console.log('\n[4] 没有这个 API（Firefox 形态）→ 放行，不能挡路');
{
  const { api, log } = makeEnv({});   // 不提供 chrome.extension
  api.openFileUrl(FILE);
  check('直接尝试打开', log.created[0] === FILE, JSON.stringify(log.created));
  check('没有弹误报的提示', log.toasts.length === 0);
}

console.log('\n[5] 权限结果会缓存，不会每次点击都问一遍');
{
  const { api, log } = makeEnv({ fileAccess: false });
  api.openFileUrl(FILE);
  api.openFileUrl(FILE);
  api.openFileUrl(FILE);
  check('只查询了 1 次', log.queries === 1, 'queries=' + log.queries);
  check('三次点击都给了提示', log.toasts.length === 3, 'toasts=' + log.toasts.length);
}

console.log('\n[6] 支持 Promise 形态的 isAllowedFileSchemeAccess');
{
  const { sandbox, api, log } = makeEnv({});
  sandbox.chrome.extension = { isAllowedFileSchemeAccess: () => Promise.resolve(true) };
  api.openFileUrl(FILE);
  await flush();                       // Promise 形态要等一个微任务才会落定
  check('Promise 形态也放行', log.created[0] === FILE, JSON.stringify(log.created));
}

console.log('\n[7] tabs.create 抛异常时不能让点击崩掉');
{
  const { api, log } = makeEnv({ fileAccess: true, tabsThrows: true, windowOpenFails: true });
  let threw = null;
  try { api.openFileUrl(FILE); } catch (e) { threw = e; }
  check('异常没有逃出来', threw === null, threw && threw.message);
  check('退回提示告诉用户打不开', log.toasts.length >= 1, JSON.stringify(log.toasts));
}

console.log('\n[8] Firefox 下不能弹 Chromium 专属的提示（那边根本没有那个开关）');
{
  /* 故意让那个 Chromium 专属 API 存在并返回 false —— 即使如此，Firefox 也必须走自己的分支，
     因为 Firefox 界面上没有「允许访问文件网址」，提示只会误导用户。 */
  const { api, log } = makeEnv({ withFirefoxNamespace: true, fileAccess: false });
  api.openFileUrl(FILE);
  check('仍然尝试打开（没有被错误拦下）', log.created[0] === FILE, JSON.stringify(log.created));
  check('没有弹出 chrome://extensions 的误导提示', log.toasts.length === 0, JSON.stringify(log.toasts));
}

console.log('\n[9] Firefox 走「可选权限」分支：permissions.contains(file:///*)');
{
  const { api, log } = makeEnv({ withFirefoxNamespace: true, geckoPerm: true });
  api.openFileUrl(FILE);
  await flush();
  check('已授权 → 正常打开', log.created[0] === FILE, JSON.stringify(log.created));
  check('没有多余提示', log.toasts.length === 0);
}
{
  const { api, log } = makeEnv({ withFirefoxNamespace: true, geckoPerm: false });
  api.openFileUrl(FILE);
  await flush();
  check('未授权 → 不开标签页', log.created.length === 0, JSON.stringify(log.created));
  const t = log.toasts[0] || {};
  check('弹出了提示', log.toasts.length === 1, JSON.stringify(log.toasts));
  check('提示指向 about:addons 的「权限与数据」', /about:addons/.test(t.msg) && /权限与数据/.test(t.msg), t.msg);
  check('提示说的是「访问您计算机上的本地文件」', /访问您计算机上的本地文件/.test(t.msg), t.msg);
  check('提示里没有出现 chrome://extensions', !/chrome:\/\/extensions/.test(t.msg), t.msg);
}

console.log('\n' + '='.repeat(56));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(56) + '\n');
process.exit(fail === 0 ? 0 : 1);

})();
