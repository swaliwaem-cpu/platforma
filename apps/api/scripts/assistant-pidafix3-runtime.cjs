const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { lstat } = require('node:fs/promises');

const activeProcessGroups = new Set();
let requestedSignal = null;

async function runCommand(command, args, options = {}) {
  if (requestedSignal && !options.allowDuringShutdown) {
    const error = new Error(`PIDAFIX3_INTERRUPTED_BY_${requestedSignal}`);
    error.signal = requestedSignal;
    throw error;
  }
  const detached = process.platform !== 'win32';
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  });
  if (detached && child.pid) activeProcessGroups.add(child.pid);
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => {
    stdout.push(chunk);
    options.onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk);
    options.onStderr?.(chunk);
  });

  let timedOut = false;
  let killTimer = null;
  let killPromise = null;
  let terminationError = null;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try {
      terminateChildTree(child, 'SIGTERM');
    } catch (error) {
      terminationError = error;
    }
    killPromise = new Promise((resolveKill) => {
      killTimer = setTimeout(() => {
        try {
          terminateChildTree(child, 'SIGKILL');
        } catch (error) {
          terminationError ??= error;
        } finally {
          resolveKill();
        }
      }, options.killGraceMs ?? 5_000);
    });
  }, options.timeoutMs ?? 60_000);

  let status;
  try {
    status = await new Promise((resolveStatus, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolveStatus(code ?? 1));
    });
  } finally {
    clearTimeout(timeoutTimer);
    if (timedOut && killPromise) await killPromise;
    else if (killTimer) clearTimeout(killTimer);
    if (child.pid) activeProcessGroups.delete(child.pid);
  }
  if (terminationError) throw terminationError;
  if (timedOut) stderr.push(Buffer.from(`\n${command} timed out\n`));
  return {
    status: timedOut ? 124 : status,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

function terminateChildTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function terminateActiveProcessGroups(signal) {
  for (const pid of activeProcessGroups) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

function installTerminationHandlers(options = {}) {
  let signalCount = 0;
  const handlers = new Map();
  const abortController = new AbortController();
  const signalTarget = options.signalTarget ?? process;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      signalCount += 1;
      requestedSignal ??= signal;
      if (!abortController.signal.aborted) {
        abortController.abort(createInterruptionError(requestedSignal));
      }
      terminateActiveProcessGroups(signalCount === 1 ? 'SIGTERM' : 'SIGKILL');
      if (signalCount === 1) options.onSignal?.(signal);
    };
    handlers.set(signal, handler);
    signalTarget.on(signal, handler);
  }
  return {
    get signal() { return requestedSignal; },
    get abortSignal() { return abortController.signal; },
    get exitCode() { return requestedSignal ? 128 + signalNumber(requestedSignal) : null; },
    throwIfRequested() {
      if (requestedSignal) throw createInterruptionError(requestedSignal);
    },
    dispose() {
      for (const [signal, handler] of handlers) signalTarget.off(signal, handler);
      requestedSignal = null;
    },
  };
}

function createInterruptionError(signal) {
  const error = new Error(`PIDAFIX3_INTERRUPTED_BY_${signal}`);
  error.signal = signal;
  return error;
}

function signalNumber(signal) {
  return { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 1;
}

async function runBoundedOperation(id, operation, options = {}) {
  assert.match(id, /^[A-Z][A-Z0-9_]*$/u);
  assert.equal(typeof operation, 'function');
  const timeoutMs = options.timeoutMs ?? 15_000;
  assert.equal(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, true);

  const operationController = new AbortController();
  const parentSignal = options.abortSignal;
  const abortFromParent = () => {
    operationController.abort(parentSignal.reason instanceof Error
      ? parentSignal.reason
      : new Error('PIDAFIX3_INTERRUPTED'));
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    operationController.abort(new Error(`PIDAFIX3_${id}_TIMEOUT`));
  }, timeoutMs);
  timeout.unref?.();
  let rejectAborted;
  const aborted = new Promise((resolveUnused, reject) => { rejectAborted = reject; });
  const rejectForAbort = () => rejectAborted(operationController.signal.reason instanceof Error
    ? operationController.signal.reason
    : new Error(`PIDAFIX3_${id}_ABORTED`));
  operationController.signal.addEventListener('abort', rejectForAbort, { once: true });
  if (operationController.signal.aborted) rejectForAbort();

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        operationController.signal.throwIfAborted();
        return operation(operationController.signal);
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
    operationController.signal.removeEventListener('abort', rejectForAbort);
  }
}

