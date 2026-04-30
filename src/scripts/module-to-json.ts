#!/usr/bin/env node
/**
 * Convert a local module directory (with consolidated module.json) into the Takaro import JSON format.
 * Usage: node dist/scripts/module-to-json.js <module-dir> [output-file]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  TakaroModuleExport,
  LocalModuleJson,
  ModuleCommand,
  ModuleHook,
  ModuleCronJob,
  ModuleFunction,
} from '../types/module.js';
import { validateEntityName } from '../utils/validate.js';

/**
 * Resolve a path to its real (symlink-free) absolute path, with a friendly error on ENOENT.
 */
function safeRealpath(p: string, label: string): string {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} not found (or is a broken symlink): ${p}`);
    }
    throw e;
  }
}

/**
 * Read the JS code from a file path relative to the module root.
 * Throws an error if the file doesn't exist or path escapes module directory.
 */
function readJsFile(moduleDir: string, relPath: string, label: string): string {
  const resolvedModuleDir = path.resolve(moduleDir);
  const absPath = path.resolve(resolvedModuleDir, relPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Referenced file '${relPath}' not found (for ${label}). Expected at ${absPath}`);
  }
  // Resolve symlinks and check containment — this catches both plain path-traversal and symlink bypass attacks.
  // Note: existsSync passes for broken symlinks but realpathSync throws ENOENT on the target,
  // so we convert that case to the explicit "not found" message.
  const realModuleDir = safeRealpath(resolvedModuleDir, `Module directory '${resolvedModuleDir}'`);
  const realAbsPath = safeRealpath(absPath, `Referenced file '${relPath}' (for ${label})`);
  if (!realAbsPath.startsWith(realModuleDir + path.sep) && realAbsPath !== realModuleDir) {
    throw new Error(`Path '${relPath}' escapes module directory (for ${label})`);
  }
  return fs.readFileSync(realAbsPath, 'utf-8');
}

/**
 * Sentinel used when a module.json has no description field.
 * Exported so build-registry.ts can test for it without a hard-coded string literal.
 */
export const NO_DESCRIPTION = 'No description';

/**
 * Convert a local module directory into a TakaroModuleExport object.
 * This is the reusable core — the CLI is a thin wrapper on top.
 *
 * @param moduleDir - Path to the module directory (containing module.json)
 * @returns TakaroModuleExport ready for import into Takaro or for the registry
 */
export function buildModuleExport(moduleDir: string): TakaroModuleExport {
  if (!fs.existsSync(moduleDir) || !fs.statSync(moduleDir).isDirectory()) {
    throw new Error(`${moduleDir} is not a directory`);
  }

  const moduleJsonPath = path.join(moduleDir, 'module.json');
  if (!fs.existsSync(moduleJsonPath)) {
    throw new Error(`${moduleJsonPath} not found`);
  }

  let mod: LocalModuleJson;
  try {
    mod = JSON.parse(fs.readFileSync(moduleJsonPath, 'utf-8')) as LocalModuleJson;
  } catch (err) {
    throw new Error(`Failed to parse '${moduleJsonPath}': ${(err as Error).message}`);
  }

  validateEntityName(mod.name ?? '', 'module');

  // Validate that commands/hooks/cronJobs/functions if present are plain objects (not arrays)
  for (const field of ['commands', 'hooks', 'cronJobs', 'functions'] as const) {
    const val = mod[field];
    if (val !== undefined && (typeof val !== 'object' || Array.isArray(val))) {
      throw new Error(`'${moduleJsonPath}' field '${field}' must be a plain object (not an array)`);
    }
  }

  // Config schema — inline object or default
  if (mod.config !== undefined) {
    if (typeof mod.config !== 'object' || Array.isArray(mod.config)) {
      throw new Error(`'${moduleJsonPath}' field 'config' must be a plain object (not a string or array)`);
    }
  }
  let configSchema: string;
  if (mod.config && Object.keys(mod.config).length > 0) {
    configSchema = JSON.stringify(mod.config);
  } else {
    configSchema =
      '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{},"required":[],"additionalProperties":false}';
  }

  // UI schema
  if (mod.uiSchema !== undefined) {
    if (typeof mod.uiSchema !== 'object' || Array.isArray(mod.uiSchema)) {
      throw new Error(`'${moduleJsonPath}' field 'uiSchema' must be a plain object (not a string or array)`);
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
        throw new Error(`command '${name}' is missing required field 'function' (path to JS file)`);
      }
      const code = readJsFile(moduleDir, def.function, `command '${name}'`);
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
        throw new Error(`hook '${name}' is missing required field 'eventType'`);
      }
      if (!def.function) {
        throw new Error(`hook '${name}' is missing required field 'function' (path to JS file)`);
      }
      const code = readJsFile(moduleDir, def.function, `hook '${name}'`);
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
        throw new Error(`cronJob '${name}' is missing required field 'temporalValue'`);
      }
      if (!def.function) {
        throw new Error(`cronJob '${name}' is missing required field 'function' (path to JS file)`);
      }
      const code = readJsFile(moduleDir, def.function, `cronJob '${name}'`);
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
        throw new Error(`function '${name}' is missing required field 'function' (path to JS file)`);
      }
      const code = readJsFile(moduleDir, def.function, `function '${name}'`);
      functions.push({
        name,
        function: code,
      });
    }
  }

  return {
    takaroVersion: '0.0.0',
    name: mod.name,
    author: mod.author ?? 'Unknown',
    supportedGames: mod.supportedGames ?? ['all'],
    versions: [
      {
        tag: mod.version ?? 'latest',
        description: mod.description ?? NO_DESCRIPTION,
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
}

// CLI entry point — only runs when executed directly (not when imported as a module).
// In ESM, compare the resolved entry path against this file's path.
const _isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (_isMain) {
  const moduleDir = process.argv[2];
  const outputFile = process.argv[3];

  if (!moduleDir) {
    console.error('Usage: module-to-json.js <module-dir> [output-file]');
    process.exit(1);
  }

  let result: TakaroModuleExport;
  try {
    result = buildModuleExport(moduleDir);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }

  const json = JSON.stringify(result, null, 2);

  if (outputFile) {
    fs.writeFileSync(outputFile, json);
    console.error(`Written to ${outputFile}`);
  } else {
    console.log(json);
  }
}
