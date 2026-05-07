import { executeWordPressImport } from './importer';
import { ImportModeName } from './types';

const mode = process.argv[2] as ImportModeName | undefined;

if (mode !== 'preview' && mode !== 'run') {
  console.error('Usage: pnpm --filter @platforma/wp-import <preview|run>');
  process.exit(1);
}

void executeWordPressImport(mode)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
