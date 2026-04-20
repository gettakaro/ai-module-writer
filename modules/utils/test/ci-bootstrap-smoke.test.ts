import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

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

async function createMockBootstrapBin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-bootstrap-mock-bin-'));
  const realNode = process.execPath;

  await fs.writeFile(path.join(dir, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >> "\${MOCK_BOOTSTRAP_LOG:?}"
exit 0
`);
  await fs.writeFile(path.join(dir, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "\${MOCK_BOOTSTRAP_LOG:?}"
exit 0
`);
  await fs.writeFile(path.join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  await fs.writeFile(path.join(dir, 'node'), `#!/usr/bin/env bash
set -euo pipefail
REAL_NODE=${JSON.stringify(realNode)}
for arg in "$@"; do
  if [[ "$arg" == *"ci-create-domain.ts" ]]; then
    printf 'node %s\n' "$*" >> "\${MOCK_BOOTSTRAP_LOG:?}"
    cat <<'EOF'
TAKARO_DOMAIN_ID=test-domain-id
TAKARO_USERNAME=test-user@example.com
TAKARO_PASSWORD=test-password
TAKARO_REGISTRATION_TOKEN=test-registration-token
EOF
    exit 0
  fi
done
exec "$REAL_NODE" "$@"
`);

  await Promise.all(['docker', 'curl', 'sleep', 'node'].map((file) => fs.chmod(path.join(dir, file), 0o755)));
  return dir;
}

describe('ci bootstrap smoke', () => {
  it('fails fast with a clear error when AWS_ECR_REGISTRY is not set', async () => {
    await assert.rejects(
      runBootstrap({ AWS_ECR_REGISTRY: '' }, 30_000),
      (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
        const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
        assert.match(output, /AWS_ECR_REGISTRY is required but not set/);
        return true;
      },
    );
  });

  it('keeps the CI compose file wired to the bootstrap environment variables', async () => {
    const compose = await fs.readFile(COMPOSE_FILE, 'utf8');
    assert.match(compose, /\$\{AWS_ECR_REGISTRY\}\/takaro-app-api:/);
    assert.match(compose, /\$\{AWS_ECR_REGISTRY\}\/takaro-app-connector:/);
    assert.match(compose, /\$\{AWS_ECR_REGISTRY\}\/takaro-app-mock-gameserver:/);
    assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD/);
    assert.match(compose, /ADMIN_CLIENT_SECRET: \$\{ADMIN_CLIENT_SECRET\}/);
  });

  it('exercises the bootstrap success path outside CI with mocked infrastructure and exports usable credentials', async () => {
    const envFile = path.join(REPO_ROOT, `.tmp-ci-bootstrap-mocked-${Date.now()}.env`);
    const mockLog = path.join(os.tmpdir(), `ci-bootstrap-mocked-${Date.now()}.log`);
    const mockBin = await createMockBootstrapBin();

    try {
      const bootstrapEnv = {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        AWS_ECR_REGISTRY: process.env.AWS_ECR_REGISTRY || 'mock.registry.local',
        MOCK_BOOTSTRAP_LOG: mockLog,
      };

      const { stdout, stderr } = await execFileAsync('bash', [SCRIPT_PATH], {
        cwd: REPO_ROOT,
        env: {
          ...bootstrapEnv,
          GITHUB_ENV: envFile,
        },
        timeout: 60_000,
      });
      const exported = await fs.readFile(envFile, 'utf8');
      const bootstrapLog = await fs.readFile(mockLog, 'utf8');
      assert.match(stdout + stderr, /Bootstrap complete\. Takaro stack is ready\./);
      assert.match(exported, /^TAKARO_HOST=http:\/\/localhost:13000$/m);
      assert.match(exported, /^TAKARO_WS_URL=ws:\/\/localhost:3004$/m);
      assert.match(exported, /^TAKARO_DOMAIN_ID=test-domain-id$/m);
      assert.match(exported, /^TAKARO_USERNAME=test-user@example.com$/m);
      assert.match(exported, /^TAKARO_PASSWORD=test-password$/m);
      assert.match(exported, /^TAKARO_REGISTRATION_TOKEN=test-registration-token$/m);
      assert.match(bootstrapLog, /docker compose -f .*docker-compose\.ci\.yml down --remove-orphans --volumes/);
      assert.match(bootstrapLog, /docker compose -f .*docker-compose\.ci\.yml up -d postgresql postgresql_kratos redis mailhog/);
      assert.match(bootstrapLog, /docker compose -f .*docker-compose\.ci\.yml exec postgresql pg_isready -U postgres -d takaro-ci-db/);
      assert.match(bootstrapLog, /docker compose -f .*docker-compose\.ci\.yml run --rm kratos-migrate/);
      assert.match(bootstrapLog, /docker compose -f .*docker-compose\.ci\.yml up -d kratos/);
      assert.match(bootstrapLog, /docker compose -f .*docker-compose\.ci\.yml run --rm takaro_api npm -w packages\/app-api run db:migrate/);
      assert.match(bootstrapLog, /docker compose -f .*docker-compose\.ci\.yml up -d takaro_api/);
      assert.match(bootstrapLog, /docker compose -f .*docker-compose\.ci\.yml up -d takaro_connector takaro_mock_gameserver/);
      assert.match(bootstrapLog, /curl -sf -o \/dev\/null http:\/\/localhost:4433\/health\/ready/);
      assert.match(bootstrapLog, /curl -sf -o \/dev\/null http:\/\/localhost:13000\/healthz/);
      assert.match(bootstrapLog, /curl -sf -o \/dev\/null http:\/\/localhost:3003\/healthz/);
      assert.match(bootstrapLog, /curl -sf -o \/dev\/null http:\/\/localhost:3002\/healthz/);
      assert.match(bootstrapLog, /node --import=ts-node-maintained\/register\/esm .*ci-create-domain\.ts/);

      const shellEnvJson = execFileSync(
        'bash',
        ['-lc', `source ${JSON.stringify(SCRIPT_PATH)} >/tmp/ci-bootstrap-smoke.log && node -e "console.log(JSON.stringify({TAKARO_HOST:process.env.TAKARO_HOST,TAKARO_WS_URL:process.env.TAKARO_WS_URL,TAKARO_DOMAIN_ID:process.env.TAKARO_DOMAIN_ID,TAKARO_USERNAME:process.env.TAKARO_USERNAME,TAKARO_PASSWORD:process.env.TAKARO_PASSWORD,TAKARO_REGISTRATION_TOKEN:process.env.TAKARO_REGISTRATION_TOKEN}))"`],
        {
          cwd: REPO_ROOT,
          env: bootstrapEnv,
          timeout: 60_000,
          encoding: 'utf8',
        },
      );

      const exportedShellEnv = JSON.parse(shellEnvJson.trim()) as Record<string, string>;
      assert.equal(exportedShellEnv.TAKARO_HOST, 'http://localhost:13000');
      assert.equal(exportedShellEnv.TAKARO_WS_URL, 'ws://localhost:3004');
      assert.equal(exportedShellEnv.TAKARO_DOMAIN_ID, 'test-domain-id');
      assert.equal(exportedShellEnv.TAKARO_USERNAME, 'test-user@example.com');
      assert.equal(exportedShellEnv.TAKARO_PASSWORD, 'test-password');
      assert.equal(exportedShellEnv.TAKARO_REGISTRATION_TOKEN, 'test-registration-token');
    } finally {
      await fs.rm(envFile, { force: true });
      await fs.rm(mockLog, { force: true });
      await fs.rm(mockBin, { recursive: true, force: true });
    }
  });

  it('boots the CI stack far enough to export Takaro credentials for both GitHub Actions and sourced local-shell usage when CI registry access is available', { timeout: 30 * 60 * 1000 }, async (t) => {
    if (!process.env.AWS_ECR_REGISTRY) {
      t.skip('AWS_ECR_REGISTRY is not set; live CI bootstrap coverage runs in CI.');
      return;
    }

    const envFile = path.join(REPO_ROOT, `.tmp-ci-bootstrap-${Date.now()}.env`);
    try {
      await composeDown();

      const { stdout, stderr } = await runBootstrap({ GITHUB_ENV: envFile });
      const exported = await fs.readFile(envFile, 'utf8');
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
      await fs.rm(envFile, { force: true });
      await composeDown();
    }
  });
});
