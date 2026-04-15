'use strict';

const chalk = require('chalk');
const prompts = require('prompts');
const { createClient } = require('../client');
const config = require('../config');
const { buildRebalance } = require('../rebalance');
const { normalizeSymbol } = require('../symbol');

// buy/sell 都是 rebalance 的特例：patch 模式，只改一只股票
async function runBuy(symbolArg, opts) {
  await runOne({ symbolArg, opts, intent: 'buy' });
}
async function runSell(symbolArg, opts) {
  await runOne({ symbolArg, opts, intent: 'sell' });
}

async function runOne({ symbolArg, opts, intent }) {
  const cube = opts.cube || config.getDefaults().cube_symbol;
  if (!cube) {
    console.error(chalk.red('请指定组合：--cube ZH123456 或预设 xueqiu config set-cube ZH123456'));
    process.exit(1);
  }
  const symbol = normalizeSymbol(symbolArg);

  const client = createClient({ profile: opts.profile });
  const cubeInfo = await client.cubeQuote(cube);
  const prev = (cubeInfo.holdings || []).find((h) => (h.stock_symbol || h.symbol) === symbol);
  const prevWeight = Number(prev?.weight || 0);

  // 解析目标权重
  let targetWeight;
  if (opts.to != null) {
    targetWeight = Number(opts.to); // 目标绝对权重
  } else if (opts.weight != null) {
    // 相对变动：buy 加仓 +weight，sell 减仓 -weight
    const delta = Number(opts.weight);
    targetWeight = intent === 'buy' ? prevWeight + delta : prevWeight - delta;
  } else if (intent === 'sell' && opts.all) {
    targetWeight = 0;
  } else {
    console.error(
      chalk.red(
        intent === 'buy'
          ? '请提供 --weight <加仓%> 或 --to <目标权重%>'
          : '请提供 --weight <减仓%>、--to <目标权重%> 或 --all 清仓'
      )
    );
    process.exit(1);
  }

  if (targetWeight < 0) targetWeight = 0;
  if (targetWeight > 100) {
    console.error(chalk.red(`目标权重 ${targetWeight}% 超过 100%`));
    process.exit(1);
  }

  const { rebalancingHistories, holdings, cash, total } = await buildRebalance({
    client,
    targets: [{ symbol, weight: targetWeight }],
    currentHoldings: cubeInfo.holdings,
    mode: 'patch',
  });

  if (!rebalancingHistories.length) {
    console.log(chalk.yellow(`${symbol} 权重无变化（${prevWeight.toFixed(2)}%），不调仓。`));
    return;
  }

  const h = rebalancingHistories[0];
  const delta = (h.weight - h.prev_weight).toFixed(2);
  console.log(
    `${cube} / ${symbol} ${h.stock_name || ''}  ${h.prev_weight}% -> ${h.weight}%  ` +
      (delta > 0 ? chalk.green('+' + delta) : chalk.red(delta)) + '%'
  );
  console.log(chalk.gray(`调仓后股票总权重 ${total.toFixed(2)}%`));

  if (opts.dryRun) {
    console.log(chalk.gray('--dry-run，未提交。'));
    return;
  }

  const res = await client.rebalance(cube, { holdings, cash, comment: opts.comment });
  console.log(chalk.green(`✔ ${intent === 'buy' ? '买入' : '卖出'}已提交${res?.id ? '，id=' + res.id : ''}`));
  if (res?._warning) {
    console.log(chalk.yellow(`⚠ 服务端返回警告：${res._warning}`));
    console.log(chalk.gray('  （调仓通常仍然生效，建议用 xueqiu holdings 确认）'));
  }
}

module.exports = { runBuy, runSell };
