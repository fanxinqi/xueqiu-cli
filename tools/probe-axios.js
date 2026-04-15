#!/usr/bin/env node
'use strict';

// 直接用 axios + 主 Chrome 的 cookie 扫一批候选端点，找出能返回 holdings 的那个。

const axios = require('axios');
const { getCookiesForDomain } = require('../src/chrome-cookie');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CUBE = process.argv[2] || 'ZH3491131';

const candidates = [
  // === xueqiu.com 主站，cubes 路径 ===
  `https://xueqiu.com/cubes/quote.json?code=${CUBE}&return_hasexist=false`,
  `https://xueqiu.com/cubes/quote.json?code=${CUBE}&return_hasexist=true`,
  `https://xueqiu.com/cubes/quote.json?code=${CUBE}&return_hasexist=false&extend=view_rebalancing,holdings`,
  `https://xueqiu.com/cubes/nav_daily_all.json?cube_symbol=${CUBE}`,
  `https://xueqiu.com/cubes/rebalancing/current.json?cube_symbol=${CUBE}`,
  `https://xueqiu.com/cubes/rebalancing/history.json?cube_symbol=${CUBE}`,
  `https://xueqiu.com/cubes/rebalancing/history.json?cube_symbol=${CUBE}&count=10&page=1&uid=`,
  `https://xueqiu.com/cubes/rebalancing/history.json?cube_symbol=${CUBE}&count=10&page=1&category=12`,
  `https://xueqiu.com/cubes/history.json?cube_symbol=${CUBE}&count=1`,
  `https://xueqiu.com/service/cube_rebalancing.json?cube_symbol=${CUBE}`,

  // === /P/ 页面相关 ===
  `https://xueqiu.com/P/${CUBE}.json`,
  `https://xueqiu.com/P/${CUBE}/holdings.json`,

  // === 通过 v4/v5 ===
  `https://xueqiu.com/v4/cubes/quote.json?code=${CUBE}&return_hasexist=false`,
  `https://xueqiu.com/v4/cubes/rebalancing/current.json?cube_symbol=${CUBE}`,

  // === xueqiu.com/service ===
  `https://xueqiu.com/service/v5/cubes/quote.json?cube_symbol=${CUBE}`,
  `https://xueqiu.com/service/cubes/rebalancing/current.json?cube_symbol=${CUBE}`,

  // === snowman 新架构 ===
  `https://xueqiu.com/snowman/S/${CUBE}/detail.json`,
  `https://xueqiu.com/snowman/cubes/${CUBE}.json`,
];

(async () => {
  const { cookieString, cookies } = getCookiesForDomain('xueqiu.com');
  console.log(`Cookie: ${cookies.length} 条 (xq_a_token=${cookies.find(c => c.name === 'xq_a_token') ? '✓' : '✗'}, u=${cookies.find(c => c.name === 'u') ? '✓' : '✗'})`);
  console.log();

  const baseHeaders = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': `https://xueqiu.com/P/${CUBE}`,
    'Origin': 'https://xueqiu.com',
    'Cookie': cookieString,
  };

  const found = [];
  for (const url of candidates) {
    try {
      const r = await axios.get(url, { headers: baseHeaders, timeout: 10000, validateStatus: () => true });
      const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      const isJson = text.startsWith('{') || text.startsWith('[');
      const isWafHtml = text.includes('aliyun_waf') || text.includes('alicdn.com/frontend-lib');
      const hasHoldings = /\"weight\"|\"holdings\"|\"stock_symbol\"|00135|00881|00696|02688|02333/.test(text);

      const tag = hasHoldings ? '🎯' : (isJson ? '  ' : (isWafHtml ? 'WF' : '??'));
      const preview = text.slice(0, 180).replace(/\s+/g, ' ');
      console.log(`${tag} [${r.status}] ${url.replace(/https:\/\//, '').slice(0, 90)}`);
      console.log(`   ${preview}`);

      if (hasHoldings) found.push({ url, status: r.status, body: text });
    } catch (e) {
      console.log(`!! ${url} ERR: ${e.message.slice(0, 120)}`);
    }
  }

  console.log('\n=== 找到含持仓的端点 ===');
  for (const f of found) {
    console.log('\n✔', f.url);
    console.log(f.body.slice(0, 2000));
  }
  if (!found.length) console.log('(0 个)');
})();
