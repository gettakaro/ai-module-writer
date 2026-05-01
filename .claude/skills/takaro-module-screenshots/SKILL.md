---
name: takaro-module-screenshots
description: "Use after a Takaro module is verified and needs publish-ready dashboard screenshots, Markdown image links, or a community module description. Covers install/update config drawers, chat or overview evidence, module events, and documentation-ready screenshot validation."
---

# Takaro Module Screenshots

## Overview

Capture Takaro dashboard screenshots for a verified module and turn them into documentation-ready Markdown. V1 is dashboard-only: Paper and bot activity may be used to make Takaro chat or events visible, but every screenshot must come from the Takaro dashboard. Do not capture Minecraft client screenshots.

## Inputs And Paths

- Run this only after `takaro-module-dev` has created the module and completed its automated plus in-game verification.
- Work from the module-writer checkout that contains `modules/<name>/module.json`. Prefer the current working directory when it has `modules/`; otherwise use the checkout explicitly provided by the user.
- Save captured PNG files under `modules/<name>/screenshots/` by default.
- Resolve the community modules viewer checkout only when publishing or updating viewer content. Use `COMMUNITY_MODULES_VIEWER_DIR` when set; otherwise look for a sibling directory named `community-modules-viewer` next to the module-writer checkout, then ask the user for the path if needed.
- When publishing, copy the curated PNGs from `modules/<name>/screenshots/` to `<community_modules_viewer_dir>/images/`.
- Do not add project-specific server discovery unless the user explicitly asks for it.

## Gather Facts

1. Read `modules/<name>/module.json`.
2. Extract the module name, folder name, short purpose, supported games, config schema, commands, hooks, cronjobs, permissions, and dependencies.
3. Build a component evidence matrix before opening the dashboard. Include every command, hook, and cronjob from `module.json`; for each one record whether it is user-facing, how it was verified, what dashboard chat or event evidence should prove it, and whether it needs a dedicated screenshot or can be covered by a grouped screenshot.
4. Use the existing test and verification notes from `takaro-module-dev` to identify the exact flows that passed, including command examples, hook triggers, cronjob triggers, config values, game server, bot names, event filters, and expected dashboard evidence.
5. If the handoff is thin, inspect `modules/<name>/test/` to infer only what the tests actually exercise.
6. For local screenshot runs, do not require any community viewer files. If publishing to `community-modules-viewer` and a format reference is needed, use `<community_modules_viewer_dir>/public/modules/minigames/BlackJack.json` only when it exists. Do not copy its content or treat it as a behavioral target.

## Filename Contract

- Build `module_slug` from the module folder name: lowercase it and strip everything except `a-z` and `0-9`. Example: `daily-rewards` becomes `dailyrewards`.
- Name screenshots `<module_slug>_<purpose>.png`, for example `dailyrewards_config.png`, `dailyrewards_daily.png`, or `dailyrewards_events.png`.
- Use purpose names that match the visible evidence: command triggers, `config`, `permissions`, `events`, `chat`, or a specific flow name.
- Do not create or reference a separate `_install` screenshot when it shows the same update/config drawer as `_config`. Use `_install` only for a visually distinct install step, enable confirmation, available-module selection, or installed-module overview. For installed modules where the useful view is the settings drawer, name it `_config` and keep only the config images.
- Local draft Markdown should reference local screenshots with relative paths, for example:

```md
![Caption](./screenshots/<filename>.png)
```

- Published Markdown for `community-modules-viewer` must use raw GitHub URLs and every linked image must be copied to `<community_modules_viewer_dir>/images/`:

```md
![Caption](https://raw.githubusercontent.com/gettakaro/community-modules-viewer/refs/heads/main/images/<filename>.png)
```

Do not include planned, placeholder, or missing screenshots in Markdown. Raw GitHub image URLs become valid after the `community-modules-viewer` PR is merged to `main`.

## Dashboard Workflow

Use the available browser automation tool for dashboard navigation, interaction, and screenshots. Prefer Playwright when available.

