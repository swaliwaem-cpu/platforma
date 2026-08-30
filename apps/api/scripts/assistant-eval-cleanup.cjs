#!/usr/bin/env node

'use strict';

const { readFileSync } = require('node:fs');
const { open, unlink } = require('node:fs/promises');
const { isIP } = require('node:net');
const { posix, resolve } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const {
  loadAssistantEvalDataset,
} = require('../dist/assistant/eval/assistant-eval.js');
const {
  computeAssistantEvalEvidenceCoreSha256,
  computeAssistantEvalFinalizedEvidenceSha256,
  finalizeAssistantEvalEvidenceBundle,
  loadAssistantEvalDatabaseIdentity,
  loadAssistantEvalDatabaseFingerprint,
  readAssistantEvalDraftEvidenceBundle,
} = require('./assistant-eval-runtime.cjs');
const {
  isDisposableDatabaseUrl,
} = require('./assistant-eval-runner.cjs');
const {
  runCommand,
  validateLocalDockerDaemon,
} = require('./assistant-pidafix3-runtime.cjs');

const composeProjectPattern = /^platforma-assistant-eval-[a-f0-9]{8}$/u;
const resourceIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,239}$/u;
const resourceKeys = ['databases', 'containers', 'networks', 'volumes', 'images'];
const commandTimeoutMs = 60_000;

async function runAssistantEvalCleanup(input = {}) {
  const now = input.now ?? (() => new Date());
  const startedAt = readClock(now);
  const draft = input.draft;
  const composeProject = readComposeProject(input.composeProject);
  const validateDraft = input.validateDraft ?? ((value, current) => {
    const dataset = input.dataset ?? loadFrozenDataset();
    readAssistantEvalDraftEvidenceBundle(value, dataset, current);
  });
  const boundary = input.boundary;
  if (!boundary) throw new Error('ASSISTANT_EVAL_CLEANUP_BOUNDARY_REQUIRED');

  let databaseClosed = false;
  try {
    validateDraft(draft, startedAt);
    const expectedFingerprint = readDigest(
      draft?.runner?.databaseFingerprint,
      'ASSISTANT_EVAL_EVIDENCE_DRAFT_INVALID',
    );
    const databaseIdentity = readDatabaseIdentity(await boundary.getDatabaseIdentity());
    const databaseFingerprint = databaseIdentity.fingerprint;
    if (databaseFingerprint !== expectedFingerprint) {
      throw new Error('ASSISTANT_EVAL_CLEANUP_DATABASE_MISMATCH');
    }
    const inventory = await boundary.inventoryOwnedResources({
      composeProject,
      databaseIdentity,
    });
    if (!inventory || inventory.databaseEndpointBound !== true) {
      throw new Error('ASSISTANT_EVAL_CLEANUP_PROJECT_DATABASE_MISMATCH');
    }
    const ownedResources = readResourceMap(
      inventory.resources,
      'ASSISTANT_EVAL_CLEANUP_INVENTORY_INVALID',
    );
    assertOwnedResourceInventory(ownedResources, databaseFingerprint);
    const ordinaryResources = await boundary.snapshotOrdinaryResources(ownedResources);
    if (!Array.isArray(ordinaryResources)
      || ordinaryResources.some((identifier) => !resourceIdentifierPattern.test(identifier))) {
      throw new Error('ASSISTANT_EVAL_CLEANUP_ORDINARY_INVENTORY_INVALID');
    }

    await boundary.closeDatabase();
    databaseClosed = true;
    await boundary.removeOwnedResources(ownedResources);
    const residualResources = readResourceMap(
      await boundary.inspectResidualResources(ownedResources),
      'ASSISTANT_EVAL_CLEANUP_RESIDUAL_INVALID',
    );
    const missingOrdinaryResources = await boundary.findMissingOrdinaryResources(
      ordinaryResources,
    );
    if (resourceKeys.some((key) => residualResources[key].length !== 0)
      || !Array.isArray(missingOrdinaryResources)
      || missingOrdinaryResources.length !== 0) {
      throw new Error('ASSISTANT_EVAL_CLEANUP_INCOMPLETE');
    }

    const completedAt = readClock(now);
    return finalizeAssistantEvalEvidenceBundle(draft, {
      schemaVersion: 1,
      completedAt: completedAt.toISOString(),
      evidenceCoreSha256: computeAssistantEvalEvidenceCoreSha256(draft),
      databaseFingerprint,
      ordinaryLocalResourcesPreserved: true,
      ownedResources,
      removedResources: ownedResources,
      residualResources: [],
    }, completedAt);
  } finally {
    if (!databaseClosed) await boundary.closeDatabase();
  }
}

