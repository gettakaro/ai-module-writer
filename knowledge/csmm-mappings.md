# CSMM to Takaro Converter

## /convert-csmm Command

Converts CSMM export to Takaro module configuration.

**Scope:** Modules only. Use Takaro's built-in CSMM Import for roles, players, currency, shop.

**Workflow:**
1. Get CSMM export JSON from user
2. Check installed modules on target server
3. Convert CronJobs, Hooks, Commands (see mappings below)
4. Show plan → confirm → execute

**Token Efficiency:**
- ⛔ Avoid unfiltered `moduleSearch` (~13k tokens)
- ✅ Use `moduleInstallationsControllerGetInstalledModules({ filters: { gameserverId } })` 
- ✅ Search specific modules: `moduleSearch({ filters: { name: ['moduleName'] }, limit: 1 })`

---

## CSMM → Takaro Mapping

CSMM has three main things to convert:

| CSMM | Takaro Solution |
|------|-----------------|
| **CronJobs** | DynamicCronjobs, DynamicServerMessages, serverMessages |
| **Hooks** | Built-in modules (economyUtils, chatBridge, etc.) |
| **Commands** | CPMCommands, CPMStaffCommands, built-in modules |

---

## 1. CronJobs

### Decision Tree

```
CSMM CronJob
│
├─ Command starts with "say "?
│   ├─ All same schedule? → serverMessages (built-in)
│   └─ Different schedules? → DynamicServerMessages
│
└─ Console command (giveplus, shutdownba, etc.)?
    └─ DynamicCronjobs
```

### → serverMessages (built-in)

**When:** Say-only cronjobs, all can share same schedule (rotating)

**Config:**
```javascript
{ messages: ["Message 1", "Message 2", "Message 3"] }
```

**Extract message:**
```javascript
const match = command.match(/say\s+["'](.+?)["']|say\s+(.+)/i);
const message = match ? (match[1] || match[2]).trim() : null;
```

---

### → DynamicServerMessages (community)

**When:** Say messages need individual schedules

**URL:** https://modules.takaro.io/module/DynamicServerMessages/latest

**Generator workflow:**
1. Update userConfig
2. cronJobGenerator hook runs automatically
3. Creates individual cronjobs

**Config:**
```javascript
{
  messages: [
    { message: "Welcome!", temporalValue: "*/30 * * * *" },
    { message: "Vote for us!", temporalValue: "0 * * * *" }
  ]
}
```

**Conversion:**
```javascript
const sayMessages = csmmExport.cronJobs
  .filter(cj => cj.enabled && cj.command.trim().match(/^say\s/i))
  .map(cj => {
    const match = cj.command.match(/^say\s+["'](.+)["']$/i);
    return {
      message: match ? match[1] : cj.command.replace(/^say\s+/i, ''),
      temporalValue: cj.temporalValue
    };
  });

await takaro.module.moduleInstallationsControllerUpdateModuleInstallation(
  moduleInstallationId,
  { userConfig: { messages: sayMessages } }
);
```

---

### → DynamicCronjobs (community)

**When:** Console commands on schedules (giveplus, shutdownba, resetregions, etc.)

**URL:** https://modules.takaro.io/module/DynamicCronjobs/latest

**Generator workflow:** Same as DynamicServerMessages

**Config:**
```javascript
{
  cronjobs: [
    { name: "Restart Gift", command: "giveplus all 'item' 2", temporalValue: "0 6 * * *" }
  ]
}
```

**Conversion:**
```javascript
const consoleCronjobs = cssmExport.cronJobs
  .filter(cj => cj.enabled && !cj.command.trim().match(/^say\s/i))
  .map(cj => ({
    name: `csmm-${cj.id}`,
    command: cj.command,
    temporalValue: cj.temporalValue
  }));

await takaro.module.moduleInstallationsControllerUpdateModuleInstallation(
  moduleInstallationId,
  { userConfig: { cronjobs: consoleCronjobs } }
);
```

---

## 2. Hooks

CSMM hooks map to built-in Takaro modules. Install and configure these:

