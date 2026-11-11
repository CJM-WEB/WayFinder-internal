/** 假秘密验证认证加密、归属／版本绑定和固定错误；普通CI不读环境或数据库。 */
import { describe, expect, it } from "vitest";
import { createKeyEncryption, KeyEncryptionError } from "./key-encryption.js";

const master = Buffer.alloc(32, 71).toString("base64"), secret = "fixture-private-key-value";
const context = { userId: "owner_A", service: "deepseek" as const, revision: "revision_A", lastMutationId: "mutation_A", requestFingerprint: "a".repeat(64) };
function fixture() {
  const encryption = createKeyEncryption(master);
  if (encryption === null) throw new Error("假主密钥无效");
  return encryption;
}
describe("用户Key认证加密", () => {
  it("严格要求规范32字节base64；缺失或错误配置仅禁用云Key", () => {
    for (const raw of [undefined, "", "fixture-private-invalid", `${master}\n`, master.replace(/=+$/, ""), Buffer.alloc(31).toString("base64")]) {
      expect(createKeyEncryption(raw)).toBeNull();
    }
    expect(createKeyEncryption(master)).not.toBeNull();
  });
  it("随机nonce使同一Key密文不同；有效标签往返原值和认证null墓碑", () => {
    const encryption = fixture(), first = encryption.encrypt(secret, context), second = encryption.encrypt(secret, context);
    expect(first.nonce).not.toBe(second.nonce); expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(Buffer.from(first.nonce, "base64")).toHaveLength(12); expect(Buffer.from(first.tag, "base64")).toHaveLength(16);
    expect(JSON.stringify(first)).not.toContain(secret); expect(encryption.decrypt(first, context)).toBe(secret);
    expect(encryption.decrypt(encryption.encrypt(null, context), context)).toBeNull();
  });
  it("交换用户／服务／记录版本、错误主密钥和未知密钥版本均拒绝，不暴露原值", () => {
    const encryption = fixture(), value = encryption.encrypt(secret, context), other = createKeyEncryption(Buffer.alloc(32, 72).toString("base64"));
    if (other === null) throw new Error("假主密钥无效");
    const attempts = [
      () => encryption.decrypt(value, { ...context, userId: "owner_B" }),
      () => encryption.decrypt(value, { ...context, service: "serpapi" }),
      () => encryption.decrypt(value, { ...context, revision: "revision_B" }),
      () => encryption.decrypt(value, { ...context, lastMutationId: "mutation_B" }),
      () => encryption.decrypt(value, { ...context, requestFingerprint: "b".repeat(64) }),
      () => encryption.decrypt({ ...value, keyVersion: "v2" }, context),
      () => other.decrypt(value, context),
    ];
    for (const attempt of attempts) {
      let error: unknown; try { attempt(); } catch (caught: unknown) { error = caught; }
      expect(error).toBeInstanceOf(KeyEncryptionError); expect(String(error)).toBe("KeyEncryptionError: KEY_UNAVAILABLE");
      expect(JSON.stringify(error)).not.toContain(secret); expect(error).not.toHaveProperty("cause");
    }
  });
  it.each(["nonce", "tag", "ciphertext"] as const)("%s篡改、非规范base64或错误长度不能给出未认证明文", field => {
    const encryption = fixture(), value = encryption.encrypt(secret, context), bytes = Buffer.from(value[field], "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    for (const invalid of [bytes.toString("base64"), `${value[field]}\n`, "AA=="]) {
      expect(() => encryption.decrypt({ ...value, [field]: invalid }, context)).toThrow(/^KEY_UNAVAILABLE$/);
    }
  });
  it("幂等指纹绑定主密钥及用途，不留下裸明文摘要", () => {
    const first = fixture(), second = createKeyEncryption(Buffer.alloc(32, 72).toString("base64"));
    if (second === null) throw new Error("假主密钥无效");
    expect(first.fingerprint(secret)).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fingerprint(secret)).toBe(first.fingerprint(secret));
    expect(first.fingerprint(secret)).not.toBe(second.fingerprint(secret));
    expect(first.fingerprint(secret)).not.toBe(first.fingerprint(`${secret}_changed`));
  });
});
