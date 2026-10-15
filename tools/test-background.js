/* 悟道书签管理器 · background.js 行为自测
 * ---------------------------------------------------------------
 * 用一个假的 chrome/browser API 把 background.js 跑起来，验证两件事：
 *   ① 新加的"在线更新"逻辑在 Chrome 和 Firefox 下都不会抛异常；
 *   ② 原有的单击图标 / 侧边栏 / 快捷键逻辑一点没被影响。
 *
 * 跑法：  node tools\test-background.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'common', 'background.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('   \u2713 ' + name); }
  else { fail++; console.log('   \u2717 ' + name + (extra ? '   -> ' + extra : '')); }
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function makeEnv(opts) {
  opts = opts || {};
  const log = {
    badge: [], title: [], requested: 0, stored: [], tabs: [],
    panelBehavior: 0, onClicked: 0, onCommand: 0
  };
  const L = { installed: [], startup: [], updateAvailable: [] };

  const chrome = {
    runtime: {
      getURL: p => 'chrome-extension://test/' + p,
      onInstalled: { addListener: f => L.installed.push(f) },
      onStartup: { addListener: f => L.startup.push(f) },
      onUpdateAvailable: { addListener: f => L.updateAvailable.push(f) }
    },
    storage: {
      local: {
        get: k => { if (opts.getImpl) return opts.getImpl(k); return Promise.resolve(opts.stored || {}); },
        set: o => { log.stored.push(o); return Promise.resolve(); }
      }
    },
    action: {
      onClicked: { addListener: () => { log.onClicked++; } },
      setBadgeText: o => { log.badge.push(o.text); },
      setBadgeBackgroundColor: o => { log.badgeColor = o.color; },
      setTitle: o => { log.title.push(o.title); }
    },
    i18n: { getMessage: k => (k === 'extActionTitle' ? '悟道书签管理器' : '') },
    sidePanel: {
      setPanelBehavior: () => { log.panelBehavior++; return Promise.resolve(); },
      open: () => Promise.resolve()
    },
    commands: { onCommand: { addListener: () => { log.onCommand++; } } },
    windows: { getLastFocused: () => Promise.resolve({ left: 0, top: 0, width: 1920, height: 1080 }) },
    tabs: {
      create: o => {
        if (opts.tabsThrows) throw new Error('tabs.create 炸了');
        log.tabs.push(o && o.url);
        return Promise.resolve();
      }
    }
  };

  if (opts.withUpdateCheck !== false) {
    chrome.runtime.requestUpdateCheck = () => {
      log.requested++;
      return Promise.resolve({ status: opts.status || 'no_update' });
    };
  }

  const sandbox = { chrome, console, Date, Promise, setTimeout, setInterval, clearInterval, isFinite, Math, JSON };
  sandbox.globalThis = sandbox;
  return { sandbox, log, L };
}

function boot(env) {
  vm.createContext(env.sandbox);
  vm.runInContext(SRC, env.sandbox);
}

(async () => {
  const HOUR = 3600 * 1000;

  console.log('\n[1] Chrome：全新安装（storage 为空）→ 冷启动就该主动查一次');
  {
    const env = makeEnv({ status: 'no_update' });
    boot(env);
    await flush();
    check('调用了 requestUpdateCheck', env.log.requested >= 1, 'requested=' + env.log.requested);
    check('记下了检查时间戳', env.log.stored.some(o => 'wudao_update_checked_at' in o));
    check('无更新时角标保持空', env.log.badge[env.log.badge.length - 1] === '');
  }

  console.log('\n[2] Chrome：有可用更新 → 挂 ↑ 角标提示重启');
  {
    const env = makeEnv({ status: 'update_available' });
    boot(env);
    await flush();
    check('角标出现过 "↑"', env.log.badge.includes('\u2191'), JSON.stringify(env.log.badge));
    check('tooltip 提示重启浏览器生效', env.log.title.some(t => t && t.includes('重启')), JSON.stringify(env.log.title));
    check('角标底色已设置', !!env.log.badgeColor);
  }

  console.log('\n[3] Chrome：6 小时内已查过 → 不再重复请求（不拖慢浏览器）');
  {
    const env = makeEnv({ stored: { wudao_update_checked_at: Date.now() - 1 * HOUR } });
    boot(env);
    await flush();
    check('完全没有发出请求', env.log.requested === 0, 'requested=' + env.log.requested);
  }

  console.log('\n[4] Chrome：超过 6 小时 → 重新请求');
  {
    const env = makeEnv({ stored: { wudao_update_checked_at: Date.now() - 7 * HOUR } });
    boot(env);
    await flush();
    check('重新发出了请求', env.log.requested >= 1, 'requested=' + env.log.requested);
  }

  console.log('\n[5] Chrome：storage.get 走同步(非 Promise)老签名 → 也要能工作');
  {
    const env = makeEnv({ getImpl: () => ({ wudao_update_checked_at: Date.now() - 7 * HOUR }) });
    boot(env);
    await flush();
    check('老签名路径下照样发出请求', env.log.requested >= 1, 'requested=' + env.log.requested);
  }

  console.log('\n[6] Firefox：没有 requestUpdateCheck → 必须静默跳过，不能报错');
  {
    const env = makeEnv({ withUpdateCheck: false });
    let threw = null;
    try { boot(env); await flush(); } catch (e) { threw = e; }
    check('加载与运行都没抛异常', threw === null, threw && threw.message);
    check('一次都没调用更新检查', env.log.requested === 0);
    check('也没有乱动角标', env.log.badge.length === 0, JSON.stringify(env.log.badge));
  }

  console.log('\n[7] 事件接线：onInstalled / onStartup / onUpdateAvailable 都挂上了');
  {
    const env = makeEnv({ stored: { wudao_update_checked_at: Date.now() } }); // 先节流住冷启动
    boot(env);
    await flush();
    check('onInstalled 已注册', env.L.installed.length === 1);
    check('onStartup 已注册', env.L.startup.length === 1);
    check('onUpdateAvailable 已注册', env.L.updateAvailable.length === 1);

    const before = env.log.requested;
    env.L.startup[0]();                 // 模拟"用户打开了浏览器"
    await flush();
    check('浏览器启动会触发更新检查', env.log.requested > before, 'before=' + before + ' after=' + env.log.requested);

    env.L.updateAvailable[0]();         // 模拟"新版本已下载完"
    await flush();
    check('新版本就绪时挂上 ↑ 角标', env.log.badge.includes('\u2191'));

    env.L.installed[0]({ reason: 'update', previousVersion: '1.4.5' });   // 模拟"扩展真的更新完了"
    await flush();
    check('更新生效后角标被清掉', env.log.badge[env.log.badge.length - 1] === '');
  }

  console.log('\n[7b] 更新完成后打开“已更新”提示页（沙拉查词同款行为）');
  {
    const env = makeEnv({ stored: { wudao_update_checked_at: Date.now() } });
    boot(env);
    await flush();
    check('启动阶段不会擅自开标签页', env.log.tabs.length === 0, JSON.stringify(env.log.tabs));

    env.L.installed[0]({ reason: 'update', previousVersion: '1.4.5' });
    await flush();
    check('更新后打开了提示页', env.log.tabs.length === 1, JSON.stringify(env.log.tabs));
    const url = env.log.tabs[0] || '';
    check('打开的是 updated.html', url.includes('updated.html'), url);
    check('带上了旧版本号 ?from=1.4.5', url.includes('from=1.4.5'), url);
  }

  console.log('\n[7c] 首次安装（reason=install）不应打开提示页，免得骚扰新用户');
  {
    const env = makeEnv({ stored: { wudao_update_checked_at: Date.now() } });
    boot(env);
    await flush();
    env.L.installed[0]({ reason: 'install' });
    await flush();
    check('首次安装没有开提示页', env.log.tabs.length === 0, JSON.stringify(env.log.tabs));
  }

  console.log('\n[7d] tabs.create 抛异常时，不能影响书签功能');
  {
    const env = makeEnv({ tabsThrows: true, stored: { wudao_update_checked_at: Date.now() } });
    let threw = null;
    try { boot(env); await flush(); env.L.installed[0]({ reason: 'update', previousVersion: '1.4.5' }); await flush(); }
    catch (e) { threw = e; }
    check('没有把异常抛出来', threw === null, threw && threw.message);
    check('原有 onClicked 仍然注册成功', env.log.onClicked === 1);
  }

  console.log('\n[8] 原有功能没被动过（回归检查）');
  {
    const env = makeEnv({});
    boot(env);
    await flush();
    check('action.onClicked 注册 1 次', env.log.onClicked === 1, 'onClicked=' + env.log.onClicked);
    check('sidePanel.setPanelBehavior 调用 1 次', env.log.panelBehavior === 1, 'panelBehavior=' + env.log.panelBehavior);
    check('commands.onCommand 注册 1 次', env.log.onCommand === 1, 'onCommand=' + env.log.onCommand);
  }

  console.log('\n' + '='.repeat(56));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(56) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();
