'use strict';

const chalk = require('chalk');
const Table = require('cli-table3');
const { createClient } = require('../client');
const config = require('../config');

function defaultCube(cube) {
  const d = config.getDefaults();
  return cube || d.cube_symbol;
}

async function run(cubeSymbol, opts) {
  const cube = defaultCube(cubeSymbol);
  if (!cube) {
    console.error(chalk.red('请提供组合代码，如: xueqiu holdings ZH123456'));
    console.error(chalk.gray('或先设置默认：xueqiu config set-cube ZH123456'));
    process.exit(1);
  }

  const client = createClient({ profile: opts.profile });
  const data = await client.cubeQuote(cube);

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(chalk.bold(`${data.name || data.symbol}  (${data.symbol})`));
  if (data.net_value != null) {
    console.log(chalk.gray(`净值 ${data.net_value}  日涨幅 ${data.percent_daily ?? data.percent ?? '-'}%`));
  }

  const holdings = data.holdings || [];
  let totalStock = 0;
  const table = new Table({
    head: ['代码', '名称', '权重%', '最新价', '涨跌%'],
    colAligns: ['left', 'left', 'right', 'right', 'right'],
  });
  for (const h of holdings) {
    const w = Number(h.weight || 0);
    totalStock += w;
    table.push([
      h.stock_symbol || h.symbol || '',
      h.stock_name || h.name || '',
      w.toFixed(2),
      h.current_price ?? h.price ?? '-',
      h.current_price_change ?? h.percent ?? '-',
    ]);
  }
  table.push([chalk.gray('现金'), '', chalk.gray(Math.max(0, 100 - totalStock).toFixed(2)), '', '']);
  console.log(table.toString());
}

module.exports = { run };
