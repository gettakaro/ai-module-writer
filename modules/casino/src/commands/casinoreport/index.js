import { data, TakaroUserError } from '@takaro/helpers';
import { requireManagePermission, generateReport, formatCurrency, sendPlayerMessage } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod, arguments: args } = data;
  requireManagePermission(pog);

  const rawDays = args.days;
  let days = 7;
  if (rawDays !== undefined && rawDays !== null && String(rawDays).trim() !== '') {
    const parsed = Number(rawDays);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      throw new TakaroUserError('Days must be a whole number between 1 and 365.');
    }
    days = parsed;
  }

  const report = await generateReport(gameServerId, mod.moduleId, days);
  const perGameLines = Object.entries(report.perGame).map(([game, row]) => `${game}: wagered ${formatCurrency(row.wagered)}, won ${formatCurrency(row.won)}, plays ${row.plays}`);
  const lines = [
    `Casino report (${report.days} day${report.days === 1 ? '' : 's'})`,
    `Total wagered: ${formatCurrency(report.totalWagered)} | total won: ${formatCurrency(report.totalWon)} | house profit: ${formatCurrency(report.houseProfit)}`,
    'Top 5 by wagered:',
    ...(report.top5.length > 0 ? report.top5.map((row, index) => `#${index + 1} ${row.name} — wagered ${formatCurrency(row.wagered)}, won ${formatCurrency(row.won)}, net ${formatCurrency(row.net)}`) : ['No casino play recorded in this window.']),
    'Per-game breakdown:',
    ...(perGameLines.length > 0 ? perGameLines : ['No per-game activity recorded in this window.']),
  ];
  await sendPlayerMessage(pog, lines.join('\n'));
}

await main();
