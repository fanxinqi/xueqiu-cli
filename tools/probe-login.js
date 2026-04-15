#!/usr/bin/env node
'use strict';

// 在 headless 浏览器里直接 fetch /user/current.json 看登录态是否生效

const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');
const { findLocalChrome } = require('../src/puppeteer-login');
const { findCookieDb } = require('../src/chrome-cookie');

function cloneCookies(target) {
  const src = findCookieDb();
  if (!src) throw new Error('Chrome Cookies DB not found');
  const d = path.join(target, 'Default');
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(src, path.join(d, 'Cookies'));
  for (const ext of ['-journal', '-wal', '-shm']) {
    const s = src + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(d, 'Cookies' + ext));
  }
  if (process.platform !== 'darwin') {
    const chromeRoot = path.dirname(path.dirname(src));
    const ls = path.join(chromeRoot, 'Local State');
    if (fs.existsSync(ls)) fs.copyFileSync(ls, path.join(target, 'Local State'));
  }
}

(async () => {
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'xueqiu-probe-'));
  cloneCookies(PROFILE);
  console.log('profile:', PROFILE);

  const browser = await puppeteer.launch({
    executablePath: findLocalChrome(),
    headless: 'new',
    userDataDir: PROFILE,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // 先 goto 一个简单页面让 cookie jar 绑定到 domain
    await page.goto('https://xueqiu.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => console.log('goto 首页警告:', e.message));

    const endpoints = [
      'https://xueqiu.com/user/current.json',
      'https://xueqiu.com/cubes/quote.json?code=ZH3491131&return_hasexist=false',
      'https://xueqiu.com/cubes/rebalancing/history.json?cube_symbol=ZH3491131&count=1&page=1',
      'https://xueqiu.com/P/ZH3491131/holdings',
      'https://xueqiu.com/service/cube_rebalancing.json?cube_symbol=ZH3491131',
    ];

    for (const url of endpoints) {
      const result = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json, text/plain, */*' } });
          const text = await r.text();
          return { status: r.status, body: text.slice(0, 600) };
        } catch (e) { return { error: e.message }; }
      }, url);
      console.log('---', url);
      console.log(JSON.stringify(result, null, 2));
    }

    // 看看页面内 cookie
    const cookies = await page.cookies('https://xueqiu.com');
    const keyCookies = cookies.filter(c => ['xq_a_token', 'u', 'xq_id_token', 'xq_r_token', 'xqat'].includes(c.name));
    console.log('\n关键 cookie:');
    for (const c of keyCookies) {
      console.log(`  ${c.name}=${String(c.value).slice(0, 30)}... (len=${c.value.length}, domain=${c.domain}, secure=${c.secure}, httpOnly=${c.httpOnly})`);
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
