import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  NotFoundException,
  HttpException,
  Logger,
} from '@nestjs/common';

const conflictCodes = new Set([
  'EMAIL_EXISTS',
  'UNIT_EXISTS',
  'UNIT_OCCUPIED',
  'CHARGE_EXISTS',
  'EMAIL_EXISTS',
]);
const notFoundCodes = new Set([
  'PROPERTY_NOT_FOUND',
  'RESOURCE_NOT_FOUND',
  'LEASE_NOT_FOUND',
  'PAYMENT_NOT_FOUND',
  'MAINTENANCE_NOT_FOUND',
  'DOCUMENT_NOT_FOUND',
]);

@Catch(Error)
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);
  catch(error: Error, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    if (error instanceof HttpException) {
      response.status(error.getStatus()).send(error.getResponse());
      return;
    }
    if (!/^[A-Z_]+$/.test(error.message)) {
      // Exception messages can contain SQL parameters, URLs, or credentials.
      // Log only stack locations and the server-generated request identifier.
      const request = host.switchToHttp().getRequest();
      this.logger.error({
        event: 'UNEXPECTED_REQUEST_ERROR',
        requestId: request.id,
        frames: error.stack?.split('\n').filter((line) => /^\s+at /.test(line)),
      });
      response.status(500).send({
        statusCode: 500,
        message: 'The request could not be completed.',
      });
      return;
    }
    const exception = conflictCodes.has(error.message)
      ? new ConflictException(error.message)
      : notFoundCodes.has(error.message)
        ? new NotFoundException(error.message)
        : new BadRequestException(
            error.message === 'FUTURE_TERMINATION_NOT_ALLOWED'
              ? 'Lease termination takes effect immediately. Choose today or an earlier date.'
              : error.message,
          );
    response.status(exception.getStatus()).send(exception.getResponse());
  }
}
