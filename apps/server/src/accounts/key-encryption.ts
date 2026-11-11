/**
 * 模块职责：用进程私有主密钥认证加密用户Key；主密钥不进入数据库或公共响应。
 * 安全边界：随机nonce、固定16字节标签，认证绑定用户／服务／密钥版本／记录版本。
 * 失败路径：final完成认证前不交出明文；所有底层异常仅转换为固定错误，无cause。
 */
import { createCipheriv, createDecipheriv, createHmac, createSecretKey, randomBytes } from "node:crypto";
import { ApiKeySchema, type CredentialService } from "@wayfinder/contracts";
import { z } from "zod";

export const EncryptedKeySchema = z.strictObject({
  keyVersion: z.literal("v1"), nonce: z.string(), tag: z.string(), ciphertext: z.string(),
});
export type EncryptedKey = z.infer<typeof EncryptedKeySchema>;
type Context = Readonly<{ userId: string; service: CredentialService; revision: string; lastMutationId: string; requestFingerprint: string }>;
export type KeyEncryption = Readonly<{
  encrypt: (apiKey: string | null, context: Context) => EncryptedKey;
  decrypt: (value: unknown, context: Context) => string | null;
  fingerprint: (canonical: string) => string;
}>;
export class KeyEncryptionError extends Error {
  constructor() { super("KEY_UNAVAILABLE"); this.name = "KeyEncryptionError"; }
}
/** Node的base64解码较宽松；先要求唯一规范表示，再检查物理字节数。 */
function decode(value: string, bytes?: number): Buffer {
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value || (bytes !== undefined && result.length !== bytes)) throw new KeyEncryptionError();
  return result;
}
const aad = (context: Context): Buffer => Buffer.from(JSON.stringify([
  "wayfinder-account-key:v1", context.userId, context.service, "v1", context.revision, context.lastMutationId, context.requestFingerprint,
]));

/** 缺失或不合法配置只关闭云Key，不用认证secret代替，也不阻断账号／图功能。 */
export function createKeyEncryption(raw: string | undefined): KeyEncryption | null {
  if (!raw) return null;
  let material: Buffer;
  try { material = decode(raw, 32); } catch { return null; }
  const master = createSecretKey(material); material.fill(0);
  return {
    encrypt: (apiKey, context) => {
      try {
        const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", master, nonce, { authTagLength: 16 });
        cipher.setAAD(aad(context));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(ApiKeySchema.nullable().parse(apiKey)), "utf8"), cipher.final()]);
        return { keyVersion: "v1", nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
      } catch { throw new KeyEncryptionError(); }
    },
    decrypt: (value, context) => {
      try {
        const parsed = EncryptedKeySchema.parse(value), nonce = decode(parsed.nonce, 12), tag = decode(parsed.tag, 16);
        const decipher = createDecipheriv("aes-256-gcm", master, nonce, { authTagLength: 16 });
        decipher.setAAD(aad(context)); decipher.setAuthTag(tag);
        const pending = decipher.update(decode(parsed.ciphertext));
        // update产生的未认证字节不可使用；只有final成功后才解析并返回。
        let plain: Buffer | undefined;
        try {
          plain = Buffer.concat([pending, decipher.final()]);
          return ApiKeySchema.nullable().parse(JSON.parse(plain.toString("utf8")) as unknown);
        } finally { pending.fill(0); plain?.fill(0); }
      } catch { throw new KeyEncryptionError(); }
    },
    // 指纹由主密钥认证，不把短Key的裸摘要留给只读数据库攻击者离线枚举。
    fingerprint: canonical => createHmac("sha256", master).update(`wayfinder-key-mutation:v1:${canonical}`).digest("hex"),
  };
}
