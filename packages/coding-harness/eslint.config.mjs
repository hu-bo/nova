import config from "../harness/eslint.config.mjs";

export default config.map((entry) =>
  entry.languageOptions?.parserOptions
    ? {
        ...entry,
        languageOptions: {
          ...entry.languageOptions,
          parserOptions: {
            ...entry.languageOptions.parserOptions,
            tsconfigRootDir: import.meta.dirname,
          },
        },
      }
    : entry,
);
