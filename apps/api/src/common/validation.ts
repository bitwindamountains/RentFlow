import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import { isDateOnly } from './dates.js';
import { MONEY_PATTERN } from './money.js';

export const IsMoney = (options?: ValidationOptions) =>
  Matches(MONEY_PATTERN, {
    message: '$property must be an amount with at most two decimal places',
    ...options,
  });

export const IsDateOnly = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isDateOnly',
      validator: {
        validate: (value) => isDateOnly(value),
        defaultMessage: () => '$property must be a valid date (YYYY-MM-DD)',
      },
    },
    options,
  );

export class PageQuery {
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Opaque keyset cursor: base64url("<sortValue>|<id>"). */
export function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(`${sortValue}|${id}`).toString('base64url');
}

export function decodeCursor(cursor?: string): { sortValue: string; id: string } | undefined {
  if (!cursor) return undefined;
  const [sortValue, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!sortValue || !id || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return { sortValue, id };
}
