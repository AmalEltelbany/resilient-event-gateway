export default () => {
  if (!process.env.WEBHOOK_SECRET) {
    throw new Error('Missing required environment variable: WEBHOOK_SECRET');
  }

  return {
  port: parseInt(process.env.PORT ?? '3000', 10),
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
    eventQueueName: process.env.EVENT_QUEUE_NAME ?? 'events',
    defaultJobAttempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS ?? '3', 10),
    defaultBackoffDelay: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS ?? '3000', 10),
  },
  };
};