| CSMM Config | Takaro Module |
|-------------|---------------|
| `zombieKillReward > 0` | economyUtils |
| `playerKillReward > 0` | economyUtils |
| `playtimeEarnerEnabled` | economyUtils |
| `countryBanConfig.enabled` | geoBlock |
| `pingKickEnabled` | highPingKicker |
| `chatChannelId` (non-empty) | chatBridge |

### economyUtils

**CSMM:** Kill rewards, playtime rewards

```javascript
// Set currency name
await takaro.settings.settingsControllerSet({
  key: 'currencyName',
  value: config.currencyName,
  gameServerId
});
```

### geoBlock

**CSMM:** `config.countryBanConfig`

**Config:**
```javascript
{
  mode: config.countryBanListMode ? 'allow' : 'deny',
  countries: config.countryBanConfig.bannedCountries,
  ban: config.countryBanConfig.ban,
  message: config.countryBanConfig.kickMessage
}
```

### highPingKicker

**CSMM:** `config.pingKickEnabled`

**Config:**
```javascript
{
  pingThreshold: config.maxPing,
  warningsBeforeKick: config.pingChecksToFail
}
```

### chatBridge

**CSMM:** `config.chatChannelId`

**Config:**
```javascript
{ onlyGlobalChat: config.chatChannelGlobalOnly }
```

**Note:** User must set up Discord integration manually first.

---

## 3. Commands

### Decision Tree

```
CSMM Custom Command
│
├─ Vehicle? (drone, bike, gyro, jeep, car)
│   └─ CPMCommands
│
├─ Staff? (debuff, teleport, kill, kick)
│   └─ CPMStaffCommands
│
├─ Teleport related?
│   └─ teleports (built-in)
│
├─ Random reward?
│   └─ gimme (built-in)
│
└─ Unknown?
    └─ List in report, do NOT create custom module
```

### → CPMCommands (community)

**Covers:** /drone, /bike, /gyro, /jeep, /car, /minibike

**URL:** https://modules.takaro.io/module/CPMCommands/latest

**Action:** If installed, these commands already exist. Skip.

---

### → CPMStaffCommands (community)

**Covers:** /debuff, staff teleport, kick commands

**URL:** https://modules.takaro.io/module/CPMStaffCommands/latest

**Action:** If installed, these commands already exist. Skip.

---

### → teleports (built-in)

**CSMM:** `config.enabledPlayerTeleports`

**Config:**
```javascript
{
  timeout: config.playerTeleportDelay * 1000,  // seconds → ms
  allowPublicTeleports: config.costToMakeTeleportPublic >= 0
}
```

**Note:** CSMM teleport costs don't convert - Takaro teleports are free.

---

### → gimme (built-in)

**CSMM:** `config.enabledGimme` + `gimmeItems` array

**Config:**
```javascript
{
  items: gimmeItems
    .filter(g => g.type === 'item')
    .map(g => ({ item: g.value, amount: 1, quality: '' })),
  commands: gimmeItems
    .filter(g => g.type === 'command')
    .map(g => g.value)
}
```

---

## Community Module URLs

| Module | URL |
|--------|-----|
| DynamicCronjobs | https://modules.takaro.io/module/DynamicCronjobs/latest |
| DynamicServerMessages | https://modules.takaro.io/module/DynamicServerMessages/latest |
| CPMCommands | https://modules.takaro.io/module/CPMCommands/latest |
| CPMStaffCommands | https://modules.takaro.io/module/CPMStaffCommands/latest |
| droneTeleports | https://modules.takaro.io/module/droneTeleports/latest |

---

## Variable Translation

| CSMM | Takaro |
|------|--------|
| `${player.entityId}` | `data.player.entityId` |
| `${player.steamId}` | `data.player.steamId` |
| `${player.name}` | `data.player.name` |
| `${player.positionX/Y/Z}` | `data.pog.positionX/Y/Z` |

---

## Things That Don't Convert

| CSMM Feature | Reason |
|--------------|--------|
| Teleport costs | Takaro teleports are free |
| economyGiveMultiplier | No built-in VIP bonus |
| Discord text earner | No equivalent |
| logLine regex hooks | Need custom implementation |

---

## ⛔ DO NOT Create Custom Modules

If a feature isn't covered by built-in or community modules:
- List it in the conversion report
- Tell user it needs a custom module
- **DO NOT** write custom module code during conversion