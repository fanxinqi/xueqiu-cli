'use strict';

/**
 * 从本地 Chrome Cookies 数据库读取并解密指定域名的 Cookie（仅 macOS）。
 *
 * 原理：
 *   - Chrome 80+ 使用 Keychain 里的 "Chrome Safe Storage" 作为加密口令
 *   - PBKDF2(password, salt="saltysalt", iter=1003, len=16, sha1) 生成 AES 密钥
 *   - encrypted_value 格式：v10/v11 前缀(3B) + nonce(16B) + IV(16B) + AES-128-CBC 密文
 *   - 兜底：无 nonce 的旧格式（IV = 16 空格）
 *
 * 依赖：macOS 自带 `sqlite3` 和 `security` 命令 + Node.js 原生 crypto，不引第三方依赖。
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

function chromeProfileDbPaths() {
  const base = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
  // Default + 最多 9 个 Profile 目录
  const profiles = ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4', 'Profile 5'];
  return profiles.map((p) => path.join(base, p, 'Cookies'));
}

function findCookieDb(preferred) {
  const paths = chromeProfileDbPaths();
  if (preferred) {
    const explicit = path.isAbsolute(preferred)
      ? preferred
      : path.join(os.homedir(), 'Library/Application Support/Google/Chrome', preferred, 'Cookies');
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`指定的 Chrome profile 不存在: ${explicit}`);
  }
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

function getChromeDecryptionKey() {
  let password;
  try {
    password = execSync(
      'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (err) {
    throw new Error(
      '无法从 macOS Keychain 读取 Chrome 加密密钥。\n' +
        '  · 确认已安装 Chrome\n' +
        '  · 系统弹出授权框时选择"始终允许"\n' +
        '  · 原始错误：' + (err.stderr?.toString() || err.message),
    );
  }
  // Chromium 源码常量：salt "saltysalt"，迭代 1003，长度 16
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function decryptCookieValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length === 0) return '';

  const prefix = encryptedValue.slice(0, 3).toString('ascii');

  if (prefix === 'v10' || prefix === 'v11') {
    const afterPrefix = encryptedValue.slice(3);

    // 主格式："v10" + nonce(16) + IV(16) + AES-128-CBC 密文
    if (afterPrefix.length > 32) {
      try {
        const iv = afterPrefix.slice(16, 32);
        const ciphertext = afterPrefix.slice(32);
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        decipher.setAutoPadding(true);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        const result = decrypted.toString('utf8');
        if (!/[\x00-\x08\x0e-\x1f]/.test(result)) return result;
      } catch (_) { /* 尝试兜底 */ }
    }

    // 兜底：标准 Chromium 旧格式（IV = 16 个空格）
    try {
      const iv = Buffer.alloc(16, 0x20);
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(true);
      let decrypted = decipher.update(afterPrefix);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      const result = decrypted.toString('utf8');
      const clean = result.match(/[\x20-\x7e]{8,}$/);
      if (clean) return clean[0];
      if (!/[\x00-\x08\x0e-\x1f]/.test(result)) return result;
    } catch (_) { /* 放弃 */ }

    return '';
  }

  // 极老版本 Chrome 未加密
  return encryptedValue.toString('utf8');
}

/**
 * 读取指定域名的所有 Cookie。
 * @param {string} domain - 域名，如 "xueqiu.com"（会匹配 .xueqiu.com / xueqiu.com / sub.xueqiu.com）
 * @param {object} [opts]
 * @param {string} [opts.profile] - Chrome profile 目录名（Default / Profile 1 / ...）或绝对路径
 * @returns {{ cookies: Array<{name,value,domain,path,secure}>, cookieString: string }}
 */
function getCookiesForDomain(domain, opts = {}) {
  if (process.platform !== 'darwin') {
    throw new Error(`仅支持 macOS 自动读取 Chrome Cookie（当前平台: ${process.platform}）`);
  }

  const cookieDb = findCookieDb(opts.profile);
  if (!cookieDb) {
    throw new Error(
      '未找到 Chrome Cookies 数据库。请确认已安装并用 Chrome 登录过一次雪球。\n' +
        '  查找路径：~/Library/Application Support/Google/Chrome/{Default,Profile 1,...}/Cookies',
    );
  }

  // Chrome 运行时会锁住原数据库，复制到临时目录再读
  const tmpDb = path.join(os.tmpdir(), `xueqiu_cli_chrome_cookies_${process.pid}_${Date.now()}.db`);
  fs.copyFileSync(cookieDb, tmpDb);
  for (const ext of ['-wal', '-shm']) {
    const src = cookieDb + ext;
    if (fs.existsSync(src)) fs.copyFileSync(src, tmpDb + ext);
  }

  try {
    const key = getChromeDecryptionKey();

    const cleanDomain = String(domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    // 注意：不拼接用户输入到 SQL；这里 cleanDomain 已经过严格清洗（只保留点和字母数字），安全
    if (!/^[a-z0-9.\-]+$/.test(cleanDomain)) {
      throw new Error(`非法域名: ${domain}`);
    }

    const sql =
      `SELECT name, value, hex(encrypted_value), host_key, path, is_secure ` +
      `FROM cookies WHERE host_key LIKE '%${cleanDomain}' ORDER BY name;`;

    const output = execSync(`sqlite3 -separator '|||' "${tmpDb}" "${sql}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }).trim();

    if (!output) return { cookies: [], cookieString: '' };

    const cookies = [];
    const seen = new Map(); // name -> { value, domain }

    for (const line of output.split('\n')) {
      const parts = line.split('|||');
      if (parts.length < 4) continue;
      const [name, plainValue, hexValue, hostKey, cookiePath, isSecure] = parts;

      let value = plainValue || '';
      if (!value && hexValue && hexValue.length > 0) {
        const encBuf = Buffer.from(hexValue, 'hex');
        value = decryptCookieValue(encBuf, key);
      }
      if (!value || /[\x00-\x08\x0e-\x1f\x80-\xff]/.test(value)) continue;

      // 多条同名 cookie：精确域名 > 通配 .domain；同级别保留更长的
      if (seen.has(name)) {
        const prev = seen.get(name);
        const prevIsWild = prev.domain.startsWith('.');
        const curIsWild = hostKey.startsWith('.');
        if (prevIsWild === curIsWild) {
          if (prev.value.length >= value.length) continue;
        } else if (!prevIsWild) {
          continue;
        }
      }
      seen.set(name, { value, domain: hostKey });

      const existIdx = cookies.findIndex((c) => c.name === name);
      if (existIdx >= 0) cookies.splice(existIdx, 1);

      cookies.push({
        name,
        value,
        domain: hostKey,
        path: cookiePath,
        secure: isSecure === '1',
      });
    }

    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    return { cookies, cookieString };
  } finally {
    for (const p of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
  }
}

module.exports = { getCookiesForDomain, findCookieDb, chromeProfileDbPaths };