function parseAssistantEvalCleanupArguments(argv) {
  if (argv.length === 0) return { execute: false };
  const valueArguments = new Set([
    '--evidence-draft',
    '--evidence',
    '--compose-project',
  ]);
  for (let index = 0; index < argv.length;) {
    const argument = argv[index];
    if (argument === '--execute') {
      index += 1;
      continue;
    }
    if (!valueArguments.has(argument) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('ASSISTANT_EVAL_CLEANUP_ARGUMENT_INVALID');
    }
    index += 2;
  }
  if (argv.filter((value) => value === '--execute').length !== 1) {
    throw new Error('ASSISTANT_EVAL_CLEANUP_ARGUMENT_INVALID');
  }
  const evidenceDraftValue = readSingleArgument(argv, '--evidence-draft');
  const evidenceValue = readSingleArgument(argv, '--evidence');
  const composeProject = readSingleArgument(argv, '--compose-project');
  if (!evidenceDraftValue || !evidenceValue || !composeProject) {
    throw new Error('ASSISTANT_EVAL_CLEANUP_ARGUMENT_INVALID');
  }
  const evidenceDraftPath = resolve(evidenceDraftValue);
  const evidencePath = resolve(evidenceValue);
  if (evidenceDraftPath === evidencePath) throw new Error('ASSISTANT_EVAL_OUTPUT_PATHS_COLLIDE');
  return {
    execute: true,
    evidenceDraftPath,
    evidencePath,
    composeProject: readComposeProject(composeProject),
  };
}

