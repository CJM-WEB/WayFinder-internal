/** 稳定身份协议不能接受空值、邮箱、控制符或超长外部标识。 */
import { describe, expect, it } from "vitest";
import { UserIdSchema } from "./index.js";

describe("UserIdSchema", () => {
  it("接受稳定的不透明标识", () => expect(UserIdSchema.parse("fixture-user_A-1")).toBe("fixture-user_A-1"));
  it.each(["", "a@example.com", "a\nb", "x".repeat(129)])("拒绝非法标识 %s", value => {
    expect(UserIdSchema.safeParse(value).success).toBe(false);
  });
});
