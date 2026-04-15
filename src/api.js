'use strict';

const axios = require('axios');
const { toQuoteSymbol, normalizeSymbol } = require('./symbol');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class XueqiuClient {
  constructor({ cookie, userAgent, timeout } = {}) {
    if (!cookie) throw new Error('未提供 Cookie，请先执行 `xueqiu login`');
    this.cookie = cookie;
    this.userAgent = userAgent || USER_AGENT;

    this.http = axios.create({
      timeout: timeout || 15000,
      withCredentials: true,
      // 允许所有 4xx/5xx 进入统一错误处理
      validateStatus: () => true,
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cookie': this.cookie,
      },
    });
  }

  _referer(cube) {
    return cube ? `https://xueqiu.com/P/${cube}` : 'https://xueqiu.com/';
  }

  async _request(method, url, { params, data, headers, cube } = {}) {
    const res = await this.http.request({
      method,
      url,
      params,
      data,
      headers: {
        'Referer': this._referer(cube),
        'Origin': 'https://xueqiu.com',
        ...(headers || {}),
      },
    });
    if (res.status >= 400) {
      const err = new Error(
        `[${method} ${url}] HTTP ${res.status}: ${describeBody(res.data)}`
      );
      err.status = res.status;
      err.body = res.data;
      throw err;
    }
    // 雪球一些接口即使 200 也用 error_code 表达失败
    if (res.data && typeof res.data === 'object') {
      const ec = res.data.error_code ?? res.data.errorCode;
      if (ec && ec !== 0 && ec !== '0') {
        const desc = res.data.error_description || res.data.errorDesc || res.data.message || 'unknown';
        const err = new Error(`雪球 API 错误 [${ec}]: ${desc}`);
        err.status = res.status;
        err.body = res.data;
        throw err;
      }
    }
    return res.data;
  }

  // 校验登录：本地解析 xq_id_token（JWT），不再依赖远程端点。
  // 旧的 https://xueqiu.com/user/current.json 已被雪球下线（404）。
  // JWT 已包含 uid 与 exp，足以判断"是否登录 + 是否过期"；
  // 服务端吊销等问题会在首次真正调用业务接口时自然暴露。
  async whoami() {
    const jar = parseCookieKeys(this.cookie);
    const token = jar.xq_id_token;
    if (!token) {
      throw new Error('Cookie 中未找到 xq_id_token，请确认已登录雪球后再重试');
    }
    const payload = decodeJwtPayload(token);
    if (!payload || !payload.uid) {
      throw new Error('xq_id_token 格式异常，无法解析出 uid');
    }
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      const d = new Date(payload.exp * 1000).toLocaleString();
      throw new Error(`xq_id_token 已于 ${d} 过期，请重新登录雪球后再运行 xueqiu login`);
    }
    return {
      id: payload.uid,
      screen_name: payload.cn || payload.screen_name || payload.name || '',
    };
  }

  // 获取单只股票行情（含 current 价格、股票 id 等）
  // 注意：雪球行情接口对港股期望裸代码（00135，不带 HK 前缀），这里统一在入口转换。
  async stockQuote(symbol) {
    const quoteSym = toQuoteSymbol(symbol);
    const data = await this._request(
      'GET',
      'https://stock.xueqiu.com/v5/stock/quote.json',
      { params: { symbol: quoteSym, extend: 'detail' } }
    );
    const quote = data?.data?.quote;
    if (!quote) throw new Error(`获取行情失败: ${symbol}`);
    return quote;
  }

  // 按代码搜索一只股票，返回 { stock_id, name, code, ind_name, ind_color, ... }。
  // 用于「首次添加新股票到组合」时补齐 stock_id / ind_* 字段（batchQuote 接口不返回 stock_id）。
  // 接口：/stock/search.json?code=<裸码>  对港股用 00700/09988，A 股用 SH600519/SZ000001，美股用 AAPL。
  async searchStock(symbol) {
    const quoteSym = toQuoteSymbol(symbol);
    const data = await this._request(
      'GET',
      'https://xueqiu.com/stock/search.json',
      { params: { code: quoteSym, size: 5 } }
    );
    const list = data?.stocks || [];
    // 精确匹配：code 完全相等优先
    const exact = list.find((s) => String(s.code) === String(quoteSym));
    const picked = exact || list[0];
    if (!picked) throw new Error(`未找到股票: ${symbol}`);
    return picked;
  }

  // 批量行情
  async batchQuote(symbols) {
    if (!symbols || !symbols.length) return {};
    // 入参规范化（SH/SZ/HK 前缀），调用 API 时再转成接口要求的格式
    const canonList = symbols.map((s) => normalizeSymbol(s));
    const quoteList = canonList.map((s) => toQuoteSymbol(s));
    const quoteToCanon = new Map();
    canonList.forEach((c, i) => quoteToCanon.set(quoteList[i], c));

    const data = await this._request(
      'GET',
      'https://stock.xueqiu.com/v5/stock/batch/quote.json',
      { params: { symbol: quoteList.join(',') } }
    );
    const list = data?.data?.items || [];
    const map = {};
    for (const it of list) {
      const q = it.quote || it;
      if (!q || !q.symbol) continue;
      // API 返回的 symbol 是接口格式（港股裸代码），映射回我们内部的规范格式
      const canon = quoteToCanon.get(q.symbol) || q.symbol;
      map[canon] = q;
    }
    return map;
  }

  // 获取组合信息 + 当前持仓
  // 端点 1: /cubes/quote.json  → 元信息（name/net_value/daily_gain 等）
  // 端点 2: /cubes/rebalancing/current.json  → last_rb.holdings 才是真实当前持仓
  // 雪球 2024 年后把持仓从端点 1 移到了端点 2，这里合并两者。
  async cubeQuote(cubeSymbol) {
    const [metaData, rbData] = await Promise.all([
      this._request('GET', 'https://xueqiu.com/cubes/quote.json',
        { params: { code: cubeSymbol, return_hasexist: 'false' }, cube: cubeSymbol })
        .catch((err) => { throw err; }),
      this._request('GET', 'https://xueqiu.com/cubes/rebalancing/current.json',
        { params: { cube_symbol: cubeSymbol }, cube: cubeSymbol })
        .catch((err) => {
          // current.json 未登录/无权限时会抛；先返回 null，降级到只有 meta
          if (process.env.XUEQIU_DEBUG) console.error('[debug] current.json 失败:', err.message);
          return null;
        }),
    ]);

    // 解析元信息（可能是 {ZH123456: {...}} 或数组）
    let meta = null;
    if (Array.isArray(metaData)) meta = metaData[0];
    else if (metaData && metaData[cubeSymbol]) meta = metaData[cubeSymbol];
    else if (metaData && metaData.symbol) meta = metaData;
    if (!meta) throw new Error(`未找到组合: ${cubeSymbol}`);

    // 解析持仓（current.json 的 last_rb.holdings 或 last_success_rb.holdings）
    let holdings = [];
    if (rbData) {
      const rb = rbData.last_rb || rbData.last_success_rb || rbData;
      const rawHoldings = rb?.holdings || [];
      holdings = rawHoldings.map((h) => ({
        stock_id: h.stock_id,
        // 规范化 symbol：接口返回的港股是裸代码，内部统一成 HKxxxxx
        stock_symbol: h.stock_symbol ? normalizeSymbol(h.stock_symbol) : h.stock_symbol,
        stock_name: h.stock_name,
        weight: Number(h.weight) || 0,
        segment_name: h.segment_name,
        segment_id: h.segment_id,
        proactive: h.proactive,
        volume: h.volume,
        // 保留原始字段备用
        _raw: h,
      }));
    } else if (meta.view_rebalancing?.holdings) {
      // 兜底：旧端点如果恰好还有 holdings 字段就用
      holdings = meta.view_rebalancing.holdings;
    }

    return { ...meta, holdings };
  }

  // 执行调仓
  // 雪球新版调仓接口期望格式（2024+）：
  //   cube_symbol=ZH123456
  //   cash=<剩余现金权重>
  //   segment=true
  //   holdings=[{stock_id, weight, segment_name, segment_id, stock_name, stock_symbol,
  //             segment_color, proactive, volume, textname, url, price, percent, flag}, ...]
  //   comment=<调仓说明>
  // 注意：holdings 是「调仓后的完整目标持仓」而非增量，未变动的股票也要提交（proactive:false）
  async rebalance(cubeSymbol, { holdings, cash, comment } = {}) {
    if (!Array.isArray(holdings)) throw new Error('holdings 必须是数组');
    if (cash == null) throw new Error('缺少 cash 参数');

    const form = new URLSearchParams();
    form.append('cube_symbol', cubeSymbol);
    form.append('cash', String(cash));
    form.append('segment', 'true');
    form.append('holdings', JSON.stringify(holdings));
    form.append('comment', comment || '');

    // 注意：这个接口不能走统一 _request 的 error_code 抛错逻辑——
    // 雪球会在「实际调仓成功」的情况下也返回非零 error_code（如 20842 "unknown"），
    // 把这种"软错误"当硬错误抛出会误报失败。
    // 这里自己解析：HTTP 4xx/5xx 才真抛；HTTP 200 一律返回，带 warning 标记供上层决策。
    const res = await this.http.request({
      method: 'POST',
      url: 'https://xueqiu.com/cubes/rebalancing/create.json',
      data: form.toString(),
      headers: {
        'User-Agent': this.userAgent,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Cookie': this.cookie,
        'Origin': 'https://xueqiu.com',
        // 新版调仓弹窗的专用 Referer；用旧的 /P/ZHxxx 会被 10020 拒绝
        'Referer': `https://xueqiu.com/p/update?action=holdings&symbol=${cubeSymbol}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (res.status >= 400) {
      const err = new Error(
        `[POST /cubes/rebalancing/create.json] HTTP ${res.status}: ${describeBody(res.data)}`
      );
      err.status = res.status;
      err.body = res.data;
      throw err;
    }

    const data = res.data;
    if (data && typeof data === 'object') {
      const ec = data.error_code ?? data.errorCode;
      if (ec && ec !== 0 && ec !== '0') {
        const desc = data.error_description || data.errorDesc || data.message || 'unknown';
        // 不抛错，用 _warning 字段告诉上层：服务端回了警告，但请求已送达
        return { ...data, _warning: `error_code=${ec} description="${desc}"` };
      }
    }
    return data;
  }
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function parseCookieKeys(cookie) {
  const out = {};
  for (const part of String(cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function describeBody(data) {
  try {
    if (typeof data === 'string') return data.slice(0, 200);
    return JSON.stringify(data).slice(0, 400);
  } catch (_) {
    return '<unparseable>';
  }
}

module.exports = { XueqiuClient, USER_AGENT };
