'use strict';

const { Command, Option } = require('commander');
const chalk = require('chalk');
const pkg = require('../package.json');

function collectRepeatable(value, previous) {
  return previous ? previous.concat([value]) : [value];
}

function withErrorHandler(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(chalk.red(`✖ ${err.message || err}`));
      if (process.env.XUEQIU_DEBUG) console.error(err.stack);
      process.exit(1);
    }
  };
}

function build() {
  const program = new Command();
  program
    .name('xueqiu')
    .description('雪球 CLI：复用浏览器 Cookie 自动登录，发布组合调仓')
    .version(pkg.version)
    .option('-p, --profile <name>', '使用指定 profile（默认 current）');

  // login / logout / whoami
  program
    .command('login')
    .description('自动登录：默认从本地 Chrome 读取 Cookie（macOS），失败则回退到手动粘贴')
    .option('--cookie <cookie>', '直接传入 Cookie 字符串（跳过自动读取和交互粘贴）')
    .option('--from-chrome', '只从 Chrome 读取，不回退手动粘贴')
    .option('--manual', '直接进入手动粘贴模式，不尝试 Chrome 自动读取')
    .option('--browser', '启动 Puppeteer 浏览器；默认复用本地 Chrome 登录态（无需扫码）')
    .option('--browser-scan', '--browser 模式下强制走扫码/账密登录，不复用 Chrome cookie')
    .option('--chrome-path <path>', '自定义 Chrome 可执行文件路径（--browser 模式）')
    .option('--browser-timeout <seconds>', '--browser 模式下等待登录的超时秒数（默认 300）')
    .option('--fresh-profile', '--browser 模式下丢弃已保存的浏览器 profile，强制全新登录')
    .option('--chrome-profile <name>', 'Chrome profile 目录名（Default / "Profile 1" / ...）')
    .option('--profile <name>', '保存到哪个 xueqiu-cli profile', 'default')
    .action(withErrorHandler((opts) => require('./commands/login').run(opts)));

  program
    .command('logout')
    .description('清除当前（或指定）profile 的 Cookie')
    .option('--profile <name>', '指定 profile 名')
    .action(withErrorHandler((opts) => require('./commands/logout').run(opts)));

  program
    .command('whoami')
    .description('显示当前登录用户信息')
    .option('--list', '列出所有已登录的 profile')
    .option('--json', 'JSON 输出')
    .action(withErrorHandler((opts) => {
      const parent = program.opts();
      return require('./commands/whoami').run({ ...opts, profile: parent.profile });
    }));

  // holdings
  program
    .command('holdings [cube]')
    .alias('ls')
    .description('查看组合当前持仓（cube 形如 ZH123456，省略则用默认）')
    .option('--json', 'JSON 输出')
    .action(withErrorHandler((cube, opts) => {
      const parent = program.opts();
      return require('./commands/holdings').run(cube, { ...opts, profile: parent.profile });
    }));

  // rebalance
  program
    .command('rebalance [cube]')
    .alias('rb')
    .description('整体调仓：指定目标权重，默认替换模式（未列出的股票全部清仓）')
    .option('-s, --stock <symbol:weight>', '目标股票权重，可重复，如 -s SH600000:30 -s SZ000858:20', collectRepeatable)
    .option('--patch', '补丁模式：仅修改指定股票，不影响其他持仓')
    .option('-m, --comment <text>', '调仓说明（发布到雪球动态）')
    .option('-y, --yes', '跳过确认')
    .option('-n, --dry-run', '预览但不提交')
    .option('-v, --verbose', '打印 API 原始返回')
    .action(withErrorHandler((cube, opts) => {
      const parent = program.opts();
      return require('./commands/rebalance').run(cube, { ...opts, profile: parent.profile });
    }));

  // buy
  program
    .command('buy <symbol>')
    .description('单笔加仓（相对：--weight N；绝对：--to N）')
    .option('-c, --cube <cube>', '组合代码 ZH123456（省略用默认）')
    .option('-w, --weight <n>', '加仓百分比（相对当前权重）')
    .option('--to <n>', '目标权重（绝对）')
    .option('-m, --comment <text>', '调仓说明')
    .option('-y, --yes', '跳过确认')
    .option('-n, --dry-run', '预览但不提交')
    .action(withErrorHandler((symbol, opts) => {
      const parent = program.opts();
      return require('./commands/buy').runBuy(symbol, { ...opts, profile: parent.profile });
    }));

  // sell
  program
    .command('sell <symbol>')
    .description('单笔减仓（--weight N / --to N / --all 清仓）')
    .option('-c, --cube <cube>', '组合代码')
    .option('-w, --weight <n>', '减仓百分比')
    .option('--to <n>', '目标权重')
    .option('--all', '清仓')
    .option('-m, --comment <text>', '调仓说明')
    .option('-y, --yes', '跳过确认')
    .option('-n, --dry-run', '预览但不提交')
    .action(withErrorHandler((symbol, opts) => {
      const parent = program.opts();
      return require('./commands/buy').runSell(symbol, { ...opts, profile: parent.profile });
    }));

  // apply <file>
  program
    .command('apply <file>')
    .description('从 JSON/YAML 文件批量调仓')
    .option('-c, --cube <cube>', '文件未指定时的默认组合代码')
    .option('-m, --comment <text>', '统一调仓说明（文件里的 comment 优先）')
    .option('-y, --yes', '跳过确认')
    .option('-n, --dry-run', '预览但不提交')
    .action(withErrorHandler((file, opts) => {
      const parent = program.opts();
      return require('./commands/apply').run(file, { ...opts, profile: parent.profile });
    }));

  // config 子命令
  const cfgCmd = program.command('config').description('查看/修改本地配置');
  cfgCmd
    .command('show')
    .description('显示当前配置（Cookie 已脱敏）')
    .action(withErrorHandler(() => require('./commands/configCmd').show()));
  cfgCmd
    .command('set-cube <cube>')
    .description('设置默认组合代码')
    .action(withErrorHandler((cube) => require('./commands/configCmd').setCube(cube)));
  cfgCmd
    .command('use <profile>')
    .description('切换当前 profile')
    .action(withErrorHandler((name) => require('./commands/configCmd').useProfile(name)));

  program.showHelpAfterError();
  return program;
}

function run(argv) {
  const program = build();
  program.parseAsync(argv).catch((err) => {
    console.error(chalk.red(err.message || err));
    process.exit(1);
  });
}

module.exports = { run, build };
