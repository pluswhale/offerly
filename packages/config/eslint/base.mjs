import tseslint from "typescript-eslint";

/** Minimal shared flat config. Apps extend this with framework-specific rules. */
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/coverage/**", "**/.turbo/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
