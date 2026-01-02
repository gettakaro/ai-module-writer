# Takaro Module Development Reference

Your goal is to write Takaro modules. You MUST use the Takaro MCP server to create modules. NEVER write module code on the local filesystem, you should always call the Takaro MCP tools to create/edit/delete modules and the underlying components (commands, hooks, cronjobs, functions, and permissions).

## Overview
Takaro modules are the core mechanism for adding features to game servers. Each module can contain commands, hooks, cronjobs, functions, and permissions.

**Official Docs**: https://docs.takaro.io/advanced/modules

You !!MUST!! read the official documentation and [examples](https://raw.githubusercontent.com/gettakaro/takaro/refs/heads/development/packages/web-docs/docs/modules/modules.json) before writing your own modules.

## Key Components

### Commands
Player-triggered actions with arguments and permission checks.

### Hooks
Event-driven code that responds to game events (player join, chat, etc).

### Cronjobs
Time-based tasks that run on schedule.

### Functions
Reusable code shared across module components.

## Variables System
Persistent key-value storage linked to GameServer, Player, and Module.
- **Unique keys** per GameServer/Player/Module combination
- Use `moduleId` to prevent key collisions

**Docs**: https://docs.takaro.io/advanced/variables

## Development Tips
- Use `Promise.all` for parallel API calls
- Handle errors with `TakaroUserError`

Every module component (command, hook, cronjob) should have this structure (note the imports and the main function):

```javascript
import { data, takaro } from '@takaro/helpers';
async function main() {
    const {} = data;
    await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, {
          message: "Test success!"
    });
}
await main();
```

## Event Data Structures

Different event types provide different data in `eventData`. Always log it first to understand the structure:

```javascript
console.log('Event data:', JSON.stringify(eventData, null, 2));
```

Common event structures:
- **entity-killed**: `{ entity: string, weapon: string, msg: string, timestamp: string, player: {...} }`
- **player-connected/disconnected**: `{ player: { gameId, name, steamId, ... } }`
- **chat-message**: `{ msg: string, channel: string, timestamp: string, player: {...} }`
- **discord-message**: `{ msg: string, author: { displayName, isBot, ... } }`

The `data` object varies by component type:
- **Commands**: `{ gameServerId, player, pog, arguments, module, chatMessage }`
- **Hooks**: `{ gameServerId, eventData, player, module }`
- **Cronjobs**: `{ gameServerId, module }`

## Debugging Modules

You can debug failing modules using the events endpoint:
- **Filter events** by module ID or event names (`command-executed`, `hook-executed`, `cronjob-executed`)
- **Event metadata** contains detailed logs from module execution, including `console.log` outputs
- **Every execution creates an event** with detailed logs of all API calls and console outputs

### Common Pitfalls
- **Missing imports**: Without `import { data, takaro } from '@takaro/helpers'` code fails silently
- **Wrong API method names**: Check camelCase carefully (e.g., `gameServerController` not `gameserverController`)
- **Not awaiting async operations**: Always use `await` for API calls
- **Assuming data exists**: Check for undefined values in eventData before using them

### Debugging Strategy
1. Add console.logs throughout your code
2. Execute the module again
3. Check the execution event for logs
4. **Verify side effects**: Check for expected events (chat-message, player updates, etc.)
5. **Empty logs + success:true** = Module bug (wrong method names, missing imports)

**Custom Modules Guide**: https://docs.takaro.io/advanced/custom-modules


## CSMM Conversion

Run `/convert-csmm` to convert CSMM exports to Takaro modules.
See `commands/convert-csmm.md` for details.