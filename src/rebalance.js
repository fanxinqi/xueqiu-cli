'use strict';

// 调仓核心逻辑：
//   - 从现有持仓（prev_weight）推导差额
//   - 自动补行情（stock_id / price / segment_name）
//   - 合法性校验：权重 [0,100]，总权重 <= 100（雪球允许现金 >= 0）
//   - 生成 rebalancing_histories 数组供 api.rebalance() 使用

const { normalizeSymbol, toQuoteSymbol, guessSegmentName } = require('./symbol');

const EPS = 1e-4;

function roundW(w) {
  // 雪球权重保留 2 位小数
  return Math.round(Number(w) * 100) / 100;
}

// 把 holdings 数组转成 {SH600000: {weight, stock_id, ...}}
function holdingsBySymbol(holdings) {
  const out = {};
  for (const h of holdings || []) {
    const sym = h.stock_symbol || h.symbol;
    if (!sym) continue;
    out[sym] = h;
  }
  return out;
}

// 从传入 targets: [{symbol, weight}] 计算最终的 rebalancing_histories
// currentHoldings: cube.holdings 数组
// options.mode:
//   'replace'   —— targets 描述最终完整持仓，未出现的股票全部清仓
//   'patch'     —— 仅修改指定股票，其他股票保持原 weight
async function buildRebalance({ client, targets, currentHoldings, mode = 'replace' }) {
  if (!Array.isArray(targets)) throw new Error('targets 必须是数组');

  // 归一化输入
  const normTargets = targets.map((t) => {
    if (!t || !t.symbol) throw new Error('target 缺少 symbol');
    const weight = Number(t.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      throw new Error(`target 权重非法: ${t.symbol} = ${t.weight}`);
    }
    return { symbol: normalizeSymbol(t.symbol), weight: roundW(weight) };
  });

  // 合并重复 symbol
  const mergedMap = new Map();
  for (const t of normTargets) {
    if (mergedMap.has(t.symbol)) {
      mergedMap.set(t.symbol, roundW(mergedMap.get(t.symbol) + t.weight));
    } else {
      mergedMap.set(t.symbol, t.weight);
    }
  }

  const prevMap = holdingsBySymbol(currentHoldings);

  // 决定最终目标持仓
  const finalMap = new Map();
  if (mode === 'replace') {
    for (const [sym, w] of mergedMap) finalMap.set(sym, w);
    // replace 模式：原有但未出现的股票 -> weight 0
    for (const sym of Object.keys(prevMap)) {
      if (!finalMap.has(sym)) finalMap.set(sym, 0);
    }
  } else if (mode === 'patch') {
    for (const sym of Object.keys(prevMap)) {
      finalMap.set(sym, roundW(Number(prevMap[sym].weight) || 0));
    }
    for (const [sym, w] of mergedMap) finalMap.set(sym, w);
  } else {
    throw new Error(`未知的调仓模式: ${mode}`);
  }

  // 校验总权重
  let total = 0;
  for (const w of finalMap.values()) total += w;
  if (total > 100 + EPS) {
    throw new Error(`目标总权重超过 100%: ${total.toFixed(2)}%`);
  }

  // 对 finalMap 里所有股票拉实时行情（含清仓的——雪球新版调仓 POST 要求每只都有 price/percent）
  const symbolsNeedQuote = [...finalMap.keys()];
  const quoteMap = symbolsNeedQuote.length ? await client.batchQuote(symbolsNeedQuote) : {};

  // 对「新添加」的股票（prevMap 里没有）逐个调 searchStock 补 stock_id / ind_* 字段
  // batchQuote 接口不返回 stock_id，必须从 /stock/search.json 拿
  const searchMap = {};
  for (const sym of symbolsNeedQuote) {
    if (!prevMap[sym]) {
      try {
        searchMap[sym] = await client.searchStock(sym);
      } catch (err) {
        throw new Error(`无法查询新股票 ${sym}: ${err.message}`);
      }
    }
  }

  // —— 产出 1：rebalancingHistories（仅增量，用于 CLI 预览展示）——
  const rebalancingHistories = [];
  for (const [sym, weight] of finalMap) {
    const prev = prevMap[sym];
    const prevWeight = roundW(Number(prev?.weight) || 0);
    if (Math.abs(prevWeight - weight) < EPS) continue;
    const q = quoteMap[sym];
    const stockId = q?.stock_id ?? prev?.stock_id;
    const name = q?.name ?? prev?.stock_name;
    let price = q?.current ?? q?.last_close ?? prev?._raw?.price ?? prev?.current_price;
    if (price == null && weight === 0 && prev) price = prev._raw?.price ?? prev.current_price ?? 0;
    if (price == null) throw new Error(`获取不到 ${sym} 的价格，无法调仓`);
    rebalancingHistories.push({
      stock_id: stockId,
      stock_symbol: toQuoteSymbol(sym),
      stock_name: name,
      prev_weight: prevWeight,
      weight,
      price: typeof price === 'number' ? price.toFixed(2) : String(price),
    });
  }

  // —— 产出 2：holdings（调仓后的完整目标持仓，POST 真实发送的字段）——
  // 已持仓股票和「首次添加」的股票使用两套不同字段集——浏览器就是这样做的。
  // 首次添加时没有 segment_id / segment_color / volume，用 ind_* 兜底、ind_id=0 让服务端自己查。
  // 清仓（weight=0）规则：已持仓的仍要作为 {weight:0, proactive:true} 提交，服务端据此下单卖出；
  // 新股票的 weight=0 无意义，跳过。
  const targetHoldings = [];
  for (const [sym, weight] of finalMap) {
    const prev = prevMap[sym];
    if (weight <= 0 && !prev) continue;
    const prevRaw = prev?._raw || {};
    const q = quoteMap[sym] || {};
    const searched = searchMap[sym];
    const stockId = q.stock_id ?? prev?.stock_id ?? searched?.stock_id;
    if (!stockId) throw new Error(`找不到 ${sym} 的 stock_id`);
    const name = q.name || prev?.stock_name || searched?.name || sym;
    const quoteSym = toQuoteSymbol(sym);
    let price = q.current ?? q.last_close ?? prevRaw.price;
    if (price == null) throw new Error(`获取不到 ${sym} 的价格，无法调仓`);
    const percent = (q.percent != null) ? Number(q.percent) : Number(prevRaw.percent || 0);
    const chg = (q.chg != null) ? Number(q.chg) : Number(prevRaw.chg || 0);

    const prevWeight = roundW(Number(prev?.weight) || 0);
    const proactive = Math.abs(prevWeight - weight) >= EPS;

    if (prev) {
      // 已持仓：14 字段标准格式（和前端"调整现有股票权重"时一致）
      targetHoldings.push({
        stock_id: stockId,
        weight,
        segment_name: prev.segment_name || prevRaw.segment_name || '',
        segment_id: prev.segment_id ?? prevRaw.segment_id ?? 0,
        stock_name: name,
        stock_symbol: quoteSym,
        segment_color: prevRaw.segment_color || '#cccccc',
        proactive,
        volume: prevRaw.volume ?? prev.volume ?? 0,
        textname: `${name}(${quoteSym})`,
        url: `/S/${quoteSym}`,
        price: Number(price),
        percent: Number.isFinite(percent) ? percent : 0,
        flag: 1,
      });
    } else {
      // 首次添加：参考浏览器"新增股票"的字段集
      // stock_id / ind_name 来自 /stock/search.json
      const s = searchMap[sym] || {};
      const finalStockId = s.stock_id ?? stockId;
      if (!finalStockId) throw new Error(`找不到 ${sym} 的 stock_id`);
      targetHoldings.push({
        chg,
        code: quoteSym,
        current: Number(price),
        flag: s.flag != null ? Number(s.flag) : 1,
        ind_color: s.ind_color || '#cccccc',
        ind_id: s.indId ?? s.ind_id ?? 0, // 搜索接口返回 indId；兜底 0 让服务端自己查
        ind_name: s.ind_name || '',
        name,
        percent: Number.isFinite(percent) ? percent : 0,
        stock_id: finalStockId,
        textname: `${name}(${quoteSym})`,
        segment_name: s.ind_name || '',
        weight,
        url: `/S/${quoteSym}`,
        proactive: true,
        price: Number(price),
      });
    }
  }

  const totalWeight = targetHoldings.reduce((s, h) => s + h.weight, 0);
  const cash = roundW(100 - totalWeight);

  return {
    rebalancingHistories,
    holdings: targetHoldings,
    cash,
    total,
    finalMap,
    prevMap,
  };
}

module.exports = { buildRebalance, roundW, holdingsBySymbol };
