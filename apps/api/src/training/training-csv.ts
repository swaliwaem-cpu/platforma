import type { TrainingRankingResponse } from '@platforma/shared' with { 'resolution-mode': 'import' };

export const TRAINING_RANKING_CSV_BOM = '\uFEFF';

export function buildTrainingRankingCsv(
  ranking: TrainingRankingResponse,
): string {
  const projectColumns = ranking.projects.flatMap((project) => [
    `${project.title} — лучший балл`,
    `${project.title} — статус`,
  ]);
  const rows: unknown[][] = [
    [
      'position',
      'userId',
      'name',
      'email',
      'passedProjectsCount',
      'completedProjectsCount',
      'averageBestScore',
      'attemptsUsed',
      'lastCompletedAt',
      'totalDurationSeconds',
      'averageDurationSeconds',
      'narrative',
      'errorsCount',
      'unsupportedClaimsCount',
      ...projectColumns,
    ],
    ...ranking.items.map((item) => {
      const projectsById = new Map(
        item.projects.map((project) => [project.projectId, project]),
      );
      return [
        item.position,
        item.user.id,
        item.user.name ?? '',
        item.user.email,
        item.passedProjectsCount,
        item.completedProjectsCount,
        item.averageBestScore ?? '',
        item.attemptsUsed,
        item.lastCompletedAt ?? '',
        item.totalDurationSeconds,
        item.averageDurationSeconds ?? '',
        item.narrative,
        item.projects.reduce(
          (sum, project) => sum + project.errors.length,
          0,
        ),
        item.projects.reduce(
          (sum, project) => sum + project.unsupportedClaims.length,
          0,
        ),
        ...ranking.projects.flatMap((project) => {
          const result = projectsById.get(project.id);
          return result
            ? [result.finalScore, result.passStatus]
            : ['', ''];
        }),
      ];
    }),
  ];

  return (
    TRAINING_RANKING_CSV_BOM +
    rows
      .map((row) => row.map(escapeTrainingCsvCell).join(','))
      .join('\r\n') +
    '\r\n'
  );
}

export function escapeTrainingCsvCell(value: unknown): string {
  const source =
    value === null || value === undefined ? '' : String(value);
  const dangerousStart = source.replace(/^[^\S\r\n\t]+/u, '');
  const mustNeutralize =
    /^[=+\-@\t\r\n]/u.test(dangerousStart);
  const safe = mustNeutralize ? `'${source}` : source;
  return /[",\r\n]/u.test(safe)
    ? `"${safe.replaceAll('"', '""')}"`
    : safe;
}
