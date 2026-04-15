# xueqiu-cli

雪球（xueqiu.com）组合调仓命令行工具。复用已登录浏览器的 Cookie 做鉴权，支持**整体调仓**、**单笔买/卖**、以及**从 JSON/YAML 批量调仓**。

> ⚠️ 本工具会**真实修改**你的雪球组合持仓并发布到动态。先用 `--dry-run` 预览，确认无误再去掉。

## 安装

```bash
# 方式一：npm 全局安装（发布后）
npm i -g xueqiu-cli

# 方式二：本地源码
git clone https://github.com/fanxinqi/xueqiu-cli.git
cd xueqiu-cli
npm install
npm link   # 注册全局命令 xueqiu / xq
```

需要 Node.js >= 16。

## 登录

**只要在 Chrome 里登录过雪球，直接一行搞定：**

```bash
xueqiu login
```

CLI 会自动从本地 Chrome 的 Cookies 数据库中读取并解密 xueqiu.com 的 Cookie，无需手动复制粘贴。

首次执行时 macOS 会弹出 Keychain 授权框（询问是否允许读取 "Chrome Safe Storage"），点 **始终允许** 即可。之后再登录就完全静默。

### 工作原理

- 读取 `~/Library/Application Support/Google/Chrome/Default/Cookies` (SQLite)
- 从 macOS Keychain 取 Chrome 加密口令，PBKDF2 派生 AES-128-CBC 密钥
- 解密 `xq_a_token`、`u` 等字段，调 `/user/current.json` 校验
- 校验通过后保存到 `~/.xueqiu-cli/config.json`（权限 `0600`），仅明文 Cookie，不含账号密码

### 选项

```bash
xueqiu login --from-chrome                  # 强制只从 Chrome 读取，不回退粘贴
xueqiu login --manual                       # 跳过自动读取，直接手动粘贴
xueqiu login --browser                      # 启动 Puppeteer 浏览器窗口登录（跨平台）
xueqiu login --cookie "xq_a_token=...;u=..."# 直接传整行 Cookie
xueqiu login --chrome-profile "Profile 1"   # 读取指定 Chrome profile
xueqiu login --profile alt                  # 存到 xueqiu-cli 的另一个 profile
```

### `--browser` 模式（Puppeteer）

跨平台方案：CLI 会用 `puppeteer-core` 驱动你本地安装的 Chrome，弹出一个独立窗口，
让你在里面完成登录（支持扫码 / 账号密码 / 短信）。检测到 `xq_a_token` 和 `u` 两个
关键 cookie 出现即视为登录成功，自动关闭窗口并保存。

```bash
xueqiu login --browser                         # 常规：默认 5 分钟超时
xueqiu login --browser --chrome-path /path/to/chrome
xueqiu login --browser --browser-timeout 600   # 等待最长 10 分钟
xueqiu login --browser --fresh-profile         # 丢弃上次保存的登录态，强制重登
```

- 使用独立的 `~/.xueqiu-cli/chrome-profile/` 作为 `userDataDir`，**不会影响主 Chrome**，
  也不会与主 Chrome 进程冲突。下次再登录会复用这个 profile，通常无需再输账密。
- 自动查找 `/Applications/Google Chrome.app`、`/usr/bin/google-chrome`、
  `C:\Program Files\Google\Chrome\Application\chrome.exe` 等常见路径；找不到时用
  `--chrome-path` 手动指定。
- `puppeteer-core` 是 `optionalDependencies`，不想装也不会阻塞主流程；
  用 `--browser` 时若未安装，会给出明确提示。

### 平台限制 & 手动回退

从 Chrome 数据库直接解密（默认模式）**仅支持 macOS**。Linux/Windows 推荐用
`--browser` 模式（Puppeteer），或者手动粘贴模式：

1. 浏览器打开 <https://xueqiu.com> 并登录；
2. 开发者工具 → Network → 刷新 → 任选一个 `xueqiu.com` 请求；
3. Request Headers 里找到 `Cookie:` 那一行，整行复制；
4. `xueqiu login --manual` 粘贴（输入隐藏）。

也可以直接：

```bash
xueqiu login --cookie "xq_a_token=xxx; u=xxx; ..."
```

