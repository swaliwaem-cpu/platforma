import { XMLParser } from 'fast-xml-parser';

type FeedImportCommand = 'preview' | 'run';

export function isXmlParserAvailable() {
  return typeof XMLParser === 'function';
}

export function parseFeedImportCommand(value: string | undefined): FeedImportCommand | null {
  if (value === 'preview' || value === 'run') {
    return value;
  }

  return null;
}

function printUsage() {
  console.error('Usage: pnpm --filter @platforma/feed-import run <preview|run> --source <feedSourceId>');
}

function main() {
  const command = parseFeedImportCommand(process.argv[2]);

  if (!command) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!isXmlParserAvailable()) {
    console.error('XML parser dependency is unavailable');
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        command,
        status: 'scaffolded',
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main();
}
