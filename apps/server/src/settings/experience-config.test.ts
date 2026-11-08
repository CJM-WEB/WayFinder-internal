/** 测试职责：用临时假秘密验证原子更新、撤销代际、重启恢复及失败关闭，不触发外部请求。 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { configureExperience } from "./configure-experience.js";
import { ExperienceConfigError, readExperienceConfig, updateExperienceConfig } from "./experience-config.js";

const directories: string[] = [];
async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-experience-test-"));
  directories.push(directory);
  return { directory, target: path.join(directory, "experience.json") };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("作者体验动态配置", () => {
  it("默认未开放；首次生成高熵假码及秘密，重新读取能恢复同一代际", async () => {
    expect(await readExperienceConfig(null)).toBeNull();
    const { target } = await fixture();
    await updateExperienceConfig(target, {});
    const first = await readExperienceConfig(target);
    expect(first?.inviteCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first?.signingSecret).toHaveLength(64);
    expect(await readExperienceConfig(target)).toEqual(first);
    if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o077).toBe(0);
  });

  it("公告更新保留代际与秘密，A→B→A 和显式同码更新均产生新代际", async () => {
    const { target } = await fixture();
    await updateExperienceConfig(target, { inviteCode: "fake-code-A" });
    const first = await readExperienceConfig(target);
    await updateExperienceConfig(target, { announcement: "公开说明\n第二行" });
    expect(await readExperienceConfig(target)).toEqual({ ...first, announcement: "公开说明\n第二行" });
    await updateExperienceConfig(target, { inviteCode: "fake-code-B" });
    const second = await readExperienceConfig(target);
    await updateExperienceConfig(target, { inviteCode: "fake-code-A" });
    const third = await readExperienceConfig(target);
    expect(new Set([first?.generation, second?.generation, third?.generation]).size).toBe(3);
    expect(third?.signingSecret).toBe(first?.signingSecret);
    await updateExperienceConfig(target, { inviteCode: "fake-code-A" });
    expect((await readExperienceConfig(target))?.generation).not.toBe(third?.generation);
  });

  it("每次读取当前文件，损坏、缺失或过宽权限不会回退旧配置", async () => {
    const { target } = await fixture();
    await updateExperienceConfig(target, { inviteCode: "fake-secret-sentinel" });
    await fs.writeFile(target, "{bad", { mode: 0o600 });
    await expect(readExperienceConfig(target)).rejects.toThrow(ExperienceConfigError);
    await expect(updateExperienceConfig(target, { announcement: "不可覆盖损坏配置" })).rejects.toThrow(ExperienceConfigError);
    await fs.unlink(target);
    await expect(readExperienceConfig(target)).rejects.toThrow(ExperienceConfigError);
    await updateExperienceConfig(target, {});
    if (process.platform !== "win32") {
      await fs.chmod(target, 0o644);
      await expect(readExperienceConfig(target)).rejects.toThrow(ExperienceConfigError);
    }
  });

  it("拒绝链接、非法字段和过大输入且不泄露秘密", async () => {
    const { target, directory } = await fixture();
    await updateExperienceConfig(target, { inviteCode: "fake-secret-sentinel" });
    const original = await fs.readFile(target, "utf8");
    await expect(updateExperienceConfig(target, { signingSecret: "fake-secret-sentinel" })).rejects.toThrow(ExperienceConfigError);
    await expect(updateExperienceConfig(target, { announcement: "x".repeat(70_000) })).rejects.toThrow(ExperienceConfigError);
    expect(await fs.readFile(target, "utf8")).toBe(original);
    const link = path.join(directory, "link.json");
    if (process.platform === "win32") {
      // Windows 普通账户未必能创建链接；模拟文件属性，仍验证拒绝分支且不要求提权。
      const stat = await fs.lstat(target);
      const linkedStat = new Proxy(stat, {
        get(object, key, receiver) {
          return key === "isSymbolicLink" ? () => true : Reflect.get(object, key, receiver);
        },
      });
      vi.spyOn(fs, "lstat").mockResolvedValueOnce(linkedStat);
      await expect(readExperienceConfig(target)).rejects.toThrow(ExperienceConfigError);
    } else {
      await fs.symlink(target, link);
      await expect(readExperienceConfig(link)).rejects.toThrow(ExperienceConfigError);
      await expect(updateExperienceConfig(link, {})).rejects.toThrow(ExperienceConfigError);
    }
  });

  it("写锁使并发更新明确失败，重试公告更新读取最新邀请码而不复活旧码", async () => {
    const { target } = await fixture();
    await updateExperienceConfig(target, { inviteCode: "fake-A" });
    const first = await readExperienceConfig(target);
    await fs.writeFile(`${target}.lock`, "", { mode: 0o600 });
    await expect(updateExperienceConfig(target, { announcement: "公告" })).rejects.toThrow(ExperienceConfigError);
    expect(await readExperienceConfig(target)).toEqual(first);
    await fs.unlink(`${target}.lock`);
    await updateExperienceConfig(target, { inviteCode: "fake-B" });
    const changed = await readExperienceConfig(target);
    await updateExperienceConfig(target, { announcement: "公告" });
    expect(await readExperienceConfig(target)).toEqual({ ...changed, announcement: "公告" });
    const results = await Promise.allSettled([
      updateExperienceConfig(target, { inviteCode: "fake-C" }),
      updateExperienceConfig(target, { announcement: "并发公告" }),
    ]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    expect(await readExperienceConfig(target)).not.toBeNull();
  });

  it("读取旧句柄期间原子发布新配置时拒绝旧代际", async () => {
    const { target, directory } = await fixture();
    const replacement = path.join(directory, "replacement.json");
    await updateExperienceConfig(target, { inviteCode: "fake-old" });
    await updateExperienceConfig(replacement, { inviteCode: "fake-new" });
    const stat = await fs.lstat(target);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat")
      .mockResolvedValueOnce(stat)
      .mockImplementationOnce(async filePath => {
        await fs.rename(replacement, target);
        return originalLstat(filePath);
      });
    await expect(readExperienceConfig(target)).rejects.toThrow(ExperienceConfigError);
    vi.restoreAllMocks();
    expect((await readExperienceConfig(target))?.inviteCode).toBe("fake-new");
  });

  it("命令只接受受保护输入文件，参数不能直接携带邀请码", async () => {
    const { target, directory } = await fixture();
    const input = path.join(directory, "update.json");
    await fs.writeFile(input, JSON.stringify({ announcement: "公告", inviteCode: "fake-only-code" }), { mode: 0o600 });
    await configureExperience(["--input", input], target);
    expect((await readExperienceConfig(target))?.announcement).toBe("公告");
    await expect(configureExperience(["--inviteCode", "fake-only-code"], target)).rejects.toThrow();
    await expect(configureExperience(["--input", input], undefined)).rejects.toThrow();
  });
});
