import {
  pgTable,
  text,
  varchar,
  integer,
  boolean,
  numeric,
  timestamp,
  jsonb,
  uuid,
  index,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  clerkUserId: varchar('clerk_user_id', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 320 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('users_clerk_user_id_idx').on(table.clerkUserId),
]);

// ---------------------------------------------------------------------------
// user_risk_profiles
// ---------------------------------------------------------------------------
export const userRiskProfiles = pgTable('user_risk_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull().unique(),
  strategies: jsonb('strategies').$type<string[]>().default([]),
  maxTradesPerDay: integer('max_trades_per_day').default(5),
  riskPerTradePct: numeric('risk_per_trade_pct', { precision: 5, scale: 2 }).default('1.00'),
  maxDailyLossPct: numeric('max_daily_loss_pct', { precision: 5, scale: 2 }).default('3.00'),
  executionMode: varchar('execution_mode', { length: 20 }).default('paper'),
  preferredTimeframes: jsonb('preferred_timeframes').$type<string[]>().default([]),
  allowedSymbols: jsonb('allowed_symbols').$type<string[]>().default([]),
  killSwitchActive: boolean('kill_switch_active').default(false),
  tradingMode: varchar('trading_mode', { length: 20 }).default('manual'),
  webhookToken: varchar('webhook_token', { length: 128 }),
  isActive: boolean('is_active').default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('urp_user_id_idx').on(table.userId),
]);

// ---------------------------------------------------------------------------
// user_exchanges
// ---------------------------------------------------------------------------
export const userExchanges = pgTable('user_exchanges', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  exchangeName: varchar('exchange_name', { length: 50 }).notNull(),
  encryptedApiKey: text('encrypted_api_key').notNull(),
  encryptedApiSecret: text('encrypted_api_secret').notNull(),
  encryptedPassphrase: text('encrypted_passphrase'),
  status: varchar('status', { length: 20 }).default('active'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('ue_user_id_idx').on(table.userId),
]);

// ---------------------------------------------------------------------------
// user_notifications
// ---------------------------------------------------------------------------
export const userNotifications = pgTable('user_notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull().unique(),
  telegramBotToken: text('telegram_bot_token'),
  telegramChatId: varchar('telegram_chat_id', { length: 100 }),
  discordWebhookUrl: text('discord_webhook_url'),
  quietHoursStart: integer('quiet_hours_start'),
  quietHoursEnd: integer('quiet_hours_end'),
});

// ---------------------------------------------------------------------------
// trade_signals
// ---------------------------------------------------------------------------
export const tradeSignals = pgTable('trade_signals', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  symbol: varchar('symbol', { length: 30 }).notNull(),
  timeframe: varchar('timeframe', { length: 10 }).notNull(),
  direction: varchar('direction', { length: 10 }).notNull(), // LONG | SHORT
  entryPrice: numeric('entry_price', { precision: 20, scale: 8 }),
  stopLoss: numeric('stop_loss', { precision: 20, scale: 8 }),
  takeProfit: numeric('take_profit', { precision: 20, scale: 8 }),
  confidence: numeric('confidence', { precision: 5, scale: 2 }),
  reasoning: text('reasoning'),
  source: varchar('source', { length: 20 }).default('ai'), // ai | tradingview
  status: varchar('status', { length: 20 }).default('pending'), // pending | executed | cancelled | expired
  publisherId: uuid('publisher_id'),
  rawPayload: jsonb('raw_payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (table) => [
  index('ts_user_id_idx').on(table.userId),
  index('ts_status_idx').on(table.status),
]);

