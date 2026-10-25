/**
 * 测试职责：冻结 Vite 产物的公开范围、缓存语义与 Symlink（符号链接）启动门禁。
 *
 * 测试只检查 WayFinder 自己配置的安全边界，不重复验证静态插件内部的 MIME 全矩阵。
 */
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "./app.js";
import { registerWebAssets } from "./web-assets.js";

const temporaryDirectories: string[] = [];

async function createWebFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wayfinder-web-assets-"));
  temporaryDirectories.push(root);
  const assets = join(root, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(
      join(root, "index.html"),
      '<div id="root"></div><script src="/assets/index-abcdefgh.js"></script>',
      "utf8",
    ),
    writeFile(join(assets, "index-abcdefgh.js"), "export {};\n", "utf8"),
    writeFile(join(assets, "unversioned.txt"), "asset\n", "utf8"),
    writeFile(join(assets, ".private"), "private\n", "utf8"),
  ]);
  await mkdir(join(assets, "nested"));
  await writeFile(join(assets, "nested", "public.txt"), "public\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("registerWebAssets", () => {
  it("只公开首页与 Asset，并按 Hash 区分缓存", async () => {
    const root = await createWebFixture();
    const server = buildServer();
    await registerWebAssets(server, root);

    try {
      const [index, hashedAsset, unversionedAsset, unknownRoute] =
        await Promise.all([
          server.inject({ method: "GET", url: "/" }),
          server.inject({ method: "GET", url: "/assets/index-abcdefgh.js" }),
          server.inject({ method: "GET", url: "/assets/unversioned.txt" }),
          server.inject({ method: "GET", url: "/client-side-route" }),
        ]);

      expect(index.statusCode).toBe(200);
      expect(index.headers["cache-control"]).toBe("no-cache");
      expect(index.headers["x-content-type-options"]).toBe("nosniff");
      expect(index.body).toContain('id="root"');
      expect(hashedAsset.statusCode).toBe(200);
      expect(hashedAsset.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(hashedAsset.headers["x-content-type-options"]).toBe("nosniff");
      expect(unversionedAsset.statusCode).toBe(200);
      expect(unversionedAsset.headers["cache-control"]).toBe("no-cache");
      expect(unknownRoute.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it.each([
    "/assets/.private",
    "/assets/%2e%2e/index.html",
    "/assets/%5c..%5cindex.html",
    "/assets/%00private",
    "/assets/missing.js",
    "/api/search",
  ])("拒绝非公开静态路径 %s，且响应不泄露产物绝对路径", async (url) => {
    const root = await createWebFixture();
    const server = buildServer();
    await registerWebAssets(server, root);

    try {
      const response = await server.inject({ method: "GET", url });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain(root);
    } finally {
      await server.close();
    }
  });

  it("启动前拒绝 Asset 树中的符号链接", async () => {
    const root = await createWebFixture();
    const outside = await mkdtemp(join(tmpdir(), "wayfinder-web-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(
      outside,
      join(root, "assets", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const server = buildServer();

    try {
      await expect(registerWebAssets(server, root)).rejects.toThrow(
        "Web 构建产物不能包含符号链接",
      );
    } finally {
      await server.close();
    }
  });

  it("注册后拒绝替换为根外文件符号链接", async () => {
    const root = await createWebFixture();
    const outside = await mkdtemp(join(tmpdir(), "wayfinder-web-outside-"));
    temporaryDirectories.push(outside);
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "never-expose-this-value\n", "utf8");
    const assetPath = join(root, "assets", "unversioned.txt");
    const server = buildServer();
    await registerWebAssets(server, root);

    try {
      await unlink(assetPath);
      await symlink(outsideFile, assetPath, "file");
      const response = await server.inject({
        method: "GET",
        url: "/assets/unversioned.txt",
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("never-expose-this-value");
      expect(response.body).not.toContain(root);
      expect(response.body).not.toContain(outside);
    } finally {
      await server.close();
    }
  });

  it("注册后拒绝替换为根外目录符号链接", async () => {
    const root = await createWebFixture();
    const outside = await mkdtemp(join(tmpdir(), "wayfinder-web-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "never-expose-directory\n", "utf8");
    const nestedDirectory = join(root, "assets", "nested");
    const server = buildServer();
    await registerWebAssets(server, root);

    try {
      await rm(nestedDirectory, { recursive: true });
      await symlink(
        outside,
        nestedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      const response = await server.inject({
        method: "GET",
        url: "/assets/nested/secret.txt",
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("never-expose-directory");
      expect(response.body).not.toContain(root);
      expect(response.body).not.toContain(outside);
    } finally {
      await server.close();
    }
  });

  it("缺失产物根与首页时只抛出不含绝对路径的固定错误", async () => {
    const parent = await mkdtemp(join(tmpdir(), "wayfinder-web-missing-"));
    temporaryDirectories.push(parent);
    const missingRoot = join(parent, "missing-root");
    const missingIndexRoot = join(parent, "missing-index");
    await mkdir(join(missingIndexRoot, "assets"), { recursive: true });

    for (const target of [missingRoot, missingIndexRoot]) {
      const server = buildServer();
      try {
        let caught: unknown;
        try {
          await registerWebAssets(server, target);
        } catch (error: unknown) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(TypeError);
        expect(String(caught)).toBe("WebAssetsError: Web 构建产物不可用");
        expect(String(caught)).not.toContain(parent);
      } finally {
        await server.close();
      }
    }
  });
});
