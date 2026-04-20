// Intentionally sanitized.
// This file previously contained hard-coded Takaro credentials and game-server identifiers.
// Recreate any local exercise script from environment variables instead of committing secrets.

const required = ['TAKARO_HOST', 'TAKARO_USERNAME', 'TAKARO_PASSWORD', 'TAKARO_DOMAIN'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

console.log('Sanitized helper placeholder. Provide credentials via environment variables if you need a local exercise script.');