1. Determine the dashboard URL. Prefer an explicit URL from the handoff. Otherwise use `https://dashboard.takaro.io`; for a local Takaro stack with `TAKARO_HOST` on port `13000`, use `http://127.0.0.1:13001/dashboard`.
2. Log in with the existing Takaro environment credentials when needed, but never print passwords, tokens, cookies, or full secret-bearing URLs.
3. Use a desktop viewport such as `1440x1000` unless the user asks for responsive screenshots.
4. Open the target game server and module install/update screen in the dashboard.
5. Wait for loading states to finish before every screenshot. Prefer element screenshots for modals and tables when the full page would include distracting or sensitive content.

## Shots To Capture

Capture only dashboard UI.

1. **Install, update, or config view**
   Capture the module install/update/config modal with the module name and meaningful settings visible. Fill in the verified config values from the module-development handoff.
   If the update view is just the module's configurable settings, treat it as a config screenshot and name it `<module_slug>_config.png`. Do not also capture `<module_slug>_install.png` unless it shows distinct install evidence that is useful on its own.
   For installed modules, the preferred config evidence is the actual update/config drawer opened from the installed module action menu, such as **Change module configuration**. Do not use the installed-module list card as `<module_slug>_config.png` when that drawer or route is reachable.
   If clicking the action menu is flaky in headless Playwright, navigate through the action menu route or click coordinates only after confirming the menu contains **Change module configuration**. A valid `_config.png` must visibly show config UI such as `Update module`, `User config`, `System config`, `enabled`, `hooks`, `commands`, `cronjobs`, or permission fields.

2. **Scrolled config sections**
   Always check whether the config drawer/modal scrolls before finishing the config set. In Playwright, inspect the likely scroll container with `scrollHeight > clientHeight`, or manually scroll and compare `scrollTop` before/after. Expand relevant accordions such as hooks, commands, cronjobs, permissions, user config, and system config before this check.
   If there is scrollable content, capture the top section and then scroll down until the bottom is visible, taking follow-up images for every distinct section needed to document setup. Name follow-up images with clear suffixes such as `_config_2`, `_config_3`, `_permissions`, `_hooks`, or `_commands`. Do not leave lower command or hook settings cut off; capture another image when a section continues below the viewport.

3. **Dashboard chat or overview**
   Re-run the verified flow with the Takaro API, Paper server, or bot service only as needed to make dashboard-visible chat or overview evidence appear. Capture the dashboard view after the activity is visible.
   For player-facing modules, make sure the chat evidence covers the real command and message flow, not just one isolated command. The final chat screenshot should demonstrate the module's normal user experience: player command input, server response, and any broadcast/private messages from relevant commands, hooks, or cronjobs.
   For Paper/bot-backed chat screenshots:
   - Open the game server dashboard console before sending bot chat, so the websocket-backed console receives the live messages.
   - Use `waitUntil: 'domcontentloaded'` for dashboard console navigation; `networkidle` can hang because the console keeps websocket/network activity open.
   - If using the local bot service, create short bot names, space joins by several seconds to avoid Paper's connection throttle, and delete bots after the screenshot.
   - Do not look up Paper players by visible username in Takaro. Offline-mode Paper stores `gameId` as the offline UUID (`OfflinePlayer:<username>`), so compute that UUID or search existing player-on-gameserver rows before assigning permissions or querying variables.
   - Keep the module installation and bots alive until the screenshot has been opened and visually accepted. Cleanup only after chat and event screenshots are confirmed.

4. **Module events**
   Capture the event/log view filtered to the module evidence generated by the tested flow, such as `command-executed`, `hook-executed`, or `cronjob-executed`. Prefer a screenshot that shows `success: true`, the component name, and useful logs without exposing secrets.
   Prefer readable dashboard event rows over raw JSON modals. Use raw JSON only when it is the clearest way to show `success: true` or component metadata, and never publish a cropped mid-object JSON screenshot.

