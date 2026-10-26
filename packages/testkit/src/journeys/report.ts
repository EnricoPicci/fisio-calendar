import type { JourneyResult } from './journey';

/**
 * The journey report renderer (docs/architecture.md §10.2, §10.5): every journey's numbered trace
 * in catalogue order (J1, J2, …, J8-a), as `docs/journeys.md`. The traces are deterministic (fixed
 * clock, redacted codes and passwords), so the file only changes when a flow does.
 */
export function renderJourneysReport(results: readonly JourneyResult[], intro: string): string {
  // Numeric collation: J1 < J2 < J8 < J8-a < J10.
  const sorted = [...results].sort(
    (a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }) || a.title.localeCompare(b.title),
  );
  const sections = sorted.map(
    (result) =>
      `## ${result.title}\n\n\`${result.file}\`\n\n\`\`\`text\n${result.lines.join('\n')}\n\`\`\`\n`,
  );
  return `# Journeys\n\n${intro.trim()}\n\n${sections.join('\n')}`;
}
