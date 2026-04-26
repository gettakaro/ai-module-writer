#!/usr/bin/env node
/**
 * Convert a Takaro export JSON into a local module directory with consolidated module.json.
 * Usage: node dist/scripts/json-to-module.js <json-file> [output-dir]
 * If output-dir is omitted, creates under ./modules/<module-name>/
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  TakaroModuleExport,
  ModuleVersion,
  LocalModuleJson,
  LocalCommandDef,
  LocalHookDef,
  LocalCronJobDef,
  LocalFunctionDef,
} from '../types/module.js';
import { validateEntityName } from '../utils/validate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const jsonFile = process.argv[2];
const outputDirArg = process.argv[3];

if (!jsonFile) {
  console.error('Usage: json-to-module.js <json-file> [output-dir]');
  process.exit(1);
}

interface WrappedExport {
  data?: TakaroModuleExport;
}

let raw: TakaroModuleExport | WrappedExport;
try {
  raw = JSON.parse(fs.readFileSync(jsonFile, 'utf-8')) as TakaroModuleExport | WrappedExport;
} catch (err) {
  console.error(`ERROR: Failed to parse JSON from '${jsonFile}': ${(err as Error).message}`);
  process.exit(1);
}

// Handle both raw export data and API-wrapped format (with .data envelope)
const data: TakaroModuleExport = (raw as WrappedExport).data ?? (raw as TakaroModuleExport);

if (!data.name) {
  console.error('ERROR: Export JSON is missing required field "name"');
  process.exit(1);
}

if (!data.versions || !Array.isArray(data.versions)) {
  console.error('ERROR: Export JSON is missing required field "versions"');
  process.exit(1);
}

const { name, author = 'Unknown', supportedGames = ['all'] } = data;

// Validate module name (prevents empty, whitespace, and path traversal)
try {
  validateEntityName(name, 'module');
} catch (err) {
  console.error(`ERROR: ${(err as Error).message}`);
  process.exit(1);
}

// Pick the "latest" version, or the first one
const version: ModuleVersion | undefined =
  data.versions.find((v) => v.tag === 'latest') ?? data.versions[0];
if (!version) {
  console.error('ERROR: No versions found in export');
  process.exit(1);
}

// __dirname is dist/scripts/ — go up 2 levels to reach repo root
const repoDir = path.resolve(__dirname, '..', '..');
const outputDir = outputDirArg ?? path.join(repoDir, 'modules', name);

// Validate all entity names and function fields before writing any files
try {
  if (version.commands) {
    for (const cmd of version.commands) {
      validateEntityName(cmd.name, 'command');
      if (!cmd.function || typeof cmd.function !== 'string') {
        console.error(`ERROR: command '${cmd.name}' is missing required field 'function' (JS code)`);
        process.exit(1);
      }
    }
  }
  if (version.hooks) {
    for (const hook of version.hooks) {
      validateEntityName(hook.name, 'hook');
      if (!hook.function || typeof hook.function !== 'string') {
        console.error(`ERROR: hook '${hook.name}' is missing required field 'function' (JS code)`);
        process.exit(1);
      }
    }
  }
  if (version.cronJobs) {
    for (const cron of version.cronJobs) {
      validateEntityName(cron.name, 'cronJob');
      if (!cron.function || typeof cron.function !== 'string') {
        console.error(`ERROR: cronJob '${cron.name}' is missing required field 'function' (JS code)`);
        process.exit(1);
      }
    }
  }
  if (version.functions) {
    for (const fn of version.functions) {
      validateEntityName(fn.name, 'function');
      if (!fn.function || typeof fn.function !== 'string') {
        console.error(`ERROR: function '${fn.name}' is missing required field 'function' (JS code)`);
        process.exit(1);
      }
    }
  }
} catch (err) {
  console.error(`ERROR: ${(err as Error).message}`);
  process.exit(1);
}

console.error(`Extracting module '${name}' to ${outputDir}`);
if (fs.existsSync(outputDir)) {
  console.warn(`WARN: Output directory '${outputDir}' already exists — files may be overwritten`);
}
fs.mkdirSync(outputDir, { recursive: true });

// Build consolidated module.json
const newModule: LocalModuleJson = {
  name,
  author,
  description: version.description ?? 'No description',
  version: version.tag ?? 'latest',
  supportedGames,
};

// Parse and inline the config schema — only include if it has actual properties
try {
  const configSchema =
    typeof version.configSchema === 'string'
      ? (JSON.parse(version.configSchema) as Record<string, unknown>)
      : ((version.configSchema ?? {}) as Record<string, unknown>);
  const props = configSchema['properties'];
  const hasProperties = props !== null && typeof props === 'object' && !Array.isArray(props) && Object.keys(props as object).length > 0;
  if (hasProperties) {
    newModule.config = configSchema;
  }
} catch (err) {
  console.error(`WARN: Failed to parse configSchema, omitting: ${(err as Error).message}`);
}

// Parse and inline the UI schema (only if non-empty)
try {
  const uiSchema =
    typeof version.uiSchema === 'string'
      ? (JSON.parse(version.uiSchema) as Record<string, unknown>)
      : ((version.uiSchema ?? {}) as Record<string, unknown>);
  if (Object.keys(uiSchema).length > 0) {
    newModule.uiSchema = uiSchema;
  }
} catch (err) {
  console.error(`WARN: Failed to parse uiSchema, omitting: ${(err as Error).message}`);
}

// Permissions
if (version.permissions && version.permissions.length > 0) {
  newModule.permissions = version.permissions;
  console.error(`  permissions: ${version.permissions.length} entries`);
}

// Commands
if (version.commands && version.commands.length > 0) {
  const cmdsDir = path.join(outputDir, 'src', 'commands');
  fs.mkdirSync(cmdsDir, { recursive: true });
  const commands: Record<string, LocalCommandDef> = {};
  for (const cmd of version.commands) {
    const cmdDir = path.join(cmdsDir, cmd.name);
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'index.js'), cmd.function);
    const relPath = `src/commands/${cmd.name}/index.js`;
    commands[cmd.name] = {
      trigger: cmd.trigger,
      description: cmd.description ?? null,
      helpText: cmd.helpText ?? 'No help text available',
      function: relPath,
      arguments: cmd.arguments ?? [],
    };
    console.error(`  command: ${cmd.name}`);
  }
  newModule.commands = commands;
}

// Hooks
if (version.hooks && version.hooks.length > 0) {
  const hooksDir = path.join(outputDir, 'src', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hooks: Record<string, LocalHookDef> = {};
  for (const hook of version.hooks) {
    const hookDir = path.join(hooksDir, hook.name);
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'index.js'), hook.function);
    const relPath = `src/hooks/${hook.name}/index.js`;
    const hookDef: LocalHookDef = {
      eventType: hook.eventType,
      description: hook.description ?? null,
      function: relPath,
    };
    if (hook.regex != null) {
      hookDef.regex = hook.regex;
    }
    hooks[hook.name] = hookDef;
    console.error(`  hook: ${hook.name}`);
  }
  newModule.hooks = hooks;
}

// Cronjobs
if (version.cronJobs && version.cronJobs.length > 0) {
  const cronDir = path.join(outputDir, 'src', 'cronjobs');
  fs.mkdirSync(cronDir, { recursive: true });
  const cronJobs: Record<string, LocalCronJobDef> = {};
  for (const cron of version.cronJobs) {
    const cjDir = path.join(cronDir, cron.name);
    fs.mkdirSync(cjDir, { recursive: true });
    fs.writeFileSync(path.join(cjDir, 'index.js'), cron.function);
    const relPath = `src/cronjobs/${cron.name}/index.js`;
    cronJobs[cron.name] = {
      temporalValue: cron.temporalValue,
      description: cron.description ?? null,
      function: relPath,
    };
    console.error(`  cronjob: ${cron.name}`);
  }
  newModule.cronJobs = cronJobs;
}

// Functions
if (version.functions && version.functions.length > 0) {
  const fnDir = path.join(outputDir, 'src', 'functions');
  fs.mkdirSync(fnDir, { recursive: true });
  const functions: Record<string, LocalFunctionDef> = {};
  for (const fn of version.functions) {
    fs.writeFileSync(path.join(fnDir, `${fn.name}.js`), fn.function);
    const relPath = `src/functions/${fn.name}.js`;
    functions[fn.name] = { function: relPath };
    console.error(`  function: ${fn.name}`);
  }
  newModule.functions = functions;
}

// Write the single consolidated module.json
fs.writeFileSync(
  path.join(outputDir, 'module.json'),
  JSON.stringify(newModule, null, 2) + '\n',
);

console.error(`Done. Module extracted to ${outputDir}`);
