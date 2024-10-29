// @ts-check

import baseConfig from "@mgcrea/eslint-config-node";

const config = [
  ...baseConfig,
  {
    rules: {
      // "@typescript-eslint/no-unnecessary-type-parameters": "off",
    },
  },
  {
    files: ["**/*.{mock,spec,test}.{js,ts,tsx}", "**/__{mocks,tests}__/**/*.{js,ts,tsx}"],
    rules: {
      // "@typescript-eslint/no-unsafe-member-access": "off",
      // "@typescript-eslint/no-unsafe-call": "off",
      // "@typescript-eslint/no-unsafe-assignment": "off",
      // "@typescript-eslint/no-unsafe-argument": "off",
      // "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];

export default config;