async function createAssistantEvalCleanupBoundary(environment, options) {
  if (!isDisposableDatabaseUrl(environment.DATABASE_URL)) {
    throw new Error('ASSISTANT_EVAL_DISPOSABLE_RUNTIME_REQUIRED');
  }
  const docker = await validateLocalDockerDaemon(environment);
  const dockerEnvironment = docker.environment;
  const prisma = new PrismaClient({
    datasources: { db: { url: environment.DATABASE_URL } },
  });
  let databaseClosed = false;
  const runDocker = async (args, allowFailure = false) => {
    const result = await runCommand('docker', args, {
      env: dockerEnvironment,
      timeoutMs: commandTimeoutMs,
    });
    if (!allowFailure && result.status !== 0) {
      throw new Error('ASSISTANT_EVAL_CLEANUP_DOCKER_COMMAND_FAILED');
    }
    return result;
  };
  const list = async (args) => splitLines((await runDocker(args)).stdout);
  const filters = createResourceFilters(options.composeProject);
  const databaseEndpoint = readDatabaseEndpoint(environment.DATABASE_URL);
  return {
    async getDatabaseIdentity() {
      return loadAssistantEvalDatabaseIdentity(prisma);
    },
    async inventoryOwnedResources({ databaseIdentity }) {
      const [containers, networks, volumes] = await Promise.all([
        list(filters.containers),
        list(filters.networks),
        list(filters.volumes),
      ]);
      const inspectedContainers = [];
      for (const containerId of containers) {
        const inspected = JSON.parse((await runDocker([
          'inspect', '--format', '{{json .}}', containerId,
        ])).stdout);
        if (inspected?.Id !== containerId
          || inspected?.Config?.Labels?.['com.docker.compose.project'] !== options.composeProject) {
          throw new Error('ASSISTANT_EVAL_CLEANUP_INVENTORY_INVALID');
        }
        inspectedContainers.push(inspected);
      }
      const databaseContainers = inspectedContainers.filter((container) => (
        containerMatchesDatabaseIdentity(
          container,
          databaseIdentity,
          databaseEndpoint,
          volumes,
        )
      ));
      const databaseEndpointBound = databaseContainers.length === 1;

      const imageIds = new Set(await list([
        'image', 'ls', '--quiet', '--no-trunc', '--filter',
        `label=com.docker.compose.project=${options.composeProject}`,
      ]));
      for (const container of inspectedContainers) {
        if (container.Config.Image?.startsWith(`${options.composeProject}-`)) {
          imageIds.add(container.Image);
        }
      }
      for (const imageId of imageIds) {
        const image = JSON.parse((await runDocker([
          'image', 'inspect', '--format', '{{json .}}', imageId,
        ])).stdout);
        const tags = Array.isArray(image?.RepoTags) ? image.RepoTags : [];
        if (image?.Id !== imageId
          || tags.some((tag) => !tag.startsWith(`${options.composeProject}-`))) {
          throw new Error('ASSISTANT_EVAL_CLEANUP_IMAGE_SHARED');
        }
      }
      const allContainers = await list(['ps', '--all', '--quiet', '--no-trunc']);
      const foreignContainers = allContainers.filter((id) => !containers.includes(id));
      if (foreignContainers.length > 0) {
        const inspected = await runDocker([
          'inspect', '--format', '{{.Id}}|{{.Image}}', ...foreignContainers,
        ]);
        if (splitLines(inspected.stdout).some((line) => imageIds.has(line.split('|')[1]))) {
          throw new Error('ASSISTANT_EVAL_CLEANUP_IMAGE_SHARED');
        }
      }
      return {
        databaseEndpointBound,
        resources: {
          databases: [databaseIdentity.fingerprint],
          containers,
          networks,
          volumes,
          images: [...imageIds],
        },
      };
    },
    async snapshotOrdinaryResources(ownedResources) {
      const running = await list(['ps', '--quiet', '--no-trunc']);
      return running.filter((identifier) => !ownedResources.containers.includes(identifier));
    },
    async closeDatabase() {
      if (databaseClosed) return;
      databaseClosed = true;
      await prisma.$disconnect();
    },
    async removeOwnedResources(resources) {
      if (resources.containers.length > 0) {
        await runDocker(['rm', '--force', ...resources.containers]);
      }
      if (resources.networks.length > 0) {
        await runDocker(['network', 'rm', ...resources.networks]);
      }
      if (resources.volumes.length > 0) {
        await runDocker(['volume', 'rm', '--force', ...resources.volumes]);
      }
      if (resources.images.length > 0) {
        await runDocker(['image', 'rm', '--force', ...resources.images]);
      }
    },
    async inspectResidualResources(resources) {
      const [containers, networks, volumes] = await Promise.all([
        list(filters.containers),
        list(filters.networks),
        list(filters.volumes),
      ]);
      const images = [];
      for (const imageRef of resources.images) {
        const inspected = await runDocker(['image', 'inspect', imageRef], true);
        if (inspected.status === 0) images.push(imageRef);
      }
      const databases = await isDatabaseFingerprintPresent(
        environment.DATABASE_URL,
        resources.databases[0],
      ) ? [...resources.databases] : [];
      return { databases, containers, networks, volumes, images };
    },
    async findMissingOrdinaryResources(before) {
      const running = new Set(await list(['ps', '--quiet', '--no-trunc']));
      return before.filter((identifier) => !running.has(identifier));
    },
  };
}

