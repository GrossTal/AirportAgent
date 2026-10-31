import { defineConfig } from "vitest/config";

// Only source tests; dist/ holds compiled copies after `npm run build`.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