// ---------------------------------------------------------------------------
// trade_executions
// ---------------------------------------------------------------------------
export const tradeExecutions = pgTable('trade_executions', {
  id: uuid('id').defaultRandom().primaryKey(),
  signalId: uuid('signal_id').references(() => tradeSignals.id),
  userId: varchar('user_id', { length: 255 }).notNull(),
  exchangeName: varchar('exchange_name', { length: 50 }).notNull(),
  exchangeOrderId: varchar('exchange_order_id', { length: 128 }),
  entryPrice: numeric('entry_price', { precision: 20, scale: 8 }),
  exitPrice: numeric('exit_price', { precision: 20, scale: 8 }),
  positionSize: numeric('position_size', { precision: 20, scale: 8 }),
  realizedPnl: numeric('realized_pnl', { precision: 20, scale: 8 }),
  status: varchar('status', { length: 20 }).default('open'), // open | closed | cancelled
  mode: varchar('mode', { length: 10 }).default('paper'), // live | paper
  entryAt: timestamp('entry_at', { withTimezone: true }).defaultNow(),
  exitAt: timestamp('exit_at', { withTimezone: true }),
}, (table) => [
  index('te_user_id_idx').on(table.userId),
  index('te_signal_id_idx').on(table.signalId),
]);

// ---------------------------------------------------------------------------
// signal_publishers (copy trading — schema only, feature post-launch)
// ---------------------------------------------------------------------------
export const signalPublishers = pgTable('signal_publishers', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull().unique(),
  displayName: varchar('display_name', { length: 100 }),
  description: text('description'),
  feePercent: numeric('fee_percent', { precision: 5, scale: 2 }).default('0.00'),
  isPublic: boolean('is_public').default(false),
  subscriberCount: integer('subscriber_count').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// signal_subscriptions (copy trading — schema only, feature post-launch)
// ---------------------------------------------------------------------------
export const signalSubscriptions = pgTable('signal_subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  subscriberId: varchar('subscriber_id', { length: 255 }).notNull(),
  publisherId: uuid('publisher_id').notNull().references(() => signalPublishers.id),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('ss_subscriber_id_idx').on(table.subscriberId),
  index('ss_publisher_id_idx').on(table.publisherId),
]);

// ---------------------------------------------------------------------------
// ohlcv_cache
// ---------------------------------------------------------------------------
export const ohlcvCache = pgTable('ohlcv_cache', {
  id: uuid('id').defaultRandom().primaryKey(),
  symbol: varchar('symbol', { length: 30 }).notNull(),
  timeframe: varchar('timeframe', { length: 10 }).notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  open: numeric('open', { precision: 20, scale: 8 }).notNull(),
  high: numeric('high', { precision: 20, scale: 8 }).notNull(),
  low: numeric('low', { precision: 20, scale: 8 }).notNull(),
  close: numeric('close', { precision: 20, scale: 8 }).notNull(),
  volume: numeric('volume', { precision: 30, scale: 8 }).notNull(),
}, (table) => [
  index('oc_symbol_tf_ts_idx').on(table.symbol, table.timeframe, table.timestamp),
]);

// ---------------------------------------------------------------------------
// backtest_runs
// ---------------------------------------------------------------------------
export const backtestRuns = pgTable('backtest_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  config: jsonb('config').notNull(),
  metrics: jsonb('metrics'),
  equityCurve: jsonb('equity_curve'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('br_user_id_idx').on(table.userId),
]);

// ---------------------------------------------------------------------------
// publisher_earnings
// ---------------------------------------------------------------------------
export const publisherEarnings = pgTable('publisher_earnings', {
  id: uuid('id').defaultRandom().primaryKey(),
  publisherId: uuid('publisher_id').notNull().references(() => signalPublishers.id),
  subscriberId: varchar('subscriber_id', { length: 255 }).notNull(),
  tradeId: uuid('trade_id').references(() => tradeExecutions.id),
  profitAmount: numeric('profit_amount', { precision: 20, scale: 8 }).notNull(),
  feeAmount: numeric('fee_amount', { precision: 20, scale: 8 }).notNull(),
  period: varchar('period', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('pe_publisher_id_idx').on(table.publisherId),
]);
