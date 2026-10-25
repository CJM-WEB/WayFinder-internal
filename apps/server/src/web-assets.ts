/**
 * 模块职责：把已构建的 Vite 静态产物安全注册到现有 Fastify 实例。
 *
 * 安全边界：
 * - 只公开根 `index.html` 与 `assets/`，不实现 SPA 通配回退；
 * - 启动前扫描且每次请求复核真实路径，拒绝 Symlink（符号链接）置换越出固定产物根；
 * - dotfile、路径穿越与目录列表由显式插件选项继续拒绝；
 * - 只有 Vite Hash 文件使用长期缓存，HTML 与非 Hash Asset 均不得长期缓存。
 */
import { constants } from "node:fs";
import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { URL } from "node:url";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

const HASHED_ASSET_NAME = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u;
const IMMUTABLE_CACHE_CONTROL =
  "public, max-age=31536000, immutable" as const;
const REVALIDATE_CACHE_CONTROL = "no-cache" as const;

class WebAssetsError extends TypeError {
  public constructor(message: string) {
    // 不保留 cause，避免底层 fs Error 的绝对路径进入终端、CI 或 HTTP 响应。
    super(message);
    this.name = "WebAssetsError";
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

/**
 * 递归拒绝 Symlink 与特殊文件。部署产物目录由发布流程只读管理，因此启动时的一次
 * 完整检查先拒绝错误发布产物；请求时仍会再次解析真实路径，封闭运行期置换。
 */
async function assertRealArtifactTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new WebAssetsError("Web 构建产物不能包含符号链接");
    }

    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertRealArtifactTree(entryPath);
    } else if (!entry.isFile()) {
      throw new WebAssetsError("Web 构建产物只能包含真实目录和普通文件");
    }
  }
}

async function readValidatedWebAssets(
  webAssetsDirectory: string,
): Promise<Readonly<{ assetsDirectory: string; indexHtml: string }>> {
  if (!isAbsolute(webAssetsDirectory)) {
    throw new WebAssetsError("Web 构建产物目录必须是绝对路径");
  }

  const root = resolve(webAssetsDirectory);
  const rootInformation = await lstat(root);
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) {
    throw new WebAssetsError("Web 构建产物根必须是真实目录");
  }
  await assertRealArtifactTree(root);
  const indexPath = join(root, "index.html");
  const assetsDirectory = join(root, "assets");
  const [indexInformation, assetsInformation, indexHtml] = await Promise.all([
    lstat(indexPath),
    lstat(assetsDirectory),
    readFile(indexPath, "utf8"),
  ]);
  if (!indexInformation.isFile() || !assetsInformation.isDirectory()) {
    throw new WebAssetsError("Web 构建产物缺少 index.html 或 assets 目录");
  }
  if (indexHtml.length === 0) {
    throw new WebAssetsError("Web 构建产物 index.html 不能为空");
  }

  return { assetsDirectory, indexHtml };
}

/** 注册 GET/HEAD 静态边界；调用完成即证明生产 Web 产物完整可用。 */
export async function registerWebAssets(
  server: FastifyInstance,
  webAssetsDirectory: string,
): Promise<void> {
  let assets: Awaited<ReturnType<typeof readValidatedWebAssets>>;
  let realAssetsDirectory: string;
  try {
    assets = await readValidatedWebAssets(webAssetsDirectory);
    realAssetsDirectory = await realpath(assets.assetsDirectory);
  } catch (error: unknown) {
    if (error instanceof WebAssetsError) throw error;
    throw new WebAssetsError("Web 构建产物不可用");
  }

  server.addHook("onRequest", async (request, reply) => {
    if (
      (request.method !== "GET" && request.method !== "HEAD") ||
      !request.raw.url?.startsWith("/assets/")
    ) {
      return;
    }

    let requestedAsset: string;
    try {
      const pathname = new URL(request.raw.url, "http://localhost").pathname;
      requestedAsset = decodeURIComponent(pathname.slice("/assets/".length));
    } catch {
      await reply.code(400).send();
      return reply;
    }
    if (requestedAsset.includes("\0") || requestedAsset.includes("\\")) {
      await reply.code(403).send();
      return reply;
    }

    const candidate = resolve(realAssetsDirectory, requestedAsset);
    if (!isContainedPath(realAssetsDirectory, candidate)) {
      await reply.code(403).send();
      return reply;
    }

    try {
      const realCandidate = await realpath(candidate);
      if (!isContainedPath(realAssetsDirectory, realCandidate)) {
        await reply.code(403).send();
        return reply;
      }
      const information = await lstat(realCandidate);
      if (!information.isFile()) {
        await reply.code(404).send();
        return reply;
      }
      await access(realCandidate, constants.R_OK);
    } catch (error: unknown) {
      if (isMissingPathError(error)) return;
      throw new WebAssetsError("Web 静态资源不可用");
    }
  });

  try {
    await server.register(fastifyStatic, {
      root: assets.assetsDirectory,
      prefix: "/assets/",
      acceptRanges: true,
      cacheControl: false,
      dotfiles: "deny",
      index: false,
      list: false,
      preCompressed: false,
      redirect: false,
      serveDotFiles: false,
      wildcard: true,
      setHeaders: (reply, filePath) => {
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header(
          "Cache-Control",
          HASHED_ASSET_NAME.test(filePath)
            ? IMMUTABLE_CACHE_CONTROL
            : REVALIDATE_CACHE_CONTROL,
        );
      },
    });
  } catch {
    throw new WebAssetsError("Web 静态资源注册失败");
  }

  server.route({
    method: ["GET", "HEAD"],
    url: "/",
    handler: async (_request, reply) =>
      reply
        .header("Cache-Control", REVALIDATE_CACHE_CONTROL)
        .header("X-Content-Type-Options", "nosniff")
        .type("text/html; charset=utf-8")
        .send(assets.indexHtml),
  });
}
