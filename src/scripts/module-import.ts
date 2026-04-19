#!/usr/bin/env node
/**
 * Import a Takaro module export JSON using the API client instead of raw curl.
 * This preserves nested version payloads that the shell import path can drop.
 * Usage: node dist/scripts/module-import.js <module-export-json-file>
 */
import fs from 'fs';
import { config } from 'dotenv';
import { Client, ModuleOutputDTO } from '@takaro/apiclient';
import { TakaroModuleExport } from '../types/module.js';

config();

const jsonFile = process.argv[2];

if (!jsonFile) {
  console.error('Usage: module-import.js <module-export-json-file>');
  process.exit(1);
}

const url = process.env['TAKARO_HOST'];
const username = process.env['TAKARO_USERNAME'];
const password = process.env['TAKARO_PASSWORD'];
const domainId = process.env['TAKARO_DOMAIN_ID'];

if (!url) throw new Error('TAKARO_HOST is required');
if (!username) throw new Error('TAKARO_USERNAME is required');
if (!password) throw new Error('TAKARO_PASSWORD is required');
if (!domainId) throw new Error('TAKARO_DOMAIN_ID is required');

let moduleExport: TakaroModuleExport;
try {
  moduleExport = JSON.parse(fs.readFileSync(jsonFile, 'utf-8')) as TakaroModuleExport;
} catch (err) {
  console.error(`ERROR: Failed to parse module export from '${jsonFile}': ${(err as Error).message}`);
  process.exit(1);
}

if (!moduleExport?.name) {
  console.error(`ERROR: Module export '${jsonFile}' is missing required field 'name'`);
  process.exit(1);
}

const client = new Client({
  url,
  auth: { username, password },
  log: false,
});

await client.login();
client.setDomain(domainId);

const existing = await client.module.moduleControllerSearch({
  filters: { name: [moduleExport.name] },
});
const existingModule = existing.data.data.find((mod) => mod.name === moduleExport.name);
if (existingModule) {
  console.error(`Module '${moduleExport.name}' already exists (id: ${existingModule.id}), deleting before re-import...`);
  await client.module.moduleControllerRemove(existingModule.id);
  console.error(`Deleted existing module ${existingModule.id}`);
}

try {
  await client.module.moduleControllerImport(moduleExport);
} catch (err) {
  if (existingModule) {
    throw new Error(
      `Import of '${moduleExport.name}' failed. Previous module version was deleted before this import failure. Cause: ${err}`,
    );
  }
  throw err;
}

const searchResult = await client.module.moduleControllerSearch({
  filters: { name: [moduleExport.name] },
});

const found = searchResult.data.data.find((mod) => mod.name === moduleExport.name);
if (!found) {
  throw new Error(`Module '${moduleExport.name}' not found after import`);
}

console.error(`Successfully imported module '${found.name}' (id: ${found.id})`);
console.log(JSON.stringify({ data: found satisfies ModuleOutputDTO }, null, 2));
