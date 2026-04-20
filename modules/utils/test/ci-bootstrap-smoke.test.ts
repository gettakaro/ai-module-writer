import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'ci-bootstrap.sh');
const COMPOSE_FILE = path.join(REPO_ROOT, 'docker-compose.ci.yml');

async function composeDown() {
  await execFileAsync('docker', ['compose', '-f', COMPOSE_FILE, 'down', '--remove-orphans', '--volumes'], {
    cwd: REPO_ROOT,
    env: process.env,
  }).catch(() => undefined);
}

describe('ci bootstrap smoke', () => {
  it('boots the CI stack far enough to export Takaro credentials', { timeout: 15 * 60 * 1000 }, async (t) => {
    if (!process.env.AWS_ECR_REGISTRY) {
      t.skip('AWS_ECR_REGISTRY is not set; skipping CI bootstrap smoke test outside CI.');
      return;
    }

    await composeDown();

    const envFile = path.join(REPO_ROOT, `.tmp-ci-bootstrap-${Date.now()}.env`);
    try {
      const { stdout, stderr } = await execFileAsync('bash', [SCRIPT_PATH], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GITHUB_ENV: envFile,
        },
        timeout: 14 * 60 * 1000,
      });

      const exported = await import('node:fs/promises').then((fs) => fs.readFile(envFile, 'utf8'));
      assert.match(stdout + stderr, /Bootstrap complete\. Takaro stack is ready\./);
      assert.match(exported, /^TAKARO_HOST=http:\/\/localhost:13000$/m);
      assert.match(exported, /^TAKARO_WS_URL=ws:\/\/localhost:3004$/m);
      assert.match(exported, /^TAKARO_DOMAIN_ID=.+$/m);
      assert.match(exported, /^TAKARO_USERNAME=.+$/m);
      assert.match(exported, /^TAKARO_PASSWORD=.+$/m);
      assert.match(exported, /^TAKARO_REGISTRATION_TOKEN=.+$/m);
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(envFile, { force: true }));
      await composeDown();
    }
  });
});
