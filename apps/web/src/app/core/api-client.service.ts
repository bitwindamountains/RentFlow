import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, Subject, catchError, tap, throwError } from 'rxjs';
import type { Profile } from './models';
import { todayIn } from './dates';

export type { Profile } from './models';

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

type Query = Record<string, string | number | boolean | null | undefined>;

/**
 * The only way the web app talks to the API. Adds credentials and the CSRF
 * header, normalizes errors to `{ status, code, message }`, and signals data
 * changes so open screens can refresh.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  readonly changes = new Subject<void>();
  readonly profile = signal<Profile | null>(null);
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  private readonly baseUrl =
    window.location.port === '4200'
      ? `${window.location.protocol}//${window.location.hostname}:3000/api/v1`
      : `${window.location.origin}/api/v1`;

  me(): Observable<Profile> {
    return this.http
      .get<Profile>(`${this.baseUrl}/auth/me`, { withCredentials: true })
      .pipe(tap((profile) => this.profile.set(profile)));
  }

  /** Sign-in style calls: the response is the new profile. */
  session(path: string, body: unknown): Observable<Profile> {
    return this.http
      .post<Profile>(`${this.baseUrl}${path}`, body, { withCredentials: true, headers: this.headers() })
      .pipe(
        tap((profile) => this.profile.set(profile)),
        catchError((error) => throwError(() => toApiError(error))),
      );
  }

  /** Public calls that must not redirect to sign-in on 401 (invitation, reset). */
  publicPost<T>(path: string, body: unknown): Observable<T> {
    return this.http
      .post<T>(`${this.baseUrl}${path}`, body, { withCredentials: true })
      .pipe(catchError((error) => throwError(() => toApiError(error))));
  }

  logout(): Observable<void> {
    return this.http
      .post<void>(`${this.baseUrl}/auth/logout`, {}, { withCredentials: true, headers: this.headers() })
      .pipe(tap(() => this.profile.set(null)));
  }

  get<T>(path: string, query?: Query): Observable<T> {
    return this.http
      .get<T>(`${this.baseUrl}${path}`, { withCredentials: true, params: params(query) })
      .pipe(catchError((error) => this.fail(error)));
  }

  post<T>(path: string, body: unknown, idempotencyKey?: string): Observable<T> {
    return this.http
      .post<T>(`${this.baseUrl}${path}`, body, {
        withCredentials: true,
        headers: this.headers(idempotencyKey),
      })
      .pipe(
        tap(() => this.changes.next()),
        catchError((error) => this.fail(error)),
      );
  }

  patch<T>(path: string, body: unknown): Observable<T> {
    return this.http
      .patch<T>(`${this.baseUrl}${path}`, body, { withCredentials: true, headers: this.headers() })
      .pipe(
        tap(() => this.changes.next()),
        catchError((error) => this.fail(error)),
      );
  }

  delete<T>(path: string): Observable<T> {
    return this.http
      .delete<T>(`${this.baseUrl}${path}`, { withCredentials: true, headers: this.headers() })
      .pipe(
        tap(() => this.changes.next()),
        catchError((error) => this.fail(error)),
      );
  }

  /** Sends a file as the raw request body; the browser sets Content-Type from the file. */
  upload<T>(path: string, file: Blob, query?: Query): Observable<T> {
    return this.http
      .post<T>(`${this.baseUrl}${path}`, file, {
        withCredentials: true,
        headers: this.headers().set('content-type', file.type),
        params: params(query),
      })
      .pipe(
        tap(() => this.changes.next()),
        catchError((error) => this.fail(error)),
      );
  }

  downloadUrl(path: string, query?: Query): string {
    const search = params(query).toString();
    return `${this.baseUrl}${path}${search ? `?${search}` : ''}`;
  }

  today(): string {
    return todayIn(this.profile()?.organization.timezone);
  }

  hasRole(...roles: string[]): boolean {
    return roles.includes(this.profile()?.role ?? '');
  }

  private fail(error: unknown): Observable<never> {
    const normalized = toApiError(error);
    if (normalized.status === 0) this.online.set(false);
    if (normalized.status === 401 && this.profile()) {
      this.profile.set(null);
      void this.router.navigate(['/auth'], { queryParams: { expired: 1 } });
    }
    return throwError(() => normalized);
  }

  private headers(idempotencyKey?: string): HttpHeaders {
    let headers = new HttpHeaders();
    const token = this.profile()?.csrfToken;
    if (token) headers = headers.set('x-csrf-token', token);
    if (idempotencyKey) headers = headers.set('idempotency-key', idempotencyKey);
    return headers;
  }
}

function params(query?: Query): HttpParams {
  let result = new HttpParams();
  for (const [key, value] of Object.entries(query ?? {}))
    if (value !== undefined && value !== null && value !== '') result = result.set(key, String(value));
  return result;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof HttpErrorResponse) {
    const body = (error.error ?? {}) as Partial<ApiError>;
    if (error.status === 0)
      return { status: 0, code: 'OFFLINE', message: 'Cannot reach RentFlow. Check your connection and try again.' };
    return {
      status: error.status,
      code: body.code ?? 'ERROR',
      message: typeof body.message === 'string' ? body.message : 'The request could not be completed.',
    };
  }
  if (error && typeof error === 'object' && 'code' in error) return error as ApiError;
  return { status: 0, code: 'ERROR', message: 'Something went wrong. Please try again.' };
}

/** Whether a failed write may already have succeeded (retry with the same key). */
export function isUncertain(error: ApiError): boolean {
  return error.status === 0 || error.status >= 500 || error.status === 408 || error.code === 'RETRY';
}
