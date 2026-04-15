#!/usr/bin/env node
'use strict';

/**
 * 抓接口 v2：把 CLI 当前 profile 的 Cookie 注入 Puppeteer，
 * 打开组合页面，监听所有请求/响应。
 *
 * 用法：
 *   node tools/capture-api.js ZH3491131 [--keep-open=15] [--headless]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');
const { findLocalChrome } = require('../src/puppeteer-login');
const { findCookieDb } = require('../src/chrome-cookie');

const args = process.argv.slice(2);
const CUBE = args.find((a) => !a.startsWith('-')) || 'ZH3491131';
const HEADLESS = args.includes('--headless');
const KEEP_OPEN = (() => {
  const m = args.find((a) => a.startsWith('--keep-open='));
  return m ? Number(m.split('=')[1]) : 15;
})();

const OUT = path.join(__dirname, `capture-${CUBE}-${Date.now()}.json`);

// 放宽过滤：只排除静态资源和 WAF 脚本
function interesting(url) {
  if (!/^https?:\/\/(?:[\w.-]+)?xueqiu\.com/.test(url)) return false;
  if (/\.(png|jpg|jpeg|webp|gif|svg|ico|css|woff2?)(\?|$)/i.test(url)) return false;
  return true;
}

function short(s, n = 3000) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? str.slice(0, n) + '...<+' + (str.length - n) + '>' : str;
}

function parseCookieString(cookieStr) {
  const out = [];
  for (const part of cookieStr.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    // HTTPS 站点对 secure=false 的 cookie 会拒绝。雪球关键 cookie 都是 secure。
    out.push({
      name,
      value,
      domain: '.xueqiu.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'Lax',
    });
  }
  return out;
}

function cloneChromeCookies(targetProfileDir) {
  const src = findCookieDb();
  if (!src) return { ok: false, reason: '未找到 Chrome Cookies DB' };
  const defaultDir = path.join(targetProfileDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  try {
    fs.copyFileSync(src, path.join(defaultDir, 'Cookies'));
    for (const ext of ['-journal', '-wal', '-shm']) {
      const s = src + ext;
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(defaultDir, 'Cookies' + ext));
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (process.platform !== 'darwin') {
    const chromeRoot = path.dirname(path.dirname(src));
    const srcLS = path.join(chromeRoot, 'Local State');
    if (fs.existsSync(srcLS)) {
      try { fs.copyFileSync(srcLS, path.join(targetProfileDir, 'Local State')); } catch (_) {}
    }
  }
  return { ok: true, src };
}

(async () => {
  const chromePath = findLocalChrome();
  if (!chromePath) { console.error('找不到本地 Chrome'); process.exit(1); }

  // 用独立的临时 profile 目录，装入克隆自主 Chrome 的 Cookies DB
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'xueqiu-capture-'));
  const cloned = cloneChromeCookies(PROFILE);
  if (!cloned.ok) { console.error('克隆 Chrome Cookies 失败:', cloned.reason); process.exit(1); }
  console.log('克隆 Cookies 来源:', cloned.src);
  console.log('临时 profile:', PROFILE);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: HEADLESS ? 'new' : false,
    userDataDir: PROFILE,
    defaultViewport: null,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const captures = [];
  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    // 记录所有 request（包括失败的/被拦的）
    page.on('request', (req) => {
      const url = req.url();
      if (!interesting(url)) return;
      captures.push({
        phase: 'request',
        method: req.method(),
        url,
        reqPost: req.postData() ? short(req.postData(), 800) : '',
        resourceType: req.resourceType(),
      });
    });

    page.on('response', async (res) => {
      try {
        const req = res.request();
        const url = req.url();
        if (!interesting(url)) return;
        const status = res.status();
        const contentType = (res.headers() || {})['content-type'] || '';
        let body = '';
        if (/json|text|javascript|html/.test(contentType) && status < 400 && req.resourceType() !== 'document') {
          try { body = await res.text(); } catch (_) {}
        } else if (status >= 400) {
          try { body = await res.text(); } catch (_) {}
        }
        captures.push({
          phase: 'response',
          method: req.method(),
          url,
          status,
          contentType,
          resourceType: req.resourceType(),
          bodyPreview: short(body, 4000),
        });
        // 只在有 body 或状态异常时打印
        if (body || status >= 400) {
          console.log(`[${req.method()} ${status}] ${url}`);
          if (body) console.log('   <-', short(body, 300));
        }
      } catch (_) {}
    });

    const target = `https://xueqiu.com/P/${CUBE}`;
    console.log('\n→', target);
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('DOM 加载完成');
    } catch (e) {
      console.log('goto 警告:', e.message);
    }

    // 滚一下页面诱发持仓区域渲染
    try {
      await page.evaluate(() => {
        window.scrollTo(0, 400);
        setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 1500);
      });
    } catch (_) {}

    console.log(`等待 ${KEEP_OPEN}s ...`);
    await new Promise((r) => setTimeout(r, KEEP_OPEN * 1000));

    // 抓 DOM 中 SSR 出来的数据（常见有 window.SNB.cubeInfo 等）
    try {
      const dumped = await page.evaluate(() => {
        const out = {};
        try {
          if (window.SNB) {
            const snb = window.SNB;
            for (const k of ['cubeInfo', 'stocks', 'holdings', 'config']) {
              if (snb[k] !== undefined) out['SNB.' + k] = snb[k];
            }
          }
        } catch (_) {}
        try {
          const el = document.getElementById('renderData');
          if (el) out.renderData = el.textContent;
        } catch (_) {}
        // 扫描脚本标签
        try {
          for (const s of Array.from(document.scripts)) {
            const t = s.textContent || '';
            const m = t.match(/SNB\.cubeInfo\s*=\s*(\{[\s\S]*?\});/);
            if (m) { out['script.SNB.cubeInfo'] = m[1]; break; }
          }
        } catch (_) {}
        return out;
      });
      if (Object.keys(dumped).length) {
        captures.push({ phase: 'dom', dumped });
        console.log('\nDOM dumped keys:', Object.keys(dumped));
      }
    } catch (e) { console.log('dump 失败:', e.message); }

    // 截图
    try {
      const shot = path.join(__dirname, `shot-${CUBE}-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      console.log('截图:', shot);
    } catch (_) {}
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  fs.writeFileSync(OUT, JSON.stringify(captures, null, 2));
  console.log(`\n✔ 保存 ${captures.length} 条到 ${OUT}`);

  const agg = new Map();
  for (const c of captures) {
    if (!c.url) continue;
    const key = `${c.method} ${c.url.split('?')[0]}`;
    agg.set(key, (agg.get(key) || 0) + 1);
  }
  console.log('\nURL 汇总:');
  for (const [k, v] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`  ${String(v).padStart(3)}x  ${k}`);
  }
})().catch((err) => { console.error('Fatal:', err); process.exit(1); });
