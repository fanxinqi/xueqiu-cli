'use strict';

const chalk = require('chalk');
const Table = require('cli-table3');
const prompts = require('prompts');
const { createClient } = require('../client');
const config = require('../config');
const { buildRebalance } = require('../rebalance');

// 解析 --stock SH600000:30 这种形式
function parseStockArg(s) {
  const m = String(s).match(/^([^:=]+)\s*[:=]\s*([\d.]+)$/);
  if (!m) throw new Error(`--stock 格式错误，应为 SYMBOL:WEIGHT，如 SH600000:30，实际: ${s}`);
  return { symbol: m[1].trim(), weight: Number(m[2]) };
}

function defaultCube(cube) {
  const d = config.getDefaults();
  return cube || d.cube_symbol;
}

function renderPreview(cube, rebalancingHistories, total, comment) {
  console.log(chalk.bold(`\n调仓预览 - ${cube}`));
  if (!rebalancingHistories.length) {
    console.log(chalk.yellow('没有任何权重变化，无需调仓。'));
    return;
  }
  const table = new Table({
    head: ['代码', '名称', '原权重%', '目标%', '变化', '价格'],
    colAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
  });
  for (const h of rebalancingHistories) {
    const delta = (h.weight - h.prev_weight).toFixed(2);
    const deltaStr = delta > 0 ? chalk.green('+' + delta) : chalk.red(delta);
    table.push([
      h.stock_symbol,
      h.stock_name || '',
      h.prev_weight.toFixed(2),
      h.weight.toFixed(2),
      deltaStr,
      h.price,
    ]);
  }
  console.log(table.toString());
  console.log(
    chalk.gray(`股票总权重 ${total.toFixed(2)}% / 现金 ${(100 - total).toFixed(2)}%`)
  );
  if (comment) console.log(chalk.gray(`调仓说明：${comment}`));
}

async function run(cubeSymbol, opts) {
  const cube = defaultCube(cubeSymbol);
  if (!cube) {
    console.error(chalk.red('请提供组合代码，如: xueqiu rebalance ZH123456 --stock SH600000:30'));
    process.exit(1);
  }
  const stockArgs = opts.stock || [];
  if (!stockArgs.length) {
    console.error(chalk.red('至少要提供一个 --stock SYMBOL:WEIGHT'));
    process.exit(1);
  }
  const targets = stockArgs.map(parseStockArg);
  const mode = opts.patch ? 'patch' : 'replace';

  const client = createClient({ profile: opts.profile });
  const cubeInfo = await client.cubeQuote(cube);

  const { rebalancingHistories, holdings, cash, total } = await buildRebalance({
    client,
    targets,
    currentHoldings: cubeInfo.holdings,
    mode,
  });

  renderPreview(cube, rebalancingHistories, total, opts.comment);

  if (!rebalancingHistories.length) return;
  if (opts.dryRun) {
    console.log(chalk.gray('\n--dry-run，未实际提交。'));
    return;
  }

  const res = await client.rebalance(cube, { holdings, cash, comment: opts.comment });
  console.log(chalk.green(`✔ 调仓提交成功${res?.id ? '，id=' + res.id : ''}`));
  if (res?._warning) {
    console.log(chalk.yellow(`⚠ 服务端返回警告：${res._warning}`));
    console.log(chalk.gray('  （调仓通常仍然生效，建议用 xueqiu holdings 确认）'));
  }
  if (opts.verbose) console.log(JSON.stringify(res, null, 2));
}

module.exports = { run };
