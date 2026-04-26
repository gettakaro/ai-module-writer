/**
 * Pure unit tests for assertTestSafeHost.
 * These run without a live Takaro stack — they only test logic.
 * Run with: node --test --import=ts-node-maintained/register/esm 'test/helpers/modules-guard.test.ts'
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertTestSafeHost } from './modules.js';

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('assertTestSafeHost', () => {
  it('throws for production host api.takaro.io', () => {
    withEnv(
      { TAKARO_HOST: 'https://api.takaro.io', TAKARO_TEST_ALLOW_ANY_HOST: undefined, TAKARO_TEST_HOST_ALLOWLIST: undefined },
      () => {
        assert.throws(() => assertTestSafeHost(), /refused/);
      },
    );
  });

  it('throws for prod.dev host', () => {
    withEnv(
      { TAKARO_HOST: 'https://prod.dev', TAKARO_TEST_ALLOW_ANY_HOST: undefined, TAKARO_TEST_HOST_ALLOWLIST: undefined },
      () => {
        assert.throws(() => assertTestSafeHost(), /refused/);
      },
    );
  });

  it('passes for localhost', () => {
    withEnv(
      { TAKARO_HOST: 'http://localhost:13000', TAKARO_TEST_ALLOW_ANY_HOST: undefined, TAKARO_TEST_HOST_ALLOWLIST: undefined },
      () => {
        assert.doesNotThrow(() => assertTestSafeHost());
      },
    );
  });

  it('passes for api.next.takaro.dev', () => {
    withEnv(
      { TAKARO_HOST: 'https://api.next.takaro.dev', TAKARO_TEST_ALLOW_ANY_HOST: undefined, TAKARO_TEST_HOST_ALLOWLIST: undefined },
      () => {
        assert.doesNotThrow(() => assertTestSafeHost());
      },
    );
  });

  it('passes for single-label Docker hostname takaro_api', () => {
    withEnv(
      { TAKARO_HOST: 'http://takaro_api', TAKARO_TEST_ALLOW_ANY_HOST: undefined, TAKARO_TEST_HOST_ALLOWLIST: undefined },
      () => {
        assert.doesNotThrow(() => assertTestSafeHost());
      },
    );
  });

  it('passes when TAKARO_TEST_ALLOW_ANY_HOST=1', () => {
    withEnv(
      { TAKARO_HOST: 'https://api.takaro.io', TAKARO_TEST_ALLOW_ANY_HOST: '1', TAKARO_TEST_HOST_ALLOWLIST: undefined },
      () => {
        assert.doesNotThrow(() => assertTestSafeHost());
      },
    );
  });

  it('passes when host matches TAKARO_TEST_HOST_ALLOWLIST entry', () => {
    withEnv(
      {
        TAKARO_HOST: 'https://my-custom-staging.example.com',
        TAKARO_TEST_ALLOW_ANY_HOST: undefined,
        TAKARO_TEST_HOST_ALLOWLIST: 'my-custom-staging',
      },
      () => {
        assert.doesNotThrow(() => assertTestSafeHost());
      },
    );
  });

  it('returns silently when TAKARO_HOST is not set', () => {
    withEnv(
      { TAKARO_HOST: undefined, TAKARO_TEST_ALLOW_ANY_HOST: undefined, TAKARO_TEST_HOST_ALLOWLIST: undefined },
      () => {
        assert.doesNotThrow(() => assertTestSafeHost());
      },
    );
  });

  it('passes when host matches the third entry of a multi-entry TAKARO_TEST_HOST_ALLOWLIST', () => {
    withEnv(
      {
        TAKARO_HOST: 'https://my-staging.example.com',
        TAKARO_TEST_ALLOW_ANY_HOST: undefined,
        TAKARO_TEST_HOST_ALLOWLIST: 'foo,bar,my-staging',
      },
      () => {
        assert.doesNotThrow(() => assertTestSafeHost());
      },
    );
  });

  it('passes when TAKARO_TEST_HOST_ALLOWLIST entries have surrounding whitespace', () => {
    withEnv(
      {
        TAKARO_HOST: 'https://my-staging.example.com',
        TAKARO_TEST_ALLOW_ANY_HOST: undefined,
        TAKARO_TEST_HOST_ALLOWLIST: ' my-staging , spaced ',
      },
      () => {
        assert.doesNotThrow(() => assertTestSafeHost());
      },
    );
  });

  it('throws when TAKARO_HOST is not a valid URL and no safe substring matches', () => {
    withEnv(
      { TAKARO_HOST: 'not-a-url-at-all', TAKARO_TEST_ALLOW_ANY_HOST: undefined, TAKARO_TEST_HOST_ALLOWLIST: undefined },
      () => {
        assert.throws(() => assertTestSafeHost(), /refused/);
      },
    );
  });

  it('passes for host containing -staging- substring', () => {
    withEnv(
      { TAKARO_HOST: 'https://host-staging-1.example.com', TAKARO_TEST_ALLOW_ANY_HOST: undefined, TAKARO_TEST_HOST_ALLOWLIST: undefined },
      () => {
        assert.doesNotThrow(() => assertTestSafeHost());
      },
    );
  });
});
