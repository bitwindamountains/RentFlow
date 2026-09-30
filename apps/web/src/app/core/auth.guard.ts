import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { ApiClient } from './api-client.service';
import type { Role } from './models';

/**
 * Requires a session and, when the route declares `data.roles`, one of those
 * roles. This only shapes navigation; the API enforces every permission.
 */
export const authGuard: CanActivateFn = (route) => {
  const api = inject(ApiClient);
  const router = inject(Router);
  const allowed = () => {
    const role = api.profile()?.role;
    const roles = route.data['roles'] as Role[] | undefined;
    if (!role) return router.createUrlTree(['/auth']);
    if (roles && !roles.includes(role))
      return router.createUrlTree([role === 'MAINTENANCE' ? '/maintenance' : '/dashboard']);
    return true;
  };
  if (api.profile()) return allowed();
  return api.me().pipe(
    map(allowed),
    catchError(() => of(router.createUrlTree(['/auth']))),
  );
};
