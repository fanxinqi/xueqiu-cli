'use strict';

/**
 * 使用 Puppeteer 驱动本地 Chrome 登录雪球并提取 Cookie。
 *
 * 设计：
 *   - 用 puppeteer-core，复用用户已装的 Chrome，不下载 Chromium
 *   - 用独立的 userDataDir（~/.xueqiu-cli/chrome-profile），不影响主 Chrome
 *     也不会与用户主 Chrome 进程冲突
 *   - 默认模式：从用户主 Chrome 的 Cookies 数据库文件直接克隆 → 免扫码
 *     macOS 上 Chrome Keychain key 是机器级共享的，新 profile 能直接解密
 *     Linux/Windows 还要复制 Local State（里面存了加密 key）
 *   - 兜底模式：如果 Chrome 未登录 / 克隆失败，弹窗让用户扫码
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { findCookieDb } = require('./chrome-cookie');

const PROFILE_DIR = path.join(os.homedir(), '.xueqiu-cli', 'chrome-profile');
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const POLL_INTERVAL_MS = 1500;

function findLocalChrome() {
  const byPlatform = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    ],
  };
  const list = byPlatform[process.platform] || [];
  for (const p of list) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

function loadPuppeteer() {
  try {
    return require('puppeteer-core');
  } catch (err) {
    throw new Error(
      '缺少依赖 puppeteer-core。请在项目目录执行：\n' +
        '  npm install puppeteer-core\n' +
        '或重新安装依赖：npm install',
    );
  }
}

function dedupeCookies(cookies) {
  // 同名 cookie：精确域名 > 通配 .domain；同级别保留值更长的
  const seen = new Map();
  for (const c of cookies) {
    if (!c || !c.name || c.value == null || c.value === '') continue;
    const prev = seen.get(c.name);
    if (!prev) {
      seen.set(c.name, c);
      continue;
    }
    const prevIsWild = prev.domain && prev.domain.startsWith('.');
    const curIsWild = c.domain && c.domain.startsWith('.');
    if (prevIsWild === curIsWild) {
      if (String(c.value).length > String(prev.value).length) seen.set(c.name, c);
    } else if (prevIsWild && !curIsWild) {
      seen.set(c.name, c);
    }
  }
  return Array.from(seen.values());
}

function cookiesToString(cookies) {
  return dedupeCookies(cookies)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 把用户主 Chrome 的 Cookies DB 复制到我们自己的 puppeteer profile。
// 这样 puppeteer 启动时自带完整的、加密属性齐全的登录 cookie。
// 返回：{ ok, reason? }
function cloneChromeCookiesInto(profileDir, opts = {}) {
  const srcCookies = findCookieDb(opts.chromeProfile);
  if (!srcCookies) {
    return { ok: false, reason: '未找到 Chrome 的 Cookies 数据库（确认已用 Chrome 登录过雪球）' };
  }

  const defaultDir = path.join(profileDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });

  const dstCookies = path.join(defaultDir, 'Cookies');
  try {
    // Chrome 运行时 Cookies 是锁的，copyFileSync 仍能读出快照
    fs.copyFileSync(srcCookies, dstCookies);
    for (const ext of ['-journal', '-wal', '-shm']) {
      const s = srcCookies + ext;
      if (fs.existsSync(s)) fs.copyFileSync(s, dstCookies + ext);
    }
  } catch (err) {
    return { ok: false, reason: '复制 Chrome Cookies 失败：' + err.message };
  }

  // Linux/Windows: cookie 加密 key 存在 Local State 里，需要一并复制
  // macOS: key 存在 Keychain（机器级，共享），不用处理
  if (process.platform !== 'darwin') {
    // srcCookies = <chromeRoot>/<ProfileName>/Cookies → chromeRoot = 上两级
    const chromeRoot = path.dirname(path.dirname(srcCookies));
    const srcLocalState = path.join(chromeRoot, 'Local State');
    if (fs.existsSync(srcLocalState)) {
      try { fs.copyFileSync(srcLocalState, path.join(profileDir, 'Local State')); } catch (_) {}
    }
  }

  return { ok: true };
}

/**
 * 启动浏览器让用户登录雪球，返回整行 Cookie 字符串。
 * @param {object} [opts]
 * @param {string} [opts.executablePath] 自定义 Chrome 路径
 * @param {number} [opts.timeout] 登录超时（ms），默认 5 分钟
 * @param {boolean} [opts.freshProfile] 丢弃已保存的浏览器 profile，强制全新登录
 * @param {boolean} [opts.useChromeCookies] 从用户主 Chrome 克隆 cookies（默认 true）
 *   true: 直接复用 Chrome 登录态，无需扫码；失败才 fallback 扫码
 *   false: 强制走扫码/账号密码登录流程
 * @param {string} [opts.chromeProfile] Chrome 源 profile 名（Default / "Profile 1" / ...）
 * @param {(msg: string) => void} [opts.onProgress] 进度回调
 * @returns {Promise<string>} Cookie 字符串
 */
