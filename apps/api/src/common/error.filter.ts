import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from './errors.js';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: string[];
}

const httpCodes: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

/**
 * Every error leaves the API as `{ statusCode, code, message }`.
 * Unexpected errors are logged with stack frames only: exception messages
 * can contain SQL parameters, personal data, or credentials.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse();
    const request = http.getRequest();
    const body = this.toBody(error, request?.id);
    response.status(body.statusCode).send(body);
  }

  private toBody(error: unknown, requestId?: string): ErrorBody {
    if (error instanceof DomainError)
      return { statusCode: error.status, code: error.code, message: error.message };

    if (error instanceof HttpException) {
      const status = error.getStatus();
      const payload = error.getResponse() as
        | string
        | { message?: string | string[]; code?: string };
      const raw = typeof payload === 'string' ? payload : payload.message;
      const details = Array.isArray(raw) ? raw : undefined;
      return {
        statusCode: status,
        code:
          (typeof payload === 'object' && payload.code) ||
          (details ? 'VALIDATION_FAILED' : (httpCodes[status] ?? 'ERROR')),
        message: details ? details.join('. ') : ((raw as string | undefined) ?? 'Request failed.'),
        ...(details ? { details } : {}),
      };
    }

    const statusCode = (error as { statusCode?: number })?.statusCode;
    if (statusCode === 429)
      return { statusCode, code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' };
    if (statusCode === 413)
      return { statusCode, code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' };
    if (statusCode === 415)
      return { statusCode, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Upload a PDF, JPEG, PNG, or WebP file.' };
    if (statusCode === 400 && (error as { code?: string })?.code?.startsWith('FST_'))
      return { statusCode, code: 'BAD_REQUEST', message: 'The request body is not valid JSON.' };

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002')
        return { statusCode: 409, code: 'CONFLICT', message: 'This record already exists.' };
      if (error.code === 'P2025')
        return { statusCode: 404, code: 'NOT_FOUND', message: 'The requested record was not found.' };
      if (error.code === 'P2034')
        return {
          statusCode: 409,
          code: 'RETRY',
          message: 'Another change happened at the same time. Retry the same request.',
        };
    }
    if (String((error as Error)?.message ?? '').includes('CROSS_ORGANIZATION_REFERENCE'))
      return { statusCode: 404, code: 'RESOURCE_NOT_FOUND', message: 'The requested record was not found.' };

    this.logger.error({
      event: 'UNEXPECTED_REQUEST_ERROR',
      requestId,
      type: (error as Error)?.constructor?.name,
      frames: (error as Error)?.stack
        ?.split('\n')
        .filter((line) => /^\s+at /.test(line))
        .slice(0, 12),
    });
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL',
      message: `The request could not be completed. Reference: ${requestId ?? 'n/a'}`,
    };
  }
}