function createT07OwnershipFilters(resourceSuffix) {
  assert.match(resourceSuffix, /^[a-f0-9]{8}$/u);
  const label = `com.platforma.assistant-t07.run=${resourceSuffix}`;
  const filter = `label=${label}`;
  return {
    label,
    filter,
    containers: ['ps', '--all', '--quiet', '--filter', filter],
    networks: ['network', 'ls', '--quiet', '--filter', filter],
  };
}

function isExpectedT07ApiNavigationAbort(failure, apiOrigin) {
  return failure?.method === 'GET'
    && failure?.errorText === 'net::ERR_ABORTED'
    && (
      failure.url === `${apiOrigin}/assistant/config`
      || failure.url === `${apiOrigin}/assistant/conversations`
    );
}

function isExpectedT07MetroTileAbort(failure, webOrigin) {
  return failure?.method === 'GET'
    && failure?.errorText === 'net::ERR_ABORTED'
    && failure.url === `${webOrigin}/__map_fixture__/metro.pbf`;
}

async function removeT07OwnedDockerResources(kind, ownership, runDocker, options = {}) {
  assert.ok(['container', 'network'].includes(kind));
  assert.equal(typeof runDocker, 'function');
  assert.deepEqual(
    ownership,
    createT07OwnershipFilters(ownership?.label?.split('=').at(-1) ?? ''),
  );
  const listArgs = kind === 'container' ? ownership.containers : ownership.networks;
  const removePrefix = kind === 'container' ? ['rm', '--force'] : ['network', 'rm'];
  const now = options.now ?? Date.now;
  const wait = options.delay ?? ((milliseconds) => new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  }));
  const deadlineMs = options.deadlineMs ?? 5_000;
  const settleMs = options.settleMs ?? 500;
  const pollMs = options.pollMs ?? 50;
  for (const value of [deadlineMs, settleMs, pollMs]) {
    assert.equal(Number.isSafeInteger(value) && value >= 0, true);
  }

  const deadline = now() + deadlineMs;
  let emptySince = null;
  while (now() < deadline) {
    const listed = await runDocker(listArgs);
    const ids = splitOutputLines(listed.stdout);
    if (ids.length > 0) {
      emptySince = null;
      await runDocker([...removePrefix, ...ids]);
    } else {
      emptySince ??= now();
      if (now() - emptySince >= settleMs) return;
    }
    await wait(pollMs);
  }
  const residual = splitOutputLines((await runDocker(listArgs)).stdout);
  assert.deepEqual(
    residual,
    [],
    `ASSISTANT_T07_${kind.toUpperCase()}_CLEANUP_INCOMPLETE`,
  );
}

