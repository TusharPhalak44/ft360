import { randomUUID } from 'node:crypto';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ApiSuccessResponse } from '@ft360/shared-types';
import { isValidUuid } from './uuid.util';

export interface RequestWithCorrelation extends Request {
  correlationId?: string;
}

@Injectable()
export class CorrelationIdInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T>> {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithCorrelation>();
    const res = http.getResponse<Response>();

    const incomingHeader = req.headers['x-correlation-id'];
    const rawId = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;
    const correlationId = isValidUuid(rawId) ? rawId.toLowerCase() : randomUUID();

    req.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);

    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
        meta: {
          correlationId,
          timestamp: new Date().toISOString(),
        },
      })),
    );
  }
}

