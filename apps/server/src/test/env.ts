/**
 * Environment of every test process. Integration tests use TEST_DATABASE_URL
 * (default: the connector_test database of compose.dev.yaml).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://connector:connector@localhost:55452/connector_test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.APP_URL = "http://localhost:3000";
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-1234";
process.env.LOG_LEVEL = "silent";
process.env.OIDC_ISSUER ??= "http://localhost:8106/realms/connector";
process.env.OIDC_CLIENT_ID ??= "connector";
process.env.OIDC_CLIENT_SECRET ??= "test-client-secret";
process.env.ADMIN_EMAILS ??= "root@example.org";
process.env.SEARCH_LANGUAGES ??= "english,german";
process.env.ENCRYPTION_KEY ??= "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdCE=";
