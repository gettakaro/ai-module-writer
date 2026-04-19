import { data } from '@takaro/helpers';
import { requireManagePermission, generateReport, formatCurrency } from './casino-helpers.js';

async function main() {
  const { pog, gameServerId, module: mod, arguments: args } = data;
  requireManagePermission(pog);
  const days = Number(args.days ?? 7) || 7;
  const report = await generateReport(gameServerId, mod.moduleId);
  const lines = [
    `📈 Casino report (lifetime aggregate; requested ${days}d view)`,
    `Total wagered: ${formatCurrency(report.totalWagered)} | total won: ${formatCurrency(report.totalWon)} | house profit: ${formatCurrency(report.houseProfit)}`,
    'Top 5 by wagered:',
    ...report.top5.map((row, index) => `#${index + 1} ${row.name} — wagered ${formatCurrency(row.wagered)}, won ${formatCurrency(row.won)}, net ${formatCurrency(row.net)}`),
    'Per-game breakdown:',
    ...Object.entries(report.perGame).map(([game, row]) => `${game}: wagered ${formatCurrency(row.wagered)}, won ${formatCurrency(row.won)}, plays ${row.plays}`),
  ];
  await pog.pm(lines.join('\n'));
}

await main();
