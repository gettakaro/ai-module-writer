# /convert-csmm Command

Converts CSMM export to Takaro module configuration.

**Use `takaro-mcp` for all Takaro API calls.**

**Scope:** Modules + role permissions only. 

Takaro's built-in CSMM Import handles:
- ✅ Roles (creation only, no permissions)
- ✅ Players
- ✅ Currency transfer
- ✅ Shop listings

This command handles:
- Cronjobs → Module configs
- Commands → Module configs  
- CSMM config → Module configs
- Role permissions (output what to assign)

---

## Workflow

1. Get CSMM export JSON from user
2. Ask user which gameServerId to target
3. Check installed modules: `moduleInstallationsControllerGetInstalledModules({ filters: { gameserverId } })`
4. Parse CSMM export, map to modules (see below)
5. For each required module:
   - Installed? → Update userConfig
   - Not installed but exists in instance? → Install it, then configure
   - Not in instance? → Tell user to install from modules.takaro.io URL first
6. Output role permission assignments
7. Output gap report
8. Show plan → confirm → execute

**Token Efficiency:**
- ⛔ Avoid unfiltered `moduleSearch` (~13k tokens)
- ✅ Use `moduleInstallationsControllerGetInstalledModules({ filters: { gameserverId } })`
- ✅ Search specific: `moduleSearch({ filters: { name: ['DynamicCronjobs'] }, limit: 1 })`

---

## 1. CronJobs

**⚠️ IMPORTANT:** If command starts with `say ` → DynamicServerMessages, NOT DynamicCronjobs

```
CSMM CronJob
├─ command.trim().startsWith("say ") ? → DynamicServerMessages
└─ Everything else → DynamicCronjobs
```

### → DynamicServerMessages (for `say` commands ONLY)

```javascript
const sayMessages = csmmExport.cronJobs
  .filter(cj => cj.enabled && cj.command.trim().toLowerCase().startsWith('say '))
  .map(cj => ({
    message: cj.command.replace(/^say\s+["']?|["']?$/gi, ''),
    temporalValue: cj.temporalValue
  }));

// userConfig: { messages: sayMessages }
```

**Not in instance?** → User installs from: https://modules.takaro.io/module/DynamicServerMessages/latest

### → DynamicCronjobs (for everything EXCEPT `say`)

```javascript
const consoleCronjobs = csmmExport.cronJobs
  .filter(cj => cj.enabled && !cj.command.trim().toLowerCase().startsWith('say '))
  .map(cj => ({
    name: `csmm-${cj.id}`,
    command: cj.command,
    temporalValue: cj.temporalValue
  }));

// userConfig: { cronjobs: consoleCronjobs }
```

**Not in instance?** → User installs from: https://modules.takaro.io/module/DynamicCronjobs/latest

---

## 2. Config → Modules

| CSMM Config | Module | userConfig |
|-------------|--------|------------|
| `zombieKillReward > 0` | economyUtils (built-in) | `{ zombieKillReward: value }` |
| `countryBanConfig.enabled` | geoBlock (built-in) | `{ mode: 'deny', countries: [...], ban: true }` |
| `pingKickEnabled` | highPingKicker (built-in) | `{ pingThreshold: maxPing }` |
| `chatChannelId` | chatBridge (built-in) | `{ onlyGlobalChat: bool }` - install even if bot not activated |
| `enabledGimme` | gimme (built-in) | `{ items: [...], commands: [...] }` |
| `playtimeEarnerEnabled` | PlaytimeReward | `{ interval: playtimeEarnerInterval * 60000, reward: playtimeEarnerAmount }` |
| `votingEnabled` | VotingSystem | `{ rewardAmount: value }` |

**Community module URLs (if not in instance):**
- PlaytimeReward: https://modules.takaro.io/module/PlaytimeReward/latest
- VotingSystem: https://modules.takaro.io/module/VotingSystem/latest

---

## 3. Commands

Match CSMM custom commands to existing module commands. If match found → skip (module handles it).

### 7dtdCommands
`/bike`, `/4x4`, `/gyro`, `/motorcycle`, `/bicycle`, `/drone`, `/home`, `/visit`, `/debuff`, `/gfxon`, `/gfxoff`, `/gfx`, `/link`

**URL:** https://modules.takaro.io/module/7dtdCommands/latest

**Note:** Requires PrismaCore on the 7DTD server

### StaffCommands
`/killall`, `/th`, `/kickall`, `/visitmap`, `/rpd`, `/pull`, `/rdd`, `/pr`, `/unmute`, `/am`, `/arrest`, `/avisit`, `/ban`, `/buff`, `/kick`, `/kill`, `/mute`, `/ocn`, `/release`, `/setjail`, `/wi`, `/rvr`, `/restart`, `/zomb`, `/brender`, `/llp`, `/removeLCB`, `/bundo`, `/admin`, `/abed`, `/restoreL`, `/restoreS`, `/replace`, `/revokecurrency`, `/addcurrency`, `/setwaypointpublic`

**URL:** https://modules.takaro.io/module/StaffCommands/latest

### Built-in modules
- Teleport commands → `teleports`
- Random reward → `gimme`

### → dynamicCommands (for unmatched commands)

For CSMM commands that don't match any existing module, convert them to dynamicCommands config:

```javascript
const unmatchedCommands = csmmExport.customCommands
  .filter(cmd => !matchesExistingModule(cmd.trigger))
  .map(cmd => ({
    trigger: cmd.trigger.replace(/^\//, ''),
    command: cmd.output, // the console command to run
    arguments: parseArguments(cmd), // extract arguments if any
    helpText: cmd.description || `Migrated from CSMM`
  }));

// userConfig: { commands: unmatchedCommands }
```

**URL:** https://modules.takaro.io/module/dynamicCommands/latest

**Note:** Commands sync every 15 minutes via cronjob. Supports argument types: `string`, `number`, `player`, `self`.

### Decision flow
```
CSMM Command trigger
├─ Matches 7dtdCommands list? → Skip, install 7dtdCommands
├─ Matches StaffCommands list? → Skip, install StaffCommands
├─ Teleport related? → teleports (built-in)
├─ Random reward? → gimme (built-in)
└─ No match? → Add to dynamicCommands config
```

---

## 4. Role Permissions

After Takaro's CSMM import creates roles, user must assign permissions:

| CSMM Field | Takaro Permission | Formula |
|------------|-------------------|---------|
| `role.amountOfTeleports` | `TELEPORTS_USE` | count = value |
| `role.economyGiveMultiplier` | `ZOMBIE_KILL_REWARD_OVERRIDE` | count = zombieKillReward × multiplier |
| `countryBanConfig.whiteListedSteamIds` | `GEOBLOCK_IMMUNITY` | assign to those players |

**Output:**
```
ROLE PERMISSIONS (manual):
- Player: TELEPORTS_USE (count: 10)
- Donator: ZOMBIE_KILL_REWARD_OVERRIDE (count: 63)
- Whitelisted players need: GEOBLOCK_IMMUNITY
```

---

## 5. Gap Report

```
GAPS (not converted):
- playerKillReward: 10 - needs custom module
- discordTextEarnerEnabled - not possible in Takaro
- Commands with complex logic (multi-step, conditionals) - may need custom module

User must build custom modules for these edge cases.
```

**Note:** Most simple console commands are now handled by dynamicCommands.

---

## ⛔ DO NOT

- Create custom modules during conversion
- Use unfiltered `moduleSearch`
- Assume module is installed - always check first
- Proceed without user confirming the plan