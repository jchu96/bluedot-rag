import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        miniflare: {
          // Real D1 in-memory; Vectorize isn't supported by miniflare yet, so we mock the binding directly in tests
          d1Databases: ["DB"],
          compatibilityDate: "2024-12-30",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            OPENAI_API_KEY: "sk-test-openai",
            NOTION_INTEGRATION_KEY: "ntn_test",
            BLUEDOT_WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
            OPENAI_EXTRACTION_MODEL: "gpt-4.1-nano",
            NOTION_TRANSCRIPTS_DATA_SOURCE_ID: "test-transcripts-ds",
            NOTION_FOLLOWUPS_DATA_SOURCE_ID: "test-followups-ds",
          },
        },
      },
    },
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
