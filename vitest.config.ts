import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        miniflare: {
          // Real D1 in-memory; Vectorize isn't supported by miniflare yet, so we mock the binding directly in tests
          d1Databases: ["DB"],
          kvNamespaces: ["OAUTH_KV"],
          compatibilityDate: "2024-12-30",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            OPENAI_API_KEY: "sk-test-openai",
            NOTION_INTEGRATION_KEY: "ntn_test",
            BLUEDOT_WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
            OPENAI_EXTRACTION_MODEL: "gpt-4.1-nano",
            NOTION_TRANSCRIPTS_DATA_SOURCE_ID: "test-transcripts-ds",
            NOTION_FOLLOWUPS_DATA_SOURCE_ID: "test-followups-ds",
            GITHUB_CLIENT_ID: "gh-client-test",
            GITHUB_CLIENT_SECRET: "gh-secret-test",
            ALLOWED_USERS: "jchu96",
            BASE_URL: "https://bluedot-rag.test.workers.dev",
          },
        },
      },
    },
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
