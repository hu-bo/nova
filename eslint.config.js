import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const persistenceImports = {
  group: ["drizzle-orm", "drizzle-orm/**", "**/database/**"],
  allowTypeImports: true,
  message: "SQL belongs in a domain repository (or the PostgreSQL job store); inject a repository/port here.",
};
const tableOwners = {
  attachments: [],
  "client-config": [],
  conversations: ["conversations", "messages", "pendingInputs", "runs"],
  events: ["uiEvents"],
  health: [],
  identity: ["users"],
  "model-config": ["modelConfigs", "modelProviders"],
  projects: ["projects", "projectBindings"],
  remotes: ["remoteConnections"],
  runners: ["runners", "runnerTokens"],
  // Run execution and conversation commands share an aggregate transaction.
  runs: ["runs", "conversations", "messages", "pendingInputs", "runnerOperations", "sessionCommits"],
};
const novaModules = Object.keys(tableOwners);
const allTables = [...new Set(Object.values(tableOwners).flat())];
function moduleImports(name, restrictPersistence = false) {
  return [
    "error",
    {
      patterns: [
        {
          regex: `(?:^|/)(?:${novaModules.filter((other) => other !== name).join("|")})/(?!index\\.js$)`,
          message: "Use the other domain's public index.ts API/port.",
        },
        {
          group: ["**/database/schema/**", "**/database/client.js"],
          allowTypeImports: true,
          message: "Use database/index.ts in repositories; access other domains through public ports.",
        },
        {
          regex: "(?:^|/)database/index\\.js$",
          importNames: allTables.filter((table) => !tableOwners[name].includes(table)),
          message: "This table belongs to another domain. Use its public port with the caller's transaction.",
        },
        {
          regex: "(?:^|/)shared/unit-of-work\\.js$",
          importNames: ["createUnitOfWork"],
          message: "Application services use the injected transaction callback so nested operations share one scope.",
        },
        ...(restrictPersistence ? [persistenceImports] : []),
      ],
    },
  ];
}

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/output/**",
      "**/target/**",
      "**/src/api/generated/**",
      "**/src/gen/**",
      "**/*.d.ts",
      "**/*.json",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
      "no-control-regex": "off",
      "prefer-const": "off",
      "no-nested-ternary": "error",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  ...novaModules.flatMap((name) => [
    {
      files: [`apps/nova-server/src/modules/${name}/**/*.ts`],
      rules: { "no-restricted-imports": moduleImports(name) },
    },
    {
      files: [`apps/nova-server/src/modules/${name}/**/*.ts`],
      ignores: ["**/*.repository.ts"],
      rules: { "no-restricted-imports": moduleImports(name, true) },
    },
  ]),
  {
    files: ["apps/nova-server/src/transport/**/*.ts", "apps/nova-server/src/jobs/**/*.ts"],
    ignores: ["apps/nova-server/src/jobs/postgres-job-store.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [persistenceImports] }] },
  },
  {
    files: ["apps/nova-server/src/modules/**/*.repository.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='transaction']",
          message: "Repositories use the bound context. Declare transaction boundaries in an application service.",
        },
      ],
    },
  },
  {
    files: [
      "apps/nova-server/src/modules/**/*.ts",
      "apps/nova-server/src/transport/**/*.ts",
      "apps/nova-server/src/jobs/**/*.ts",
    ],
    ignores: ["**/*.repository.ts", "apps/nova-server/src/jobs/postgres-job-store.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(select|insert|update|delete|execute|transaction)$/][callee.object.type='MemberExpression'][callee.object.property.name='db']",
          message: "Access persistence through a repository/port; own transactions through UnitOfWork.",
        },
      ],
    },
  },
);
