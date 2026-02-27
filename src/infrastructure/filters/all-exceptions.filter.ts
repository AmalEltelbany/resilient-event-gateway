import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';

@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private readonly isProduction: boolean;

  constructor(private readonly config: ConfigService) {
    this.isProduction = process.env.NODE_ENV === 'production';
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // Production: return only a safe string to avoid leaking internals.
    let message: string | object;
    if (exception instanceof HttpException) {
      const raw = exception.getResponse();
      message = this.isProduction
        ? (typeof raw === 'string' ? raw : exception.message)
        : raw;
    } else {
      message = 'Internal server error';
    }

    this.logger.error(
      `${request.method} ${request.url} → ${status}`,
      exception instanceof Error ? exception.stack : '',
    );

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