async function isDatabaseFingerprintPresent(databaseUrl, expectedFingerprint) {
  const separator = databaseUrl.includes('?') ? '&' : '?';
  const probe = new PrismaClient({
    datasources: { db: { url: `${databaseUrl}${separator}connect_timeout=2` } },
  });
  try {
    return await loadAssistantEvalDatabaseFingerprint(probe) === expectedFingerprint;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => {});
  }
}

function createResourceFilters(composeProject) {
  const label = `label=com.docker.compose.project=${readComposeProject(composeProject)}`;
  return {
    containers: ['ps', '--all', '--quiet', '--no-trunc', '--filter', label],
    networks: ['network', 'ls', '--quiet', '--filter', label],
    volumes: ['volume', 'ls', '--quiet', '--filter', label],
  };
}

function assertOwnedResourceInventory(resources, databaseFingerprint) {
  if (resources.databases.length !== 1
    || resources.databases[0] !== databaseFingerprint
    || resources.containers.length === 0
    || resources.networks.length === 0
    || resources.volumes.length === 0
    || resources.images.length === 0) {
    throw new Error('ASSISTANT_EVAL_CLEANUP_INVENTORY_INVALID');
  }
}

function readDatabaseEndpoint(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('ASSISTANT_EVAL_DISPOSABLE_RUNTIME_REQUIRED');
  }
  const port = Number(parsed.port || 5432);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('ASSISTANT_EVAL_DISPOSABLE_RUNTIME_REQUIRED');
  }
  return { hostname: parsed.hostname, port };
}

function containerMatchesDatabaseIdentity(container, identity, endpoint, ownedVolumes) {
  if (container?.State?.Running !== true) return false;
  if (container?.Config?.Labels?.['com.docker.compose.service'] !== 'postgres') return false;
  const portKey = `${identity?.serverPort}/tcp`;
  if (!Object.hasOwn(container?.Config?.ExposedPorts ?? {}, portKey)) return false;
  const networkAddresses = Object.values(container?.NetworkSettings?.Networks ?? {}).flatMap(
    (network) => [network?.IPAddress, network?.GlobalIPv6Address],
  ).filter(Boolean);
  if (!networkAddresses.includes(identity?.serverAddress)) return false;
  if (!containerEndpointBindingMatches(container, endpoint, portKey)) return false;
  return containerHasOwnedPostgresDataVolume(container, ownedVolumes);
}

function containerEndpointBindingMatches(container, endpoint, portKey) {
  if (endpoint?.hostname === 'postgres') return true;
  const bindings = container?.NetworkSettings?.Ports?.[portKey];
  return Array.isArray(bindings) && bindings.some((binding) => (
    Number(binding?.HostPort) === endpoint?.port
      && hostBindingMatchesEndpoint(binding?.HostIp, endpoint.hostname)
  ));
}

function hostBindingMatchesEndpoint(hostIp, hostname) {
  const normalizedHostname = hostname === '[::1]' ? '::1' : hostname;
  if (normalizedHostname === 'localhost') {
    return hostIp === '127.0.0.1' || hostIp === '::1';
  }
  return hostIp === normalizedHostname;
}

function containerHasOwnedPostgresDataVolume(container, ownedVolumes) {
  if (!Array.isArray(ownedVolumes) || ownedVolumes.length === 0) return false;
  const pgData = readContainerPath(
    container?.Config?.Env?.find((entry) => entry.startsWith('PGDATA='))?.slice(7)
      || '/var/lib/postgresql/data',
  );
  if (!pgData) return false;
  return container?.Mounts?.some((mount) => {
    const destination = readContainerPath(mount?.Destination);
    return mount?.Type === 'volume'
      && ownedVolumes.includes(mount?.Name)
      && destination !== null
      && (pgData === destination || pgData.startsWith(`${destination}/`));
  }) === true;
}

function readContainerPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const normalized = posix.normalize(value).replace(/\/$/u, '');
  return normalized && normalized !== '/' ? normalized : null;
}

function readDatabaseIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isIP(value.serverAddress)
    || !Number.isSafeInteger(value.serverPort)
    || value.serverPort < 1
    || value.serverPort > 65_535) {
    throw new Error('ASSISTANT_EVAL_CLEANUP_DATABASE_IDENTITY_INVALID');
  }
  return {
    fingerprint: readDigest(value.fingerprint, 'ASSISTANT_EVAL_CLEANUP_DATABASE_IDENTITY_INVALID'),
    serverAddress: value.serverAddress,
    serverPort: value.serverPort,
  };
}

function readResourceMap(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== resourceKeys.length
    || resourceKeys.some((key) => !(key in value))) {
    throw new Error(code);
  }
  return Object.fromEntries(resourceKeys.map((key) => {
    const identifiers = value[key];
    if (!Array.isArray(identifiers)
      || identifiers.some((identifier) => (
        typeof identifier !== 'string' || !resourceIdentifierPattern.test(identifier)
      ))
      || new Set(identifiers).size !== identifiers.length) {
      throw new Error(code);
    }
    return [key, [...identifiers].sort()];
  }));
}

function readComposeProject(value) {
  if (typeof value !== 'string' || !composeProjectPattern.test(value)) {
    throw new Error('ASSISTANT_EVAL_CLEANUP_PROJECT_INVALID');
  }
  return value;
}

function readSingleArgument(argv, name) {
  const values = readRepeatedArguments(argv, name);
  if (values.length > 1) throw new Error('ASSISTANT_EVAL_CLEANUP_ARGUMENT_DUPLICATED');
  return values[0] ?? null;
}

function readRepeatedArguments(argv, name) {
  return argv.flatMap((value, index) => value === name ? [argv[index + 1]] : []);
}

function readClock(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('ASSISTANT_EVAL_CLEANUP_CLOCK_INVALID');
  return date;
}

function readDigest(value, code) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
  return value;
}

function splitLines(value) {
  return String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function loadFrozenDataset() {
  return loadAssistantEvalDataset(JSON.parse(readFileSync(resolve(
    __dirname,
    '../tests/fixtures/assistant/assistant-eval-v1.json',
  ), 'utf8')));
}

async function reserveOutput(path) {
  const handle = await open(path, 'wx', 0o600);
  let closed = false;
  return {
    async write(value) {
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
        closed = true;
      }
    },
    async discard() {
      if (!closed) await handle.close();
      try {
        await unlink(path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}

async function main() {
  const options = parseAssistantEvalCleanupArguments(process.argv.slice(2));
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({
      mode: 'DRY_RUN',
      passed: true,
      destructiveCalls: 0,
      hint: 'Use --execute with exact evidence paths and the owned Compose project.',
    }, null, 2)}\n`);
    return;
  }
  const output = await reserveOutput(options.evidencePath);
  try {
    const draft = JSON.parse(readFileSync(options.evidenceDraftPath, 'utf8'));
    const boundary = await createAssistantEvalCleanupBoundary(process.env, options);
    const evidence = await runAssistantEvalCleanup({
      boundary,
      composeProject: options.composeProject,
      draft,
    });
    await output.write(evidence);
    process.stdout.write(`${JSON.stringify({
      passed: true,
      evidenceFinalized: true,
      evidenceCoreSha256: evidence.cleanup.evidenceCoreSha256,
      finalizedEvidenceSha256: computeAssistantEvalFinalizedEvidenceSha256(evidence),
      cleanupCompletedAt: evidence.cleanup.external.completedAt,
    }, null, 2)}\n`);
  } catch (error) {
    await output.discard();
    throw error;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error && /^ASSISTANT_[A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : 'ASSISTANT_EVAL_CLEANUP_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  containerMatchesDatabaseIdentity,
  createResourceFilters,
  parseAssistantEvalCleanupArguments,
  runAssistantEvalCleanup,
};
