import tsParser from "./tooling/node_modules/@typescript-eslint/parser/dist/index.js";

export default [
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    ignores: [
      "research/**",
      "tests/**",
      "gate-d/**",
      "benchmarks/**",
      "node_modules/**",
      "dist/**"
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" }
    },
    rules: {
      complexity: ["warn", { max: 10, variant: "modified" }],
      "max-depth": ["warn", { max: 4 }],
      "max-nested-callbacks": ["warn", { max: 4 }]
    }
  }
];
