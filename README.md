# WayFinder / 寻径

WayFinder 是一个 AI-native Browser 方向的 Web MVP。它把搜索结果组织成可探索的 Information Graph（信息图谱），但仍由用户决定打开哪些真实网页。

> Graph is the search result page. AI organizes the web. You decide where to go.

## Repository role

当前仓库是 WayFinder 的公开开发与展示仓库，只包含允许公开且能支持构建、运行、测试和协作的工程资产。本地规格、实验材料、运行数据和个人工作记录不会进入 Git。

## Repository layout

```text
apps/
  web/                 React + Vite 前端
  server/              Fastify 后端与搜索编排
packages/
  contracts/           前后端共享的 Zod 数据契约
tests/
  fixtures/            稳定测试样例
  e2e/                 Playwright 端到端测试
data/
  runs/                本地 Run Log；内容不进入 Git
docs/                   预留的公开文档目录；本地资料不进入 Git
```

项目使用 pnpm workspace 管理 Monorepo（单仓多包）。三个 Workspace 已接通严格 TypeScript 与真实质量门禁；产品依赖和功能由对应 D1 Issue 逐步补充。

## Pinned toolchain

为保证 macOS、Windows 和 CI 行为一致，项目固定使用：

```text
Node.js 24.21.0 LTS
pnpm 11.25.0
```

版本由 `.nvmrc`、`.node-version` 和根 `package.json` 共同声明。安装后必须确认：

```bash
node --version
pnpm --version
```

期望输出分别以 `v24.21.0` 和 `11.25.0` 开头。依赖引入后生成的 `pnpm-lock.yaml` 必须提交；其他电脑和 CI 应使用 frozen lockfile 安装。

