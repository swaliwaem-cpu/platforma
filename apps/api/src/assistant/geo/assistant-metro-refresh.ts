import { readFile } from 'node:fs/promises';

import { MapRoutingService } from '../../map/map-routing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AssistantMetroTravelTimeService } from './assistant-metro-travel-time.service';

async function main() {
  const file = readFlag('--file');
  const version = readFlag('--version');
  if (!file || !version) {
    throw new Error('Usage: assistant:metro:refresh -- --file <geojson> --version <version>');
  }
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const raw = await readFile(file, 'utf8');
    const document = JSON.parse(raw) as unknown;
    const service = new AssistantMetroTravelTimeService(prisma, new MapRoutingService(prisma));
    const imported = await service.importAccessPoints(document, version);
    const coverage = await service.refreshPublishedObjects();
    process.stdout.write(`${JSON.stringify({ status: 'COMPLETED', imported, coverage })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

function readFlag(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^ASSISTANT_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : 'ASSISTANT_METRO_REFRESH_FAILED';
  process.stderr.write(`${JSON.stringify({ status: 'FAILED', code })}\n`);
  process.exitCode = 1;
});
