---
description: Test and debug Takaro modules by triggering them and viewing execution logs
argument-hint: [command|hook|cronjob] [gameServerId] [additional params...]
---

You are going to help test and debug a Takaro module component. You need to ultrathink! Follow these steps:

## 1. Determine Component Type
Based on $ARGUMENTS or by asking the user, identify what to test:
- **command**: Requires gameServerId, playerId, and command name/trigger
- **hook**: Requires gameServerId, moduleId, eventType, and eventMeta  
- **cronjob**: Requires gameServerId, moduleId, and cronjobId

## 2. Gather Required Information

### For Commands:
1. **CRITICAL**: First fetch the command prefix using:
   ```
   mcp__takaro-mcp__settingsGet with gameServerId and keys: ["commandPrefix"]
   ```
2. Search for available commands if needed:
   ```
   mcp__takaro-mcp__commandSearch (with filters/extends as needed)
   ```
3. Get online players:
   ```
   mcp__takaro-mcp__gameserverGetPlayers
   ```
4. Find player's Takaro ID:
   ```
   mcp__takaro-mcp__playerSearch (search by steamId or epicOnlineServicesId)
   ```

### For Hooks/Cronjobs:
- Use mcp__takaro-mcp__hookSearch or mcp__takaro-mcp__cronjobSearch
- Use mcp__takaro-mcp__moduleSearch for module IDs
- Use mcp__takaro-mcp__gameserverSearch for gameserver IDs

## 3. Analyze the Module Code First
Before triggering, read and understand the module's code to predict:
- What API calls it should make (these appear as ➡️/⬅️ logs)
- What events it should generate (chat-message, player updates, etc.)
- What console.log outputs to expect
- For hooks: Log eventData first to understand structure (`console.log(JSON.stringify(eventData, null, 2))`)
- Note: The `data` object contents vary by component type (commands vs hooks vs cronjobs)

## 4. Trigger the Component

### For Commands:
```
mcp__takaro-mcp__commandTrigger with:
- id: gameServerId (NOT the commandId!)
- playerId: the player's Takaro ID
- msg: full command with prefix (e.g., "+testing" not "/testing")
```

### For Hooks:
```
mcp__takaro-mcp__hookTrigger with appropriate parameters
```

### For Cronjobs:
```
mcp__takaro-mcp__cronjobTrigger with appropriate parameters
```

## 5. Wait for Execution
Use `Bash sleep 2` to allow execution to complete

## 6. Fetch and Analyze Results

### Primary Check - Execution Event:
```
mcp__takaro-mcp__eventSearch with:
- filters.eventName: ["command-executed"] (or hook-executed, cronjob-executed)
- filters.gameserverId: [gameServerId]
- sortBy: "createdAt"
- sortDirection: "desc"
- limit: 5
```

### Interpreting Logs:
- **Populated logs array**: Module executed and made API calls
  - Look for ➡️ (outgoing) and ⬅️ (incoming) API calls
  - Console.log outputs appear as regular log entries
  - Error details if something failed
- **Empty logs + success:true**: Module executed but likely has a bug
  - Missing imports (`import { data, takaro } from '@takaro/helpers'`)
  - Wrong API method names
  - Syntax errors that were caught
  - Logic errors preventing API calls
- **Empty logs + success:false**: Module failed to execute
  - Check error details in the logs

### Secondary Checks - Side Effects:
Based on the code analysis, check for expected side effects:
- **For message sending**: Check chat-message events
- **For player updates**: Check player-related events
- **For currency changes**: Check currency-added/currency-deducted events

```
mcp__takaro-mcp__eventSearch with appropriate eventName filters
```

## 7. Report Results
Display to the user:
- Execution status (success/failure)
- Log analysis (what happened vs what should have happened)
- Any error messages with stack traces
- Side effects found (or missing)
- Diagnosis of any issues found

## Important Notes:
- Always verify the command prefix - never assume it's "/"
- The gameServerId is used as the id parameter for commandTrigger, not commandId
- Empty logs with success:true usually indicates a bug in the module code itself
- Always check for expected side effects to confirm actual execution

If $ARGUMENTS is provided, parse it to determine the test type and parameters. Otherwise, start by asking what the user wants to test.