[Node.js 24](https://nodejs.org/en/about/previous-releases) 是当前 LTS 分支，官方计划支持至 2028 年 4 月。[pnpm 11](https://pnpm.io/blog/releases/11.0) 要求 Node.js 22 或更高版本，因此与本项目版本兼容。

## First setup on macOS

1. 安装 Node.js `24.21.0`。可以使用官方安装包，或使用支持 `.nvmrc` 的 Node 版本管理器。
2. 安装固定版本 pnpm：

   ```bash
   npm install --global pnpm@11.25.0
   ```

3. 克隆仓库并进入目录：

   ```bash
   git clone https://github.com/CJM-WEB/WayFinder-internal.git WayFinder
   cd WayFinder
   ```

4. 检查版本并安装依赖：

   ```bash
   node --version
   pnpm --version
   pnpm install --frozen-lockfile
   ```

5. 创建本地环境文件：

   ```bash
   cp .env.example .env
   ```

   将真实 Key 从密码管理器填入 `.env`；不要提交该文件。

## First setup on Windows

在 PowerShell 中执行以下步骤：

1. 安装 Node.js `24.21.0` 的 Windows 版本，或使用支持固定版本的 Node 版本管理器。
2. 重新打开 PowerShell，然后安装固定版本 pnpm：

   ```powershell
   npm install --global pnpm@11.25.0
   ```

3. 克隆仓库并进入目录：

   ```powershell
   git clone https://github.com/CJM-WEB/WayFinder-internal.git WayFinder
   Set-Location WayFinder
   ```

4. 检查版本并安装依赖：

   ```powershell
   node --version
   pnpm --version
   pnpm install --frozen-lockfile
   ```

5. 创建本地环境文件：

   ```powershell
   Copy-Item .env.example .env
   ```

   将真实 Key 从密码管理器填入 `.env`；不要提交该文件。

`.gitattributes` 会把仓库文本标准化为 LF，`.editorconfig` 会统一字符集、缩进与文件末尾换行。不要关闭这些设置，也不要用全局 Git 配置覆盖仓库的换行约束。

## Install after the lockfile exists

首次引入依赖并提交 `pnpm-lock.yaml` 后，普通开发和 CI 应使用：

```bash
pnpm install --frozen-lockfile
```

只有在明确需要变更依赖时，才运行会更新 lockfile 的安装或升级命令，并将依赖声明与 lockfile 放在同一个 `build` Commit 中审核。

## Development commands

根质量脚本按固定包名逐个调用三个 Workspace，并使用 `--fail-if-no-match` 防止包名错误或 Workspace 缺失被静默跳过。`pnpm dev` 暂时只启动已经提供开发服务的 Workspace。

| Command | Purpose |
|---|---|
| `pnpm dev` | 启动可用的开发服务 |
| `pnpm typecheck` | 运行 TypeScript 类型检查 |
| `pnpm lint` | 运行静态检查 |
| `pnpm test` | 运行单元测试 |
| `pnpm build` | 构建所有应用和 Package |
| `pnpm run ci` | 按 CI 顺序运行 Lint、Typecheck、Tests 与 Build |

当前单元测试只验证各 Workspace 的工程链路和质量配置；真实 Contract、Web 与 Server 行为测试由对应后续 Issue 增加，不能把 smoke test 通过理解为产品功能已完成。

## Continuous integration

GitHub Actions 会在以下情况运行 `.github/workflows/ci.yml`：

- 创建或更新 Pull Request；
- 向 `main` Push；
- 人员从 GitHub Actions 页面手动触发。

Pull Request 上的 CI 用于合并前检查；直接 Push 到 `main` 后运行的 CI 只能做事后兜底。只有未来经人员批准启用 GitHub Ruleset / Branch Protection，并将该 Job 设为 Required Check，才能在平台层阻止失败 PR 合并。

当前 CI 使用只读仓库权限，并依次执行：

```text
Checkout
  → 按 .nvmrc 安装 Node.js
  → 按 package.json 启用固定版本 pnpm
  → pnpm install --frozen-lockfile
  → pnpm run ci
```

提交前可以在本地复现主要检查：

```bash
pnpm install --frozen-lockfile
pnpm run ci
```

三个生产 Workspace 均已配置真实的 Lint、Typecheck、Test 和 Build 脚本；根命令会显式执行每个 Workspace，并在缺包、缺脚本或失败时返回非零状态。当前 smoke test 只证明工具链可执行，不能替代后续产品行为测试。Contracts 生成器尚未实现，因此 JSON Schema drift check 仍属于 WAY-25，当前 CI 绿色不表示 Contract drift 已验证。

真实 Provider / LLM 调用、Golden Eval 与 Full Eval 不放在普通 CI 中，避免外部网络波动、凭据暴露和不受控成本。相关模块变更时仍须在受控环境运行相应 Eval。CI 失败时先修复第一个失败门禁，不能通过删测试或反复重跑等待偶然绿色；CI 绿色也不能替代人工 Diff 审核。

当前 Job 运行在 Linux，不能单独证明 macOS 和 Windows 兼容。项目通过固定 Node.js、pnpm 与 lockfile 降低平台差异；出现真实平台问题后再评估 Runner Matrix。

## Cross-platform development

在 macOS 与 Windows 上都应使用仓库固定的 Node.js、pnpm 和 lockfile。切换设备前提交并推送已审核的工程改动，切换后先同步远程状态并运行与当前改动相符的最小验证。

`.env`、本地文档、运行日志和其他被忽略内容不会随 Git 同步；请使用受控渠道单独管理，不要通过 Issue、Pull Request 或公开链接传输。

## Commit convention

Commit message 使用：

```text
<type>(<scope>): <summary>
```

常用类型包括 `feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`build`、`ci`、`chore` 和 `style`。例如：

```text
chore: initialize wayfinder monorepo
feat(contracts): define graph plan schema
fix(streaming): preserve node terminal error code
docs: explain Windows development setup
test(graph): cover cycle repair cases
```

每个 Commit 应只包含一个可独立理解和回滚的逻辑改动；需要解释时在正文说明原因、验证和风险。

## Fork and contributor workflow

1. 在 GitHub Fork 本仓库。
2. 克隆自己的 Fork，并把本仓库配置为 `upstream`。
3. 从最新 `main` 创建短生命周期 Feature Branch。
4. 使用与项目一致的 Node.js、pnpm 和 frozen lockfile。
5. 一个 Pull Request 只解决一个核心问题，并按需要补充测试、Eval 与文档。
6. PR 描述必须说明 What、Why、Spec / Contract Impact、Validation、Quality / Latency / Cost 影响与风险。
7. 不得提交密钥、真实 Run Log、Provider 原始响应、个人信息或其他本地资料。

## Local-only files and secrets

下列内容始终不进入 Git：

```text
.env 与真实凭据
API Key / Token / Cookie / Authorization
data/runs/ 下的真实运行日志
Provider 原始响应
私有 Eval、实验结果和原始数据
用户研究原始材料和个人信息
AGENTS.md、docs/、notes/、private/、scratch/ 中的本地材料
本地 AI 辅助工具状态
```

`.gitignore` 只防止未跟踪文件被误提交，不是加密工具。如果 Secret 曾进入任何 Commit，应立即视为泄露并轮换，而不是只删除当前文件。
