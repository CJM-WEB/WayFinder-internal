/** 测试职责：配置路径不能通过静态目录或目录别名公开；内容不可用不阻断自带Key的启动。 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { assertPrivateConfigLocation } from "./private-config-location.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("体验配置的公开目录隔离", () => {
  it("拒绝尚未生成的公开配置及经既有目录别名落入的配置", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-private-location-"));
    directories.push(root);
    const web = path.join(root, "web");
    await fs.mkdir(path.join(web, "assets"), { recursive: true });
    await expect(assertPrivateConfigLocation(path.join(web, "assets", "experience.json"), web)).rejects.toThrow("公开静态目录之外");
    const alias = path.join(root, "alias");
    await fs.symlink(web, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(assertPrivateConfigLocation(path.join(alias, "assets", "future", "experience.json"), web)).rejects.toThrow("公开静态目录之外");
  });

  it("关闭、缺失或损坏的私有配置不因内容校验阻止启动", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-private-absent-"));
    directories.push(root);
    const web = path.join(root, "web");
    await fs.mkdir(web);
    await expect(assertPrivateConfigLocation(null, web)).resolves.toBeUndefined();
    const config = path.join(root, "private", "experience.json");
    await expect(assertPrivateConfigLocation(config, web)).resolves.toBeUndefined();
    await fs.mkdir(path.dirname(config));
    await fs.writeFile(config, "{broken", { mode: 0o600 });
    await expect(assertPrivateConfigLocation(config, web)).resolves.toBeUndefined();
  });
});
