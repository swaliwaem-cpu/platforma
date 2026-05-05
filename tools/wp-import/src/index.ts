type ImportMode = 'preview' | 'run';

const mode = process.argv[2] as ImportMode | undefined;

if (mode !== 'preview' && mode !== 'run') {
  console.error('Usage: pnpm --filter @platforma/wp-import <preview|run>');
  process.exit(1);
}

console.log(`WordPress import ${mode} command is reserved for stage 9.`);
