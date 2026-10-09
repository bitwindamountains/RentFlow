import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { ApiClient } from './api-client.service';
import { homeFor, type Role } from './models';

/**
 * Requires a session and, when the route declares `data.roles`, one of those
 * roles. This only shapes navigation; the API enforces every permission.
 */
export const authGuard: CanActivateFn = (route) => {
  const api = inject(ApiClient);
  const router = inject(Router);
  const allowed = () => {
    const profile = api.profile();
    const role = profile?.role;
    const roles = route.data['roles'] as Role[] | undefined;
    if (!role) return router.createUrlTree(['/auth']);
    // The API refuses everything else until a required two-step sign-in is on.
    if (profile.mfaSetupRequired && route.routeConfig?.path !== 'account') return router.createUrlTree(['/account']);
    if (roles && !roles.includes(role))
      return router.createUrlTree([homeFor(role)]);
    return true;
  };
  if (api.profile()) return allowed();
  return api.me().pipe(
    map(allowed),
    catchError(() => of(router.createUrlTree(['/auth']))),
  );
};
