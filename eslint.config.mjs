/**
 * 配置职责：为根工具链测试和三个 TypeScript Workspace 提供同一套静态检查。
 *
 * 关键约束：生成目录不参与检查；显式 any 必须作为 error 阻止质量门禁通过。
 */
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
  },
  {
    // React 源码使用 TSX；必须进入与普通 TypeScript 相同的严格规则集。
    files: ["**/*.{ts,tsx,mts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // strict 只能阻止隐式 any；这条规则额外阻止开发者主动写显式 any。
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
