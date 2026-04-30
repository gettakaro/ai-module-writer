/**
 * Shared type definitions for Takaro module structure.
 * Used by conversion scripts and test helpers.
 */

export interface CommandArgument {
  name: string;
  type: string;
  defaultValue?: string | null;
  helpText?: string;
  position?: number;
}

export interface ModuleCommand {
  name: string;
  trigger: string;
  description: string | null;
  helpText: string;
  function: string;
  arguments: CommandArgument[];
}

export interface ModuleHook {
  name: string;
  eventType: string;
  description: string | null;
  regex: string | null;
  function: string;
}

export interface ModuleCronJob {
  name: string;
  temporalValue: string;
  description: string | null;
  function: string;
}

export interface ModuleFunction {
  name: string;
  function: string;
}

export interface ModulePermission {
  permission: string;
  friendlyName: string;
  description: string;
  canHaveCount?: boolean;
}

export interface ModuleVersion {
  tag: string;
  description: string;
  configSchema: string;
  uiSchema: string;
  commands: ModuleCommand[];
  hooks: ModuleHook[];
  cronJobs: ModuleCronJob[];
  functions: ModuleFunction[];
  permissions: ModulePermission[];
}

/** The format for importing/exporting a module to/from Takaro */
export interface TakaroModuleExport {
  takaroVersion: string;
  name: string;
  author: string;
  supportedGames: string[];
  versions: ModuleVersion[];
}

/** A single module entry in the registry manifest */
export interface RegistryManifestModule {
  name: string;
  latestVersion: string;
  versions: string[];
  description?: string;
}

/** The top-level registry manifest served at {base}/registry.json */
export interface RegistryManifest {
  name: string;
  description?: string;
  modules: RegistryManifestModule[];
}

/** New consolidated module.json format — all metadata in one file */
export interface LocalCommandDef {
  trigger: string;
  description?: string | null;
  helpText?: string;
  function: string;
  arguments?: CommandArgument[];
}

export interface LocalHookDef {
  eventType: string;
  description?: string | null;
  regex?: string | null;
  function: string;
}

export interface LocalCronJobDef {
  temporalValue: string;
  description?: string | null;
  function: string;
}

export interface LocalFunctionDef {
  function: string;
}

export interface LocalModuleJson {
  name: string;
  author?: string;
  description?: string;
  version?: string;
  supportedGames?: string[];
  config?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  permissions?: ModulePermission[];
  commands?: Record<string, LocalCommandDef>;
  hooks?: Record<string, LocalHookDef>;
  cronJobs?: Record<string, LocalCronJobDef>;
  functions?: Record<string, LocalFunctionDef>;
}
