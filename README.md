# WayFinder / 寻径

WayFinder 是一个 AI-native Browser 方向的 Web MVP。它把搜索结果组织成可探索的 Information Graph（信息图谱），但仍由用户决定打开哪些真实网页。

> Graph is the search result page. AI organizes the web. You decide where to go.

正式前端为“墨迹漫游”，开发与生产均从 `/` 进入。搜索、图编辑、重搜预览和浏览器本地保存复用同一套状态与 API；旧版产品入口和独立试验 HTML 已移除。
H1 / H2 内部评估继续通过原有显式查询参数按需加载，与产品导航及启动样式隔离。

## Repository role

当前仓库是 WayFinder 的永久私有开发源，包含构建、运行、测试和受控协作所需的工程资产。
本地规格、实验材料、运行数据和个人工作记录不会进入 Git；未来公开版本必须通过文件白名单
导出到独立仓库和独立 Git 历史，不能把当前仓库或其完整历史直接公开。

## Repository layout

```text
apps/
  web/                 React + Vite 前端及 Playwright E2E
  server/              Fastify 后端与搜索编排
packages/
  contracts/           前后端共享的 Zod 数据契约
tests/
  fixtures/            稳定测试样例
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
   pnpm --filter @wayfinder/web exec playwright install chromium
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
   pnpm --filter @wayfinder/web exec playwright install chromium
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
| `pnpm run schema:generate` | 从六个公共 Zod 根 Schema 显式更新 JSON Schema 产物 |
| `pnpm run schema:check` | 只读检查 JSON Schema 是否缺失、变化或出现额外产物 |
| `pnpm test` | 运行单元测试 |
| `pnpm build` | 构建所有应用和 Package |
| `pnpm start` | 从根 `.env`（若存在）启动单进程生产构建 |
| `pnpm run test:production-smoke` | 在 `pnpm build` 后验证单进程生产产物与渐进 NDJSON |
| `pnpm run test:e2e` | 用本地 Fixture 在 Chromium 中运行 Browser-like E2E |
| `pnpm run ci` | 按顺序运行静态检查、测试、构建、Production Smoke 与 E2E |

当前自动化测试已覆盖公共 Contract、JSON Schema 生成器、各 Workspace 工程链路，以及一条无 Secret 的 Browser-like E2E；它仍不能替代真实 Provider Eval 与真人 Smoke Test（冒烟测试）。

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
  → 安装 lockfile 对应的 Playwright Chromium
  → pnpm run ci
```

提交前可以在本地复现主要检查：

```bash
pnpm install --frozen-lockfile
pnpm --filter @wayfinder/web exec playwright install chromium
pnpm run ci
```

三个生产 Workspace 均已配置真实的 Lint、Typecheck、Test 和 Build 脚本；根命令会显式执行每个 Workspace，并在缺包、缺脚本或失败时返回非零状态。根 CI 在类型检查后运行只读 `schema:check`，人工修改、遗漏或增加受检产物都会阻断后续 Test 与 Build；构建通过后先运行无 Secret 的 Production Smoke（生产冒烟测试），再运行固定 Chromium 的 Fixture E2E。

受跟踪的 JSON Schema 位于 `packages/contracts/json-schema/`，由 Zod 4 原生转换器生成。它们只表达 Zod 输入侧可表示的结构投影；`trim()` 后长度、`superRefine()` 和跨对象关系仍必须由运行时 Zod Schema 校验，不能用 JSON Schema 通过替代真实入口的 Zod parse。

真实 Provider / LLM 调用、Golden Eval 与 Full Eval 不放在普通 CI 中，避免外部网络波动、凭据暴露和不受控成本。相关模块变更时仍须在受控环境运行相应 Eval。CI 失败时先修复第一个失败门禁，不能通过删测试或反复重跑等待偶然绿色；CI 绿色也不能替代人工 Diff 审核。

当前 Job 运行在 Linux，不能单独证明 macOS 和 Windows 兼容。项目通过固定 Node.js、pnpm 与 lockfile 降低平台差异；出现真实平台问题后再评估 Runner Matrix。

## Single-process production build

生产构建由一个 Node.js 进程中的同一个 Fastify 实例提供 `/health`、`POST /api/search`、
Vite `index.html` 与 `/assets/*`。必须从仓库根构建，避免只生成 Server 而缺少 Web 产物：

```bash
pnpm build
pnpm run test:production-smoke
pnpm start
```

`pnpm start` 使用 Node.js 的 `--env-file-if-exists` 从仓库根读取 `.env`；生产环境也可以不创建
该文件，改由 systemd `EnvironmentFile` 或受控 Secret 存储注入。生产 Secret 文件权限应为
`0600`，不得把值写入仓库、命令行、日志或前端。

| 环境变量 | 要求 | 用途 |
|---|---|---|
| `LLM_PROVIDER` | 必填，固定 `deepseek` | 已验证的大语言模型提供方 |
| `LLM_MODEL` | 必填，固定 `deepseek-flash` | 已验证的模型 |
| `LLM_API_KEY` | 必填 Secret，示例留空 | DeepSeek 凭据 |
| `SERPAPI_API_KEY` | 必填 Secret，示例留空 | SerpAPI 凭据（固定使用 Bing Search） |
| `PORT` | 可选，默认 `3000` | Node 回环监听端口 |
| `SEARCH_TIMEOUT_MS` | 可选，默认 `16000`、上限 `40000` | Search 单次超时 |
| `PLANNER_TIMEOUT_MS` / `RERANK_TIMEOUT_MS` | 可选，默认 `30000 / 24000`、上限 `30000` | Graph Planner、Graph Reviser、SearchPlan Generator 各自单次 LLM 调用与 Reranker 的阶段上限；全部仍共享 40 秒 Run Deadline |
| `SEARCH_CONCURRENCY` / `LLM_CONCURRENCY` | 可选、只能向下调整 | 进程级并发上限 |
| `RUN_LOGGING` | 可选，默认 `false` | 仅本地受控诊断；共享部署保持关闭 |

腾讯云 Ubuntu 目标使用同机 Nginx 作为唯一公网入口；Node 只监听 `127.0.0.1:3000`，安全组
只开放 80/443，不开放 3000。Nginx 必须把静态资源和 API 全部反代给同一个 Node 进程：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /api/search {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 60s;
    proxy_pass_header X-Accel-Buffering;
}
```

首次接入或修改正式域名、HTTPS、CDN、WAF、Nginx 后，必须使用不含敏感内容的受控 Query
`proxy_read_timeout` 必须始终大于 40 秒全局 Run Deadline。重新验证 NDJSON 首事件在终态前到达，并确认响应仍保留 `application/x-ndjson`、
`no-cache, no-transform`、`X-Accel-Buffering: no` 且没有固定 `Content-Length`。

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

## Private collaboration workflow

1. 只向获批成员授予当前私有仓库访问权限，不使用 Public Fork 传播源码或历史。
2. 从人员指定的基线分支创建短生命周期 Feature Branch。
3. 使用与项目一致的 Node.js、pnpm 和 frozen lockfile。
4. 一个 Pull Request 只解决一个核心问题，并按需要补充测试、Eval 与文档。
5. PR 描述必须说明 What、Why、Spec / Contract Impact、Validation、Quality / Latency / Cost 影响与风险。
6. 不得提交密钥、真实 Run Log、Provider 原始响应、个人信息或其他本地资料。

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
