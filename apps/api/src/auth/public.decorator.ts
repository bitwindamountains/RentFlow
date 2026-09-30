import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'rentflow:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
