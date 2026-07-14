import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import {
  Observability,
  DefaultExporter,
  CloudExporter,
  SensitiveDataFilter,
} from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { tradeAnalysisWorkflow } from './workflows/trade-analysis-workflow';
import { weatherAgent } from './agents/weather-agent';
import { tradingAgent } from './agents/trading-agent';
import { setupAgent } from './agents/setup-agent';
import { marketChatAgent } from './agents/market-chat-agent';
import { chartTool } from './tools/chart-tool';
import { createSignalTool } from './tools/create-signal-tool';
import { marketDataTool } from './tools/market-data-tool';
import { indicatorsTool } from './tools/indicators-tool';
import { smcTool } from './tools/smc-tool';
import { patternTool } from './tools/pattern-tool';
import { orderbookTool } from './tools/orderbook-tool';
import { newsTool } from './tools/news-tool';
import { onchainTool } from './tools/onchain-tool';
import { riskTool } from './tools/risk-tool';
import { executeTradeTool } from './tools/execute-trade-tool';
import { mastraStorage } from './storage';

export const mastra = new Mastra({
  workflows: { weatherWorkflow, tradeAnalysisWorkflow },
  agents: { weatherAgent, tradingAgent, setupAgent, marketChatAgent },
  tools: {
    marketDataTool,
    indicatorsTool,
    smcTool,
    patternTool,
    orderbookTool,
    newsTool,
    onchainTool,
    riskTool,
    executeTradeTool,
    chartTool,
    createSignalTool,
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
          new DefaultExporter(),
          ...(process.env.MASTRA_CLOUD_ACCESS_TOKEN ? [new CloudExporter()] : []),
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
        ],
      },
    },
  }),
});
