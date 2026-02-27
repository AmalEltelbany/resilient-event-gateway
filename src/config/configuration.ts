export default () => {
  if (!process.env.WEBHOOK_SECRET) {
    throw new Error('Missing required environment variable: WEBHOOK_SECRET');
  }
  if (!process.env.API_KEY) {
    throw new Error('Missing required environment variable: API_KEY');
  }

  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    apiKey: process.env.API_KEY,
    webhook: {
      secret: process.env.WEBHOOK_SECRET,
    },
    mongo: {
      uri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/resilient-event-gateway',
    },
    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      password: process.env.REDIS_PASSWORD ?? undefined,
    },
    queue: {
      // eventQueueName is intentionally not configurable: events.constants.ts hardcodes
      // 'events' and 'events-dlq' as the queue names, which are used by both producers and
      // consumers. Making them configurable would require threading the value through every
      // @InjectQueue() and @Processor() decorator, adding complexity with no practical benefit.
      defaultJobAttempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS ?? '3', 10),
      defaultBackoffDelay: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS ?? '3000', 10),
    },
    routing: {
      failureRate: parseFloat(process.env.ROUTING_FAILURE_RATE ?? '0.2'),
    },
    throttle: {
      // Sliding window: THROTTLE_LIMIT requests per THROTTLE_TTL_MS milliseconds.
      // Default: 200 requests per minute per IP — generous for legitimate producers,
      // tight enough to absorb a mis-configured client hammering the ingestion endpoint.
      ttlMs: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
      limit: parseInt(process.env.THROTTLE_LIMIT ?? '200', 10),
    },
    outbox: {
      // How often the reconciliation job scans for orphaned PENDING events (ms).
      intervalMs: parseInt(process.env.OUTBOX_INTERVAL_MS ?? '300000', 10), // 5 min
      // Events stuck in PENDING for longer than this threshold are considered orphaned.
      staleThresholdMs: parseInt(process.env.OUTBOX_STALE_THRESHOLD_MS ?? '300000', 10), // 5 min
    },
  };
};
