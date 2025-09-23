import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
      globals: {
        ...globals.node, // 👈 Node.js globals like `process`
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      prettier: prettier,
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-var-requires": "off",

      "no-console": "warn",
      "no-debugger": "warn",
      "no-duplicate-imports": "error",
      "no-unused-vars": "off",
      "prefer-const": "error",
      "no-var": "error",

      "max-lines-per-function": ["warn", { max: 200, skipBlankLines: true, skipComments: true }],
      "complexity": ["warn", 50],
      "max-depth": ["warn", 10],
      "max-params": ["warn", 12],

      "prettier/prettier": "error",

      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        { vars: "all", varsIgnorePattern: "^_", args: "after-used", argsIgnorePattern: "^_" },
      ],
    },
  },
  prettierConfig,
  {
    ignores: ["dist/", "build/", "node_modules/", "*.js", "**/*.d.ts"],
  },
];
