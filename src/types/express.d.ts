/**
 * Augment Express's Request type to include rawBody, which NestJS populates
 * when `rawBody: true` is passed to NestFactory.create(). This eliminates the
 * `(req as any).rawBody` cast in HmacGuard.
 */
declare namespace Express {
  interface Request {
    rawBody?: Buffer;
  }
}
