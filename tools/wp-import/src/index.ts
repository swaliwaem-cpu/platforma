import { executeWordPressImport } from './importer';
import { executeRepair, RepairModeName } from './repair';
import { ImportModeName } from './types';

const command = process.argv[2];
const mode = process.argv[3];

if (command === 'preview' || command === 'run') {
  void executeWordPressImport(command as ImportModeName)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
} else if (command === 'repair' && (mode === 'preview' || mode === 'run')) {
  void executeRepair(mode as RepairModeName)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
} else {
  console.error('Usage: pnpm --filter @platforma/wp-import <preview|run|repair preview|repair run>');
  process.exit(1);
}