5. **Component coverage**
   Go through every command, hook, and cronjob from the component evidence matrix before declaring the screenshot set complete. Each component must be documented in one of these ways:
   - visible in a config/commands/hooks/cronjobs screenshot,
   - visible in chat or overview evidence,
   - visible in an event screenshot,
   - or explicitly called out in the final report as not dashboard-visible, not exercised in the handoff, or intentionally covered by another screenshot.

   Do not clean up the test bot, module installation, or pushed test module until the chat and event screenshots have been opened and visually accepted.

If a module has no user config, still capture the installed module's update/config drawer when it shows system config, enable state, hooks, commands, cronjobs, or permissions. Use the install/enable confirmation or installed-module details screen only when there is no installed-module config/update drawer available after an explicit attempt to open it. If the dashboard cannot show a tested flow, state that limitation and do not invent a screenshot.

## Module Description

After capturing and validating screenshots, update `modules/<name>/module.json` so its `description` field contains documentation-ready Markdown. The description should use the screenshots as evidence, placed near the setup step, command, hook, cronjob, or event explanation they illustrate. Do not dump all screenshots at the top or bottom.

Use this structure when the module has the relevant parts:

- A short value proposition.
- Key features grounded in verified behavior.
- Configuration section with the config/update screenshot immediately after the setup explanation it illustrates.
- Commands section with triggers, arguments, expected output, and command/chat screenshots immediately after the command flow they illustrate.
- Hooks and cronjobs section when the module has them, with event types/schedules, what they do, and dashboard evidence when available.
- Dashboard events or operations section when event screenshots clarify hooks, cronjobs, or admin flows.
- Requirements or dependencies only when they are real, such as economy, Discord, permissions, or game-specific support.

Local module descriptions must use local screenshot links such as `./screenshots/<filename>.png`. If the user asks to publish to `community-modules-viewer`, first copy the curated screenshots to `<community_modules_viewer_dir>/images/`, then rewrite the description image links to raw GitHub URLs for the published output.

Only skip editing `module.json.description` when the user explicitly asks for a draft only. In that case, provide the Markdown in the final response with local `./screenshots/...` links.

## Validation

Before finishing:

1. Confirm every referenced local PNG exists in `modules/<name>/screenshots/`.
2. Confirm `modules/<name>/module.json` has a Markdown `description` that references the curated screenshots in context. For local module descriptions, confirm Markdown uses `./screenshots/<filename>.png` links. For published viewer content, confirm every referenced PNG exists in `<community_modules_viewer_dir>/images/` and Markdown uses only the required raw GitHub image URL format.
3. Confirm the screenshot set has no duplicate install/config images. If `_install` duplicates `_config`, remove it from the Markdown and keep the config screenshots instead.
4. Open every PNG and visually reject screenshots that are blank, cropped mid-content, dominated by irrelevant rows, raw/cut-off JSON, stale data, or too noisy for user-facing documentation. Retake screenshots before cleanup if any fail this check.
   For `<module_slug>_config.png`, explicitly reject an installed-module card/list screenshot unless the dashboard truly has no config/update drawer. The accepted config screenshot must show the actual config/update/install UI and relevant labels, not just module name, description, and component counts.
5. Confirm the final `description` covers every command, hook, and cronjob from the component evidence matrix, either with direct documentation/evidence or an explicit reason it is not shown.
6. Curate the final Markdown links to the smallest useful set. It is acceptable to capture extra scroll screenshots for validation, but do not publish every capture when one summary/config/chat/events set documents the module better.
7. Run the module-writer build/conversion checks:
   ```bash
   npm run build
   npm run module:to-json -- modules/<name> /tmp/<module_slug>.json
   ```
8. If you edited community viewer data, code, or generated module JSON, run the relevant viewer checks such as `npm run typecheck`, `npm run test:unit`, or `npm run build` from `<community_modules_viewer_dir>`.
9. Report any screenshots that could not be captured and why.
