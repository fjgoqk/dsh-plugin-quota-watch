# 额度看板（dsh-plugin-quota-watch）

给 DeepSeek Harness（DSH）Web/桌面 GUI 用的额度插件：在会话输入框下方实时显示 **Codex 剩余额度（5 小时窗口 + 周窗口）** 和 **DeepSeek API 余额**，并支持 **今日花费** 与 **近 7 日花费记录**。

装好后，输入框下方会出现一个小胶囊：

```
● Codex 5h 剩 82% · 周剩 96%   ● DeepSeek ¥26.39 今日 2.98   · 刚刚
```

## 功能

- **Codex 额度**：走官方 `https://chatgpt.com/backend-api/codex/usage`（读取 `~/.codex/auth.json` 的 OAuth token，与 `codex-ops/cx` 同一数据源），显示 5 小时窗口与周窗口的已用/剩余、重置时间与倒计时；状态灯：绿（充足）/ 黄（接近警告线）/ 红（到停止线或接口失败）。
- **DeepSeek 余额**：走官方 `https://api.deepseek.com/user/balance`，显示总额、充值余额、赠送余额、`is_available`。
- **今日花费**：本机观测法（官方无当日消费接口）——以当天首次观测到的余额为基线，累计余额下降；充值自动重算基线；跨天自动结算。
- **近 7 日花费**：按天持久化到 `~/.dsh/quota-watch-state.json`（保留最近 90 天），悬停卡片里展示最近 7 天。
- **点击强制刷新**：无论 Host 是否正在轮询，点击胶囊都会等当前轮询结束后立刻再拉一次，并显示「刷新中…」。
- **悬停详情卡**：鼠标移到胶囊上弹出详情卡（Codex 两窗口明细、DeepSeek 余额构成、今日已花、近 7 日记录、更新时间）。
- **抗抖动**：请求失败时保留上次成功数据（黄色状态点 + 悬停可见失败原因），约 4 秒后自动补刷；出站请求优先 IPv6、失败回退 IPv4（针对 Clash TUN 等假 IP 网络环境实测有效）。
- **只读回环接口**：页面只读取本机 `/api/quota-watch/overview`（仅回环地址与已配对设备可访问），密钥永远不离开 Host 进程。

## 安装

```bash
# 推荐：直接装 GitHub 仓库
dsh plugin --profile desktop add github:fjgoqk/dsh-plugin-quota-watch

# 或者
dsh plugin --profile desktop add https://github.com/fjgoqk/dsh-plugin-quota-watch.git
```

装完重启 DSH（或刷新 Web 页面）即可在会话输入框下方看到胶囊。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 中：

```yaml
- id: quota-watch
  name: 'dsh-plugin-quota-watch'
  config:
    pollIntervalSec: 60          # Host 拉取间隔（15–600 秒）
    codexAuthPath: ''            # 留空自动：$CODEX_HOME/auth.json → ~/.codex/auth.json → 当前目录 .codex-home/auth.json
    deepseekApiKeyEnv: DEEPSEEK_API_KEY   # 从 DSH 凭据库/环境变量读取的变量名
    deepseekApiKey: ''           # 直接指定 API key（不推荐，优先用凭据库）
```

## 数据口径说明

- **今日花费 / 近 7 日花费** 是「本机观测值」：插件运行时按轮询间隔记录余额下降；插件未运行的时段无法观测。余额上涨（充值）不累计为花费，且基线自动上移。
- Codex 的 `used_percent` 为官方权威值；插件显示剩余 = 100 − used。
- 失败时显示的是「最近一次成功的数据」，悬停可看到失败原因；恢复后自动更新。

## 依赖与兼容

- DSH `>=0.2.2-rc.3 <0.3.0`（桌面端 / Web 端均可）。
- Codex 需要本机存在 `~/.codex/auth.json`（`codex login` 后自动生成）。
- DeepSeek 需要凭据库或环境变量中的 `DEEPSEEK_API_KEY`。

## 开发

```bash
node --check index.js
node --check client.js
```

源码：`index.js`（Host 轮询 + `/api/quota-watch/overview|refresh` 路由）、`client.js`（输入框下方胶囊 + 悬停详情卡）、`cordis.patch.yml`（插件行）。

## License

MIT