async function loginWithBrowser(opts = {}) {
  const {
    executablePath,
    timeout = DEFAULT_LOGIN_TIMEOUT_MS,
    freshProfile = false,
    useChromeCookies = true,
    chromeProfile,
    onProgress = () => {},
  } = opts;

  const puppeteer = loadPuppeteer();

  const chromePath = executablePath || findLocalChrome();
  if (!chromePath) {
    throw new Error(
      '未找到本地 Chrome 可执行文件。\n' +
        '  · 请先安装 Google Chrome（或 Chromium / Edge）\n' +
        '  · 或通过 --chrome-path 显式指定 Chrome 可执行文件路径',
    );
  }

  if (freshProfile && fs.existsSync(PROFILE_DIR)) {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });

  // 尝试从用户主 Chrome 克隆 cookies（核心路径：免扫码）
  let clonedFromChrome = false;
  if (useChromeCookies) {
    const result = cloneChromeCookiesInto(PROFILE_DIR, { chromeProfile });
    if (result.ok) {
      clonedFromChrome = true;
      onProgress('已从本地 Chrome 克隆 Cookies（免扫码）');
    } else {
      onProgress(`克隆 Chrome Cookies 失败：${result.reason}（将回退到扫码登录）`);
    }
  }

  onProgress(`启动浏览器：${chromePath}`);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1100,820',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    onProgress('打开 https://xueqiu.com/ ...');
    await page.goto('https://xueqiu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    if (clonedFromChrome) {
      onProgress('校验登录态...');
    } else {
      onProgress('请在弹出的浏览器窗口内完成登录（支持扫码 / 账号密码 / 短信）...');
    }
    const deadline = Date.now() + timeout;
    let lastHint = 0;

    while (Date.now() < deadline) {
      if (!browser.isConnected()) {
        throw new Error('浏览器被关闭，登录取消');
      }

      // 直接在浏览器里调 /user/current.json，返回真实 user id 才算登录成功
      // （单看 cookie 里有没有 xq_a_token 不够：游客 session 也有）
      let userInfo = null;
      try {
        userInfo = await page.evaluate(async () => {
          try {
            const r = await fetch('https://xueqiu.com/user/current.json', {
              credentials: 'include',
              headers: { 'Accept': 'application/json' },
            });
            if (!r.ok) return null;
            return await r.json();
          } catch (_) { return null; }
        });
      } catch (_) {
        // 页面在跳转/关闭时 evaluate 会失败，忽略
      }

      if (userInfo && typeof userInfo.id === 'number' && userInfo.id > 0) {
        onProgress(`检测到登录：${userInfo.screen_name || userInfo.name}（id=${userInfo.id}），提取 Cookie ...`);
        await sleep(500);
        const finalCookies = await page.cookies('https://xueqiu.com');
        return cookiesToString(finalCookies);
      }

      // 每 30 秒提示一次剩余时间，避免用户觉得卡住
      const elapsed = timeout - (deadline - Date.now());
      if (elapsed - lastHint >= 30000) {
        lastHint = elapsed;
        const remainSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        onProgress(`仍在等待登录...（剩余 ${remainSec}s，关闭窗口可取消）`);
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error('登录超时。请在浏览器中完成登录后重试，或加大 --browser-timeout。');
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = {
  loginWithBrowser,
  findLocalChrome,
  PROFILE_DIR,
  DEFAULT_LOGIN_TIMEOUT_MS,
};
