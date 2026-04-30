#!/usr/bin/env node
/**
 * Build the registry manifest and per-version JSON files.
 *
 * Reads registry-level metadata from registry.config.json at the repo root,
 * then for each module under modules/ calls buildModuleExport() and writes:
 *   dist/registry/registry.json           — the RegistryManifest
 *   dist/registry/{moduleName}/{version}.json — TakaroModuleExport per module
 *
 * Usage: node dist/scripts/build-registry.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildModuleExport, NO_DESCRIPTION } from './module-to-json.js';
import { RegistryManifest, RegistryManifestModule } from '../types/module.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODULES_DIR = path.join(REPO_ROOT, 'modules');
const DIST_REGISTRY_DIR = path.join(REPO_ROOT, 'dist', 'registry');
const REGISTRY_CONFIG_PATH = path.join(REPO_ROOT, 'registry.config.json');

const MODULE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+)?(?:\+[a-zA-Z0-9._-]+)?$/;
const MAX_DESCRIPTION_LENGTH = 500;

function isSemVer(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

function validateModuleName(name: string): void {
  if (!MODULE_NAME_PATTERN.test(name)) {
    throw new Error(`Module name '${name}' does not match required pattern /^[a-zA-Z0-9_-]+$/`);
  }
  if (name.length > 100) {
    throw new Error(`Module name '${name}' exceeds 100 character limit (length: ${name.length})`);
  }
}

interface RegistryConfig {
  name: string;
  description?: string;
}

function readRegistryConfig(): RegistryConfig {
  if (!fs.existsSync(REGISTRY_CONFIG_PATH)) {
    // Warn and use defaults so that a fresh clone can still run build:registry
    // without needing to create registry.config.json first.
    console.warn(
      `WARNING: registry.config.json not found at ${REGISTRY_CONFIG_PATH}. ` +
        `Using default registry name. Create registry.config.json to customise.`
    );
    return { name: 'Unnamed Registry', description: undefined };
  }
  const raw = fs.readFileSync(REGISTRY_CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw) as RegistryConfig;
  if (!config.name || typeof config.name !== 'string') {
    throw new Error('registry.config.json must have a "name" string field');
  }
  if (config.name.length > 200) {
    throw new Error(`Registry name exceeds 200 character limit (length: ${config.name.length})`);
  }
  if (config.description && config.description.length > 1000) {
    throw new Error(`Registry description exceeds 1000 character limit (length: ${config.description.length})`);
  }
  return config;
}

function getModuleDirs(): string[] {
  const entries = fs.readdirSync(MODULES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function main(): void {
  const config = readRegistryConfig();
  const moduleDirNames = getModuleDirs();

  console.log(`Building registry for ${moduleDirNames.length} modules...`);

  // Safety invariant: confirm the path ends with 'dist/registry' before wiping it.
  // This prevents accidental data loss if REPO_ROOT is misconfigured.
  if (!DIST_REGISTRY_DIR.endsWith('dist/registry')) {
    throw new Error(`Refusing to rmSync ${DIST_REGISTRY_DIR}: expected a dist/registry path`);
  }
  // Clear stale output — ensures removed/renamed modules don't persist in dist/
  fs.rmSync(DIST_REGISTRY_DIR, { recursive: true, force: true });
  ensureDir(DIST_REGISTRY_DIR);

  const manifestModules: RegistryManifestModule[] = [];

  for (const dirName of moduleDirNames) {
    const moduleDir = path.join(MODULES_DIR, dirName);
    console.log(`  Processing: ${dirName}`);

    const moduleExport = buildModuleExport(moduleDir);

    // Extract the first (and currently only) version
    const version = moduleExport.versions[0];
    if (!version) {
      throw new Error(`Module '${dirName}' has no versions`);
    }

    const moduleName = moduleExport.name;
    const semver = version.tag;

    // Validate module name
    validateModuleName(moduleName);

    // Validate semver
    if (!isSemVer(semver)) {
      throw new Error(
        `Module '${dirName}' has version '${semver}' which is not valid semver. ` +
          `Only semver versions are accepted (e.g. 1.0.0).`,
      );
    }

    // Validate description length
    if (version.description && version.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `Module '${dirName}' description exceeds ${MAX_DESCRIPTION_LENGTH} character limit ` +
          `(length: ${version.description.length})`,
      );
    }

    // Write per-version JSON: dist/registry/{moduleName}/{version}.json
    const moduleDistDir = path.join(DIST_REGISTRY_DIR, moduleName);
    ensureDir(moduleDistDir);
    const versionJsonPath = path.join(moduleDistDir, `${semver}.json`);
    fs.writeFileSync(versionJsonPath, JSON.stringify(moduleExport, null, 2));
    console.log(`    Written: ${moduleName}/${semver}.json`);

    manifestModules.push({
      name: moduleName,
      latestVersion: semver,
      versions: [semver],
      description: version.description !== NO_DESCRIPTION ? version.description : undefined,
    });
  }

  // Write registry.json manifest
  const manifest: RegistryManifest = {
    name: config.name,
    description: config.description,
    modules: manifestModules,
  };

  const manifestPath = path.join(DIST_REGISTRY_DIR, 'registry.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nRegistry manifest written to: ${manifestPath}`);
  console.log(`Total modules: ${manifestModules.length}`);
}

main();
