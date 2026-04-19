import { data } from '@takaro/helpers';
import { requireManagePermission, generateReport, formatCurrency } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod, arguments: args } = data;
  requireManagePermission(pog);
  const days = Math.max(1, Math.min(365, Math.floor(Number(args.days ?? 7) || 7)));
  const report = await generateReport(gameServerId, mod.moduleId, days);
  const lines = [
    `📈 Casino report (${report.days} day${report.days === 1 ? '' : 's'})`,
    `Total wagered: ${formatCurrency(report.totalWagered)} | total won: ${formatCurrency(report.totalWon)} | house profit: ${formatCurrency(report.houseProfit)}`,
    'Top 5 by wagered:',
    ...(report.top5.length > 0 ? report.top5.map((row, index) => `#${index + 1} ${row.name} — wagered ${formatCurrency(row.wagered)}, won ${formatCurrency(row.won)}, net ${formatCurrency(row.net)}`) : ['No casino play recorded in this window.']),
    'Per-game breakdown:',
    ...Object.entries(report.perGame).map(([game, row]) => `${game}: wagered ${formatCurrency(row.wagered)}, won ${formatCurrency(row.won)}, plays ${row.plays}`),
  ];
  await pog.pm(lines.join('\n'));
}

await main();
