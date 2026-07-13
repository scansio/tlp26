import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import {
  Observability,
  DefaultExporter,
  CloudExporter,
  SensitiveDataFilter,
} from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { weatherAgent } from './agents/weather-agent';
import { tradingAgent } from './agents/trading-agent';
import { setupAgent } from './agents/setup-agent';
import { marketDataTool } from './tools/market-data-tool';
import { indicatorsTool } from './tools/indicators-tool';
import { smcTool } from './tools/smc-tool';
import { patternTool } from './tools/pattern-tool';
import { orderbookTool } from './tools/orderbook-tool';
import { newsTool } from './tools/news-tool';
import { onchainTool } from './tools/onchain-tool';
import { mastraStorage } from './storage';

export const mastra = new Mastra({
  workflows: { weatherWorkflow },
  agents: { weatherAgent, tradingAgent, setupAgent },
  tools: {
    marketDataTool,
    indicatorsTool,
    smcTool,
    patternTool,
    orderbookTool,
    newsTool,
    onchainTool,
  },
  storage: mastraStorage,
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
          new CloudExporter(), // Sends traces to Mastra Cloud (if MASTRA_CLOUD_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
