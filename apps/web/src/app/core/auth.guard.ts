import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { ApiClient } from './api-client.service';

export const authGuard: CanActivateFn = (route) => {
  const api = inject(ApiClient);
  const router = inject(Router);
  const allowed = () => {
    const role = api.profile()?.role;
    const path = route.routeConfig?.path;
    if (role === 'MAINTENANCE' && path !== 'maintenance')
      return router.createUrlTree(['/maintenance']);
    if (
      (path === 'staff' && role !== 'OWNER') ||
      (path === 'setup' && !['OWNER', 'MANAGER'].includes(role ?? ''))
    )
      return router.createUrlTree(['/dashboard']);
    return true;
  };
  if (api.profile()) return allowed();
  return api.me().pipe(
    map(allowed),
    catchError(() => of(router.createUrlTree(['/auth']))),
  );
};
