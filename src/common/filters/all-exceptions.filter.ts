import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { errorMessage, errorStack } from '@/common/utils/error.util';

/** getStatus() returns a plain number, so compare against a number. */
const SERVER_ERROR_THRESHOLD = 500;

interface ErrorBody {
  statusCode: number;
  message: string;
  path: string;
  timestamp: string;
}

/**
 * Converts any uncaught error into a consistent JSON body and makes sure it
 * reaches the log. Without this, a non-HttpException surfaces as an opaque 500
 * with no record of what actually failed.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const body: ErrorBody = {
      statusCode: status,
      message: this.describe(exception, status),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    if (status >= SERVER_ERROR_THRESHOLD) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        errorStack(exception),
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${status}`);
    }

    response.status(status).json(body);
  }

  /**
   * Nest puts validation errors in a nested `message` array; keep those, but
   * never leak an internal error's text to the client.
   */
  private describe(exception: unknown, status: number): string {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      if (typeof payload === 'string') return payload;
      if (payload && typeof payload === 'object' && 'message' in payload) {
        const { message } = payload;
        return Array.isArray(message)
          ? message.map(errorMessage).join(', ')
          : errorMessage(message);
      }
      return exception.message;
    }
    return status === SERVER_ERROR_THRESHOLD
      ? 'Internal server error'
      : 'Unexpected error';
  }
}
