import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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

async function runBootstrap(extraEnv: NodeJS.ProcessEnv = {}, timeout = 14 * 60 * 1000) {
  return execFileAsync('bash', [SCRIPT_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...extraEnv,
    },
    timeout,
  });
}

describe('ci bootstrap smoke', () => {
  it('boots the CI stack far enough to export Takaro credentials for both GitHub Actions and sourced local-shell usage', { timeout: 30 * 60 * 1000 }, async (t) => {
    if (!process.env.AWS_ECR_REGISTRY) {
      t.skip('AWS_ECR_REGISTRY is not set; skipping CI bootstrap smoke test outside CI.');
      return;
    }

    const envFile = path.join(REPO_ROOT, `.tmp-ci-bootstrap-${Date.now()}.env`);
    try {
      await composeDown();

      const { stdout, stderr } = await runBootstrap({ GITHUB_ENV: envFile });
      const exported = await import('node:fs/promises').then((fs) => fs.readFile(envFile, 'utf8'));
      assert.match(stdout + stderr, /Bootstrap complete\. Takaro stack is ready\./);
      assert.match(exported, /^TAKARO_HOST=http:\/\/localhost:13000$/m);
      assert.match(exported, /^TAKARO_WS_URL=ws:\/\/localhost:3004$/m);
      assert.match(exported, /^TAKARO_DOMAIN_ID=.+$/m);
      assert.match(exported, /^TAKARO_USERNAME=.+$/m);
      assert.match(exported, /^TAKARO_PASSWORD=.+$/m);
      assert.match(exported, /^TAKARO_REGISTRATION_TOKEN=.+$/m);

      await composeDown();

      const shellEnvJson = execFileSync(
        'bash',
        ['-lc', `source ${JSON.stringify(SCRIPT_PATH)} >/tmp/ci-bootstrap-smoke.log && node -e "console.log(JSON.stringify({TAKARO_HOST:process.env.TAKARO_HOST,TAKARO_WS_URL:process.env.TAKARO_WS_URL,TAKARO_DOMAIN_ID:process.env.TAKARO_DOMAIN_ID,TAKARO_USERNAME:process.env.TAKARO_USERNAME,TAKARO_PASSWORD:process.env.TAKARO_PASSWORD,TAKARO_REGISTRATION_TOKEN:process.env.TAKARO_REGISTRATION_TOKEN}))"`],
        {
          cwd: REPO_ROOT,
          env: process.env,
          timeout: 14 * 60 * 1000,
          encoding: 'utf8',
        },
      );

      const exportedShellEnv = JSON.parse(shellEnvJson.trim()) as Record<string, string>;
      assert.equal(exportedShellEnv.TAKARO_HOST, 'http://localhost:13000');
      assert.equal(exportedShellEnv.TAKARO_WS_URL, 'ws://localhost:3004');
      assert.match(exportedShellEnv.TAKARO_DOMAIN_ID, /.+/);
      assert.match(exportedShellEnv.TAKARO_USERNAME, /.+/);
      assert.match(exportedShellEnv.TAKARO_PASSWORD, /.+/);
      assert.match(exportedShellEnv.TAKARO_REGISTRATION_TOKEN, /.+/);
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(envFile, { force: true }));
      await composeDown();
    }
  });
});
