#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const moduleDir = process.argv[2];
if (!moduleDir) {
  console.error('Usage: module-push-runner.mjs <module-dir>');
  process.exit(1);
}

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const createClientPath = pathToFileURL(path.resolve(scriptDir, '../test/helpers/client.ts')).href;
const modulesPath = pathToFileURL(path.resolve(scriptDir, '../test/helpers/modules.ts')).href;

try {
  const [{ createClient }, { pushModule }] = await Promise.all([
    import(createClientPath),
    import(modulesPath),
  ]);

  const client = await createClient();
  const pushed = await pushModule(client, moduleDir);
  process.stdout.write(`${JSON.stringify({ data: pushed }, null, 2)}\n`);
} catch (err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exit(1);
}
