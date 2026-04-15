'use strict';

const chalk = require('chalk');
const prompts = require('prompts');
const config = require('../config');
const { XueqiuClient } = require('../api');
const { getCookiesForDomain } = require('../chrome-cookie');
const { loginWithBrowser } = require('../puppeteer-login');

// 粘贴来的 Cookie 归一化
function normalizeCookie(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/^\s*cookie\s*:\s*/i, '');
  s = s.replace(/[\r\n]+/g, ' ');
  s = s.replace(/\s{2,}/g, ' ');
  s = s.replace(/;+\s*$/g, '');
  return s.trim();
}

function parseCookieKeys(cookie) {
  const out = {};
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function summarizeCookie(cookie) {
  const keys = Object.keys(parseCookieKeys(cookie));
  const keyHints = ['xq_a_token', 'u', 'xq_id_token', 'xq_r_token'];
  const present = keyHints.filter((k) => keys.includes(k));
  return { total: keys.length, keyPresent: present };
}

// 尝试从 Chrome 自动读取
async function tryChrome({ profile }) {
  const { cookies, cookieString } = getCookiesForDomain('xueqiu.com', { profile });
  if (!cookies.length) {
    throw new Error(
      '本地 Chrome 未找到 xueqiu.com 的 Cookie。请先用 Chrome 登录 https://xueqiu.com/ 再试。',
    );
  }
  return cookieString;
}

// 交互粘贴
async function promptPaste() {
  console.log(chalk.gray('从浏览器复制 Cookie：'));
  console.log(chalk.gray('  1) 打开 https://xueqiu.com/ 并登录'));
  console.log(chalk.gray('  2) 开发者工具 → Network → 刷新 → 任选 xueqiu.com 请求'));
  console.log(chalk.gray('  3) Request Headers 里找到 Cookie，整行复制粘贴到这里\n'));
  const resp = await prompts({
    type: 'password',
    name: 'cookie',
    message: '粘贴 Cookie',
    validate: (v) => (v && v.length > 20 ? true : 'Cookie 过短，请确认'),
  });
  return resp.cookie;
}

async function run(opts) {
  const profileName = opts.profile || 'default';

  // 确定获取 cookie 的方式
  let source = 'chrome';
  if (opts.cookie) source = 'explicit';
  else if (opts.browser) source = 'browser';
  else if (opts.manual) source = 'manual';
  else if (opts.fromChrome) source = 'chrome-only';

  let cookie;

  if (source === 'explicit') {
    cookie = opts.cookie;
  } else if (source === 'manual') {
    cookie = await promptPaste();
  } else if (source === 'browser') {
    const useChromeCookies = !opts.browserScan;
    if (useChromeCookies) {
      console.log(chalk.gray('启动 Puppeteer 浏览器并复用本地 Chrome 登录态...'));
    } else {
      console.log(chalk.gray('启动 Puppeteer 浏览器窗口，请在其中完成登录...'));
    }
    const timeoutMs = opts.browserTimeout ? Number(opts.browserTimeout) * 1000 : undefined;
    cookie = await loginWithBrowser({
      executablePath: opts.chromePath,
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      freshProfile: !!opts.freshProfile,
      useChromeCookies,
      chromeProfile: opts.chromeProfile,
      onProgress: (msg) => console.log(chalk.gray('  ' + msg)),
    });
    console.log(chalk.green('✔ 浏览器登录完成，已提取 Cookie'));
  } else {
    // chrome 或 chrome-only：尝试 Chrome 自动读取
    try {
      console.log(chalk.gray('正在从 Chrome 读取 Cookie（可能会弹出 Keychain 授权框）...'));
      cookie = await tryChrome({ profile: opts.chromeProfile });
      console.log(chalk.green('✔ 已从 Chrome 读取到 Cookie'));
    } catch (err) {
      if (source === 'chrome-only') {
        console.error(chalk.red('从 Chrome 读取失败：' + err.message));
        process.exit(1);
      }
      console.warn(chalk.yellow('⚠ 自动读取 Chrome 失败，改为手动粘贴模式：'));
      console.warn(chalk.gray('  ' + err.message.split('\n')[0]));
      console.log('');
      cookie = await promptPaste();
    }
  }

  cookie = normalizeCookie(cookie);
  if (!cookie) {
    console.error(chalk.red('未获得 Cookie，已取消。'));
    process.exit(1);
  }

  const summary = summarizeCookie(cookie);
  const missing = ['xq_a_token', 'u', 'xq_id_token'].filter((k) => !summary.keyPresent.includes(k));
  if (missing.length) {
    console.warn(chalk.yellow(`⚠ 未检测到关键字段 [${missing.join(', ')}]，可能会登录失败。继续尝试...`));
  } else {
    console.log(chalk.gray(`  识别到 ${summary.total} 个 cookie 字段（含 ${summary.keyPresent.join(', ')}）`));
  }

  let userInfo;
  try {
    const client = new XueqiuClient({ cookie });
    userInfo = await client.whoami();
  } catch (err) {
    console.error(chalk.red('Cookie 校验失败：' + err.message));
    console.error(chalk.gray('常见原因：Cookie 过期 / 缺 xq_id_token / 复制不完整'));
    process.exit(1);
  }

  if (!userInfo || !userInfo.id) {
    console.error(chalk.red('Cookie 校验失败：返回内容不含用户信息'));
    console.error(JSON.stringify(userInfo, null, 2));
    process.exit(1);
  }

  config.setProfile(profileName, {
    cookie,
    user_id: userInfo.id,
    screen_name: userInfo.screen_name || userInfo.name || '',
    source, // 记录来源，方便后续诊断
  });
  const cfg = config.read();
  cfg.current = profileName;
  config.write(cfg);

  const label = userInfo.screen_name || userInfo.name;
  console.log(
    chalk.green(
      `✔ 登录成功：${label ? `${label}（id=${userInfo.id}）` : `id=${userInfo.id}`}，已保存到 profile "${profileName}"`,
    ),
  );
  console.log(chalk.gray(`配置文件：${config.CONFIG_FILE}`));
}

module.exports = { run };