function splitOutputLines(value) {
  return String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

async function validateLocalDockerDaemon(environment, options = {}) {
  const runner = options.runCommand ?? runCommand;
  const contextEnvironment = { ...environment };
  const contextName = contextEnvironment.DOCKER_HOST
    ? 'DOCKER_HOST'
    : contextEnvironment.DOCKER_CONTEXT
      || (await requireSuccessful(runner('docker', ['context', 'show'], {
        env: contextEnvironment,
        timeoutMs: 15_000,
      }), 'PIDAFIX3_DOCKER_CONTEXT_SHOW_FAILED')).stdout.trim();
  const endpoint = contextEnvironment.DOCKER_HOST || JSON.parse((await requireSuccessful(
    runner('docker', [
      'context', 'inspect', contextName, '--format', '{{json .Endpoints.docker.Host}}',
    ], { env: contextEnvironment, timeoutMs: 15_000 }),
    'PIDAFIX3_DOCKER_CONTEXT_INSPECT_FAILED',
  )).stdout.trim());
  await assertLocalDockerEndpoint(endpoint, options.lstat ?? lstat);

  const pinnedEnvironment = { ...contextEnvironment, DOCKER_HOST: endpoint };
  delete pinnedEnvironment.DOCKER_CONTEXT;
  delete pinnedEnvironment.DOCKER_CERT_PATH;
  delete pinnedEnvironment.DOCKER_TLS_VERIFY;
  const info = (await requireSuccessful(runner('docker', [
    'info', '--format', '{{json .Name}}|{{json .ServerVersion}}',
  ], { env: pinnedEnvironment, timeoutMs: 15_000 }), 'PIDAFIX3_DOCKER_INFO_FAILED')).stdout.trim();
  const [engineName, serverVersion] = info.split('|').map((value) => JSON.parse(value));
  assert.equal(typeof engineName, 'string');
  assert.equal(typeof serverVersion, 'string');
  return {
    environment: pinnedEnvironment,
    facts: {
      contextName,
      endpointScheme: endpoint.slice(0, endpoint.indexOf(':')),
      engineName,
      serverVersion,
    },
  };
}

async function assertLocalDockerEndpoint(value, stat = lstat) {
  if (typeof value !== 'string') throw new Error('PIDAFIX3_DOCKER_ENDPOINT_INVALID');
  if (process.platform === 'win32') {
    if (!value.startsWith('npipe:')) throw new Error('PIDAFIX3_DOCKER_ENDPOINT_NOT_LOCAL');
    return;
  }
  if (!value.startsWith('unix://')) throw new Error('PIDAFIX3_DOCKER_ENDPOINT_NOT_LOCAL');
  const socketPath = decodeURIComponent(value.slice('unix://'.length));
  if (!socketPath.startsWith('/')) throw new Error('PIDAFIX3_DOCKER_SOCKET_NOT_ABSOLUTE');
  let socketStat;
  try {
    socketStat = await stat(socketPath);
  } catch {
    throw new Error('PIDAFIX3_DOCKER_SOCKET_NOT_FOUND');
  }
  if (!socketStat.isSocket()) throw new Error('PIDAFIX3_DOCKER_ENDPOINT_NOT_SOCKET');
}

async function requireSuccessful(resultPromise, code) {
  const result = await resultPromise;
  if (result.status !== 0) throw new Error(code);
  return result;
}

function createUnverifiedProviderEvidence() {
  return {
    status: 'not-measured',
    scope: 't07-connected-e2e',
    calls: { openai: null, locationiq: null, overpass: null },
    persistedUsageAttempts: { openai: null, locationiq: null, overpass: null },
    deniedRemoteRequests: null,
  };
}

function verifyT07ProviderEvidence(value, nonce) {
  assert.match(nonce, /^[a-f0-9]{16}$/u);
  assert.equal(value?.version, 1);
  assert.equal(value?.nonce, nonce);
  assert.deepEqual(value?.transportStubCalls, { openai: 0, locationiq: 0, overpass: 0 });
  assert.deepEqual(value?.persistedUsageAttempts, { openai: 0, locationiq: 0, overpass: 0 });
  assert.equal(value?.deniedRemoteRequests, 0);
  return {
    status: 'verified',
    scope: 't07-connected-e2e',
    calls: { ...value.transportStubCalls },
    persistedUsageAttempts: { ...value.persistedUsageAttempts },
    deniedRemoteRequests: 0,
  };
}

module.exports = {
  assertLocalDockerEndpoint,
  createT07OwnershipFilters,
  createUnverifiedProviderEvidence,
  installTerminationHandlers,
  isExpectedT07ApiNavigationAbort,
  isExpectedT07MetroTileAbort,
  removeT07OwnedDockerResources,
  runBoundedOperation,
  runCommand,
  terminateChildTree,
  validateLocalDockerDaemon,
  verifyT07ProviderEvidence,
};
