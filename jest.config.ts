import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1"
  },
  globals: {
    "ts-jest": {
      tsconfig: {
        strict: true,
        esModuleInterop: true
      }
    }
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/Code.ts"]
};

export default config;
