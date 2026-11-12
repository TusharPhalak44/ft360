import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiErrorResponse, ApiFieldError } from '@ft360/shared-types';
import type { RequestWithCorrelation } from './correlation-id.interceptor';

interface PgLikeError {
  code?: string;
  message?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<RequestWithCorrelation>();
    const res = ctx.getResponse<Response>();

    const correlationId = req.correlationId ?? randomUUID();
    res.setHeader('X-Correlation-Id', correlationId);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected server error occurred.';
    let details: ApiFieldError[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responseBody = exception.getResponse();
      if (typeof responseBody === 'string') {
        message = responseBody;
        code = this.statusToDefaultCode(status);
      } else if (typeof responseBody === 'object' && responseBody !== null) {
        const bodyObj = responseBody as Record<string, unknown>;
        code = typeof bodyObj.code === 'string' ? bodyObj.code : this.statusToDefaultCode(status);
        if (Array.isArray(bodyObj.message)) {
          message = 'Request validation failed.';
          details = bodyObj.message.map((issue) => ({ issue: String(issue) }));
        } else if (typeof bodyObj.message === 'string') {
          message = bodyObj.message;
        }
      }
    } else if (this.isPgError(exception)) {
      // Never leak table names, constraint names, or SQL fragments to clients
      if (exception.code === '42501') {
        status = HttpStatus.FORBIDDEN;
        code = 'TENANT_ISOLATION_DENIED';
        message = 'Operation denied by database security policy.';
      } else if (exception.code === '23505') {
        status = HttpStatus.CONFLICT;
        code = 'RESOURCE_CONFLICT';
        message = 'A conflicting record already exists.';
      } else if (exception.code === '23503') {
        status = HttpStatus.BAD_REQUEST;
        code = 'INVALID_REFERENCE';
        message = 'Referenced entity does not exist in active scope.';
      } else {
        this.logger.error(`[${correlationId}] Database error (${exception.code}): ${exception.message}`);
      }
    } else if (exception instanceof Error) {
      this.logger.error(`[${correlationId}] Unhandled error: ${exception.message}`, exception.stack);
    }

    const payload: ApiErrorResponse = {
      success: false,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      meta: {
        correlationId,
        timestamp: new Date().toISOString(),
      },
    };

    res.status(status).json(payload);
  }

  private isPgError(err: unknown): err is PgLikeError {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      typeof (err as PgLikeError).code === 'string' &&
      /^[0-9A-Z]{5}$/.test((err as PgLikeError).code!)
    );
  }

  private statusToDefaultCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'RESOURCE_NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      default:
        return 'HTTP_ERROR';
    }
  }
}

