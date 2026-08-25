import { Injectable } from '@nestjs/common';

import {
  OfficialHtmlSourceConnector,
  SourceConnectorError,
  type SourceConnectorFetchResult,
  type SourceConnectorRegistryEntry,
} from './official-html-source.connector';

export type AssistantSourceConnector = {
  fetch(source: SourceConnectorRegistryEntry): Promise<SourceConnectorFetchResult>;
};

const connectorDefinitions = [
  { key: 'OFFICIAL_HTML', enabled: true },
  { key: 'CIAN', enabled: false },
  { key: 'DOMCLICK', enabled: false },
  { key: 'YANDEX_REALTY', enabled: false },
  { key: 'NOVOSTROY_M', enabled: false },
] as const;

@Injectable()
export class AssistantSourceConnectorRegistry {
  constructor(private readonly officialHtml = createOfficialHtmlConnector()) {}

  list() {
    return connectorDefinitions.map((definition) => ({ ...definition }));
  }

  get(key: string): AssistantSourceConnector {
    const definition = connectorDefinitions.find((candidate) => candidate.key === key);
    if (!definition) throw new SourceConnectorError('SOURCE_CONNECTOR_UNSUPPORTED', false);
    if (!definition.enabled) throw new SourceConnectorError('SOURCE_CONNECTOR_DISABLED', false);
    return this.officialHtml;
  }
}

function createOfficialHtmlConnector(environment: NodeJS.ProcessEnv = process.env) {
  const allowPrivateTestUrls = environment.NODE_ENV === 'test'
    && environment.ASSISTANT_SOURCE_ALLOW_PRIVATE_TEST_URLS === 'true';
  return new OfficialHtmlSourceConnector({
    allowHttp: allowPrivateTestUrls,
    allowPrivateNetwork: allowPrivateTestUrls,
    timeoutMs: readInteger(environment.ASSISTANT_SOURCE_FETCH_TIMEOUT_MS, 10_000, 100, 120_000),
    maxResponseBytes: readInteger(
      environment.ASSISTANT_SOURCE_MAX_RESPONSE_BYTES,
      5 * 1024 * 1024,
      1_024,
      25 * 1024 * 1024,
    ),
    maxRedirects: readInteger(environment.ASSISTANT_SOURCE_MAX_REDIRECTS, 3, 0, 10),
  });
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SourceConnectorError('SOURCE_CONNECTOR_CONFIG_INVALID', false);
  }
  return parsed;
}