登录成功后会打印当前账号，并保存到 `~/.xueqiu-cli/config.json`（权限 0600）。

核查登录状态：

```bash
xueqiu whoami
xueqiu whoami --list     # 多 profile 时显示所有已登录账号
```

多账号：

```bash
xueqiu login --profile alt       # 登录另一个账号
xueqiu config use alt            # 切换当前 profile
xueqiu --profile alt holdings ZH123456   # 临时使用某 profile
```

Cookie 失效时重新 `xueqiu login` 覆盖即可。

## 常用命令

```bash
xueqiu --help
xueqiu <command> --help
```

### 设置默认组合（可选）

```bash
xueqiu config set-cube ZH123456
```

之后所有子命令省略 `cube` 参数时都使用这个默认值。

### 查看当前持仓

```bash
xueqiu holdings ZH123456
xueqiu ls ZH123456 --json
```

### 整体调仓（替换模式，未列出的股票清仓）

```bash
xueqiu rebalance ZH123456 \
  -s SH600519:30 \
  -s SZ000858:20 \
  -s SH600036:15 \
  -m "春季调仓"
```

加 `--dry-run` 预览、`-y` 跳过确认。

### 补丁调仓（只改列出的股票）

```bash
xueqiu rebalance ZH123456 --patch -s HK00700:10
```

### 单笔买 / 卖

```bash
# 相对加仓 5%
xueqiu buy SH600519 -c ZH123456 -w 5

# 设定到目标权重 8%
xueqiu buy HK00700 -c ZH123456 --to 8

# 减仓 3%
xueqiu sell SZ000858 -c ZH123456 -w 3

# 清仓
xueqiu sell AAPL -c ZH123456 --all -m "止盈离场"
```

股票代码支持多种写法，会自动归一化：

| 输入 | 归一 |
|---|---|
| `600519` / `sh600519` / `600519.SH` | `SH600519` |
| `000858` / `000858.SZ` | `SZ000858` |
| `00700` / `700` / `00700.HK` | `HK00700` |
| `AAPL` / `NVDA` | `AAPL` / `NVDA` |

### 从文件批量调仓

```bash
xueqiu apply examples/rebalance.yaml -n        # 预览
xueqiu apply examples/rebalance.yaml -y        # 直接提交（慎用）
xueqiu apply examples/batch.yaml               # 一次多个组合
```

示例配置见 [`examples/`](./examples)。

## 配置文件

位置：`~/.xueqiu-cli/config.json`（权限 0600，请勿提交到 git）

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "cookie": "xq_a_token=...; u=...;",
      "user_id": 1234567,
      "screen_name": "yourname",
      "updated_at": "2026-04-15T10:00:00.000Z"
    }
  },
  "defaults": {
    "cube_symbol": "ZH123456"
  }
}
```

查看（Cookie 自动脱敏）：

```bash
xueqiu config show
```

## 调试

```bash
XUEQIU_DEBUG=1 xueqiu rebalance ZH123456 -s SH600519:30 -n
```

会打印堆栈。API 调用异常时，错误信息里会包含 HTTP 状态码和雪球返回的 `error_code/error_description`。

## 命令速查

| 命令 | 作用 |
|---|---|
| `xueqiu login [--from-chrome\|--manual\|--browser\|--cookie ...]` | 登录（默认 Chrome 自动读取）|
| `xueqiu logout` | 清除 Cookie |
| `xueqiu whoami [--list]` | 查看当前账号 |
| `xueqiu holdings [cube]` | 查看组合持仓 |
| `xueqiu rebalance [cube] -s SYM:W ...` | 整体调仓 |
| `xueqiu buy <sym> -c <cube> -w N` | 加仓 |
| `xueqiu sell <sym> -c <cube> [-w N \| --all]` | 减仓/清仓 |
| `xueqiu apply <file>` | 批量调仓（JSON/YAML）|
| `xueqiu config show \| set-cube \| use` | 配置管理 |

## 免责声明

- 本工具是**非官方**的第三方 CLI，雪球 API 可能随时变动导致不可用。
- 调仓操作是**实盘之外的模拟组合**，但会真实产生社交动态、被粉丝跟投。请自行承担使用后果。
- 请勿将个人 Cookie 提交到任何公开仓库。

## License

MIT © fanxinqi
