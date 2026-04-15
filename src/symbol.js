'use strict';

// 将用户输入的股票代码归一化为雪球格式
// 支持输入：600000, sh600000, SH600000, 600000.SH, 000001.SZ, 00700, 00700.HK, AAPL
// 输出：SH600000 / SZ000001 / HK00700 / AAPL

function normalizeSymbol(input) {
  if (!input || typeof input !== 'string') {
    throw new Error(`非法股票代码: ${input}`);
  }
  const raw = input.trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) throw new Error('股票代码不能为空');

  // 已是标准格式：SH/SZ/HK 前缀 + 数字
  let m = raw.match(/^(SH|SZ|HK)(\d+)$/);
  if (m) {
    if (m[1] === 'HK') return 'HK' + m[2].padStart(5, '0');
    return m[1] + m[2].padStart(6, '0');
  }

  // 带点后缀：600000.SH / 00700.HK
  m = raw.match(/^(\d+)\.(SH|SZ|HK)$/);
  if (m) {
    const prefix = m[2];
    if (prefix === 'HK') return 'HK' + m[1].padStart(5, '0');
    return prefix + m[1].padStart(6, '0');
  }

  // 纯数字：按首位推断交易所
  if (/^\d+$/.test(raw)) {
    if (raw.length === 6) {
      const head = raw[0];
      if (head === '6' || head === '9') return 'SH' + raw;
      if (head === '0' || head === '3' || head === '2') return 'SZ' + raw;
      // 其他 6 位默认当 A 股上海
      return 'SH' + raw;
    }
    if (raw.length <= 5) {
      return 'HK' + raw.padStart(5, '0');
    }
    throw new Error(`无法识别的数字股票代码: ${input}`);
  }

  // 纯字母/带点：美股，直接使用
  if (/^[A-Z0-9.\-]+$/.test(raw)) {
    return raw;
  }

  throw new Error(`无法识别的股票代码: ${input}`);
}

// 把规范化后的 symbol 转成行情/持仓接口期望的格式。
// 雪球行情 API（/stock/quote.json 等）对港股期望裸代码，不带 HK 前缀：
//   HK00135 → 00135, HK00700 → 00700
// A 股和美股保持不变。
function toQuoteSymbol(canonical) {
  if (typeof canonical !== 'string' || !canonical) return canonical;
  const m = canonical.match(/^HK(\d+)$/);
  return m ? m[1] : canonical;
}

// 猜测 segment_name（雪球调仓 API 需要）。其实服务端会兜底，这里只是好看。
function guessSegmentName(symbol) {
  if (/^SH6[08]/.test(symbol)) return '主板';
  if (/^SH688/.test(symbol)) return '科创板';
  if (/^SZ00/.test(symbol)) return '主板';
  if (/^SZ30/.test(symbol)) return '创业板';
  if (/^HK/.test(symbol)) return '港股';
  if (/^[A-Z]/.test(symbol)) return '美股';
  return '其他';
}

module.exports = { normalizeSymbol, toQuoteSymbol, guessSegmentName };
