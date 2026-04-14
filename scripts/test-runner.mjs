import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const moduleConcurrency = Math.max(1, Number(process.env.TEST_MODULE_CONCURRENCY ?? '2'));
const runStartedAt = process.env.TEST_RUN_STARTED_AT ?? String(Date.now());

function discoverTestFiles() {
  const output = execFileSync('find', ['modules', '-path', '*/test/*.test.ts'], { encoding: 'utf8' });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function groupByModule(files) {
  const groups = new Map();

  for (const file of files) {
    const parts = file.split('/');
    const moduleName = parts[1] ?? file;
    const entry = groups.get(moduleName) ?? [];
    entry.push(file);
    groups.set(moduleName, entry);
  }

  return [...groups.entries()].map(([moduleName, moduleFiles]) => ({ moduleName, moduleFiles }));
}

function runModuleGroup({ moduleName, moduleFiles }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    console.log(`\n=== [${moduleName}] starting ${moduleFiles.length} test file(s) ===`);

    const child = spawn(
      process.execPath,
      ['--test-force-exit', '--test-concurrency', '1', '--import=ts-node-maintained/register/esm', '--test', ...moduleFiles],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          T_WS_CONTINUOUS_RECONNECT: 'false',
          LOGGING_LEVEL: 'warn',
          TEST_RUN_STARTED_AT: runStartedAt,
        },
      },
    );

    child.on('exit', (code, signal) => {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`=== [${moduleName}] passed in ${durationSeconds}s ===`);
      } else {
        console.error(`=== [${moduleName}] failed in ${durationSeconds}s (code=${code ?? 'null'} signal=${signal ?? 'null'}) ===`);
      }
      resolve({ moduleName, code: code ?? 1, signal });
    });
  });
}

async function main() {
  const files = discoverTestFiles();
  if (files.length === 0) {
    console.log('No test files found.');
    return;
  }

  const groups = groupByModule(files);
  const queue = [...groups];
  const failures = [];

  async function worker() {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      const result = await runModuleGroup(next);
      if (result.code !== 0) failures.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(moduleConcurrency, groups.length) }, () => worker());
  await Promise.all(workers);

  if (failures.length > 0) {
    console.error('\nFailing module groups:');
    for (const failure of failures) {
      console.error(`- ${failure.moduleName} (code=${failure.code} signal=${failure.signal ?? 'null'})`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll ${groups.length} module group(s) passed.`);
}

await main();
