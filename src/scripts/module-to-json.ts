#!/usr/bin/env node
/**
 * Convert a local module directory (with consolidated module.json) into the Takaro import JSON format.
 * Usage: node dist/scripts/module-to-json.js <module-dir> [output-file]
 */
import fs from 'fs';
import path from 'path';
import {
  TakaroModuleExport,
  LocalModuleJson,
  ModuleCommand,
  ModuleHook,
  ModuleCronJob,
  ModuleFunction,
} from '../types/module.js';
import { validateEntityName } from '../utils/validate.js';

const moduleDir = process.argv[2];
const outputFile = process.argv[3];

if (!moduleDir) {
  console.error('Usage: module-to-json.js <module-dir> [output-file]');
  process.exit(1);
}

if (!fs.existsSync(moduleDir) || !fs.statSync(moduleDir).isDirectory()) {
  console.error(`ERROR: ${moduleDir} is not a directory`);
  process.exit(1);
}

const moduleJsonPath = path.join(moduleDir, 'module.json');
if (!fs.existsSync(moduleJsonPath)) {
  console.error(`ERROR: ${moduleJsonPath} not found`);
  process.exit(1);
}

let mod: LocalModuleJson;
try {
  mod = JSON.parse(fs.readFileSync(moduleJsonPath, 'utf-8')) as LocalModuleJson;
} catch (err) {
  console.error(`ERROR: Failed to parse '${moduleJsonPath}': ${(err as Error).message}`);
  process.exit(1);
}

validateEntityName(mod.name ?? '', 'module');

// Validate that commands/hooks/cronJobs/functions if present are plain objects (not arrays)
for (const field of ['commands', 'hooks', 'cronJobs', 'functions'] as const) {
  const val = mod[field];
  if (val !== undefined && (typeof val !== 'object' || Array.isArray(val))) {
    console.error(`ERROR: '${moduleJsonPath}' field '${field}' must be a plain object (not an array)`);
    process.exit(1);
  }
}

/**
 * Read the JS code from a file path relative to the module root.
 * Exits with an error if the file doesn't exist or path escapes module directory.
 */
function readJsFile(relPath: string, label: string): string {
  const resolvedModuleDir = path.resolve(moduleDir);
  const absPath = path.resolve(resolvedModuleDir, relPath);
  if (!absPath.startsWith(resolvedModuleDir + path.sep) && absPath !== resolvedModuleDir) {
    console.error(`ERROR: Path '${relPath}' escapes module directory (for ${label})`);
    process.exit(1);
  }
  if (!fs.existsSync(absPath)) {
    console.error(`ERROR: Referenced file '${relPath}' not found (for ${label}). Expected at ${absPath}`);
    process.exit(1);
  }
  // Resolve symlinks and re-check containment to prevent symlink bypass attacks
  const realModuleDir = fs.realpathSync(resolvedModuleDir);
  const realAbsPath = fs.realpathSync(absPath);
  if (!realAbsPath.startsWith(realModuleDir + path.sep) && realAbsPath !== realModuleDir) {
    console.error(`ERROR: Path '${relPath}' escapes module directory via symlink (for ${label})`);
    process.exit(1);
  }
  return fs.readFileSync(realAbsPath, 'utf-8');
}

// Config schema — inline object or default
let configSchema: string;
if (mod.config !== undefined) {
  if (typeof mod.config !== 'object' || Array.isArray(mod.config)) {
    console.error(`ERROR: '${moduleJsonPath}' field 'config' must be a plain object (not a string or array)`);
    process.exit(1);
  }
}
if (mod.config && Object.keys(mod.config).length > 0) {
  configSchema = JSON.stringify(mod.config);
} else {
  configSchema =
    '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{},"required":[],"additionalProperties":false}';
}

// UI schema
if (mod.uiSchema !== undefined) {
  if (typeof mod.uiSchema !== 'object' || Array.isArray(mod.uiSchema)) {
    console.error(`ERROR: '${moduleJsonPath}' field 'uiSchema' must be a plain object (not a string or array)`);
    process.exit(1);
  }
}
let uiSchema: string;
if (mod.uiSchema && Object.keys(mod.uiSchema).length > 0) {
  uiSchema = JSON.stringify(mod.uiSchema);
} else {
  uiSchema = '{}';
}

// Commands
const commands: ModuleCommand[] = [];
if (mod.commands) {
  for (const [name, def] of Object.entries(mod.commands)) {
    validateEntityName(name, 'command');
    if (!def.function) {
      console.error(`ERROR: command '${name}' is missing required field 'function' (path to JS file)`);
      process.exit(1);
    }
    const code = readJsFile(def.function, `command '${name}'`);
    commands.push({
      name,
      trigger: def.trigger ?? name,
      description: def.description ?? null,
      helpText: def.helpText ?? 'No help text available',
      function: code,
      arguments: def.arguments ?? [],
    });
  }
}

// Hooks
const hooks: ModuleHook[] = [];
if (mod.hooks) {
  for (const [name, def] of Object.entries(mod.hooks)) {
    validateEntityName(name, 'hook');
    if (!def.eventType) {
      console.error(`ERROR: hook '${name}' is missing required field 'eventType'`);
      process.exit(1);
    }
    if (!def.function) {
      console.error(`ERROR: hook '${name}' is missing required field 'function' (path to JS file)`);
      process.exit(1);
    }
    const code = readJsFile(def.function, `hook '${name}'`);
    hooks.push({
      name,
      eventType: def.eventType,
      description: def.description ?? null,
      regex: def.regex ?? null,
      function: code,
    });
  }
}

// CronJobs
const cronJobs: ModuleCronJob[] = [];
if (mod.cronJobs) {
  for (const [name, def] of Object.entries(mod.cronJobs)) {
    validateEntityName(name, 'cronJob');
    if (!def.temporalValue) {
      console.error(`ERROR: cronJob '${name}' is missing required field 'temporalValue'`);
      process.exit(1);
    }
    if (!def.function) {
      console.error(`ERROR: cronJob '${name}' is missing required field 'function' (path to JS file)`);
      process.exit(1);
    }
    const code = readJsFile(def.function, `cronJob '${name}'`);
    cronJobs.push({
      name,
      temporalValue: def.temporalValue,
      description: def.description ?? null,
      function: code,
    });
  }
}

// Functions
const functions: ModuleFunction[] = [];
if (mod.functions) {
  for (const [name, def] of Object.entries(mod.functions)) {
    validateEntityName(name, 'function');
    if (!def.function) {
      console.error(`ERROR: function '${name}' is missing required field 'function' (path to JS file)`);
      process.exit(1);
    }
    const code = readJsFile(def.function, `function '${name}'`);
    functions.push({
      name,
      function: code,
    });
  }
}

const result: TakaroModuleExport = {
  takaroVersion: '0.0.0',
  name: mod.name,
  author: mod.author ?? 'Unknown',
  supportedGames: mod.supportedGames ?? ['all'],
  xPiReplacementState: mod.xPiReplacementState,
  versions: [
    {
      tag: mod.version ?? 'latest',
      description: mod.description ?? 'No description',
      configSchema,
      uiSchema,
      commands,
      hooks,
      cronJobs,
      functions,
      permissions: mod.permissions ?? [],
    },
  ],
};

const json = JSON.stringify(result, null, 2);

if (outputFile) {
  fs.writeFileSync(outputFile, json);
  console.error(`Written to ${outputFile}`);
} else {
  console.log(json);
}
