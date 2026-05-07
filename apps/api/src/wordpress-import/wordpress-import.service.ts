import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ImportMode, ImportStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const execFileAsync = promisify(execFile);

type ListReportsQuery = {
  page?: string;
  limit?: string;
  mode?: string;
  status?: string;
};

const reportInclude = {
  createdBy: {
    select: {
      id: true,
      email: true,
      name: true,
    },
  },
} as const;

type ImportReportRecord = Prisma.ImportReportGetPayload<{ include: typeof reportInclude }>;

@Injectable()
export class WordpressImportService {
  private activeCommand: 'preview' | 'run' | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async runImportCommand(mode: 'preview' | 'run') {
    if (this.activeCommand) {
      throw new ConflictException('WordPress import command is already running');
    }

    const startedAt = new Date();
    this.activeCommand = mode;

    try {
      await execFileAsync('pnpm', ['--filter', '@platforma/wp-import', 'run', mode], {
        cwd: findWorkspaceRoot(),
        env: process.env,
        maxBuffer: 1024 * 1024 * 50,
        timeout: 1000 * 60 * 30,
      });

      const report = await this.findLatestReport(mode, startedAt);

      return {
        report: this.serializeReport(report),
      };
    } catch (error) {
      const report = await this.findLatestReport(mode, startedAt).catch(() => null);

      if (report) {
        return {
          report: this.serializeReport(report),
        };
      }

      throw new InternalServerErrorException(getCommandErrorMessage(error));
    } finally {
      this.activeCommand = null;
    }
  }

  async listReports(query: ListReportsQuery) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);
    const where: Prisma.ImportReportWhereInput = {
      source: 'wordpress',
    };

    if (query.mode) {
      where.mode = this.parseMode(query.mode);
    }

    if (query.status) {
      where.status = this.parseStatus(query.status);
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.importReport.findMany({
        where,
        include: reportInclude,
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.importReport.count({ where }),
    ]);

    return {
      items: items.map((report) => this.serializeReport(report)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getReport(id: string) {
    const reportId = this.parseUuid(id, 'Import report is invalid');
    const report = await this.prisma.importReport.findUnique({
      where: {
        id: reportId,
      },
      include: reportInclude,
    });

    if (!report || report.source !== 'wordpress') {
      throw new NotFoundException('Import report not found');
    }

    return {
      report: this.serializeReport(report),
    };
  }

  private serializeReport(report: ImportReportRecord) {
    return {
      id: report.id,
      mode: report.mode,
      status: report.status,
      source: report.source,
      startedAt: report.startedAt.toISOString(),
      finishedAt: report.finishedAt?.toISOString() ?? null,
      summaryJson: report.summaryJson ?? null,
      warningsJson: report.warningsJson ?? null,
      errorsJson: report.errorsJson ?? null,
      createdBy: report.createdBy,
      createdAt: report.createdAt.toISOString(),
    };
  }

  private async findLatestReport(mode: 'preview' | 'run', startedAt: Date) {
    const report = await this.prisma.importReport.findFirst({
      where: {
        source: 'wordpress',
        mode: mode === 'preview' ? ImportMode.PREVIEW : ImportMode.RUN,
        createdAt: {
          gte: startedAt,
        },
      },
      include: reportInclude,
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!report) {
      throw new NotFoundException('Import report not found');
    }

    return report;
  }

  private parseMode(value: string) {
    const normalizedMode = value.trim().toUpperCase();

    if (!Object.values(ImportMode).includes(normalizedMode as ImportMode)) {
      throw new BadRequestException('Import mode is invalid');
    }

    return normalizedMode as ImportMode;
  }

  private parseStatus(value: string) {
    const normalizedStatus = value.trim().toUpperCase();

    if (!Object.values(ImportStatus).includes(normalizedStatus as ImportStatus)) {
      throw new BadRequestException('Import status is invalid');
    }

    return normalizedStatus as ImportStatus;
  }

  private parsePositiveInteger(value: string | undefined, fallback: number) {
    if (!value) {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return fallback;
    }

    return parsed;
  }

  private parseUuid(value: string, message: string) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }
}

function findWorkspaceRoot() {
  let currentDir = process.cwd();

  while (currentDir !== dirname(currentDir)) {
    if (existsSync(resolve(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }

    currentDir = dirname(currentDir);
  }

  return process.cwd();
}

function getCommandErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    return error.stderr.trim() || 'WordPress import command failed';
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'WordPress import command failed';
}
