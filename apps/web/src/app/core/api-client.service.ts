import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, tap, catchError, throwError, Subject } from 'rxjs';

export interface Profile {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string; slug: string; currency: string; timezone: string };
  role: string;
  csrfToken: string;
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly router = inject(Router);
  readonly changes = new Subject<void>();
  private readonly baseUrl =
    window.location.port === '4200'
      ? `${window.location.protocol}//${window.location.hostname}:3000/api/v1`
      : `${window.location.origin}/api/v1`;
  readonly profile = signal<Profile | null>(null);

  constructor(private readonly http: HttpClient) {}

  me(): Observable<Profile> {
    return this.http
      .get<Profile>(`${this.baseUrl}/auth/me`, { withCredentials: true })
      .pipe(tap((profile) => this.profile.set(profile)));
  }

  register(input: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
  }): Observable<Profile> {
    return this.http
      .post<Profile>(`${this.baseUrl}/auth/register`, input, { withCredentials: true })
      .pipe(tap((profile) => this.profile.set(profile)));
  }

  login(input: { email: string; password: string; workspace?: string }): Observable<Profile> {
    return this.http
      .post<Profile>(`${this.baseUrl}/auth/login`, input, { withCredentials: true })
      .pipe(tap((profile) => this.profile.set(profile)));
  }

  acceptInvitation(input: {
    token: string;
    name?: string;
    password: string;
  }): Observable<{ accepted: boolean; email: string; workspace: string }> {
    // A wrong invitation password must not redirect away and lose the token.
    return this.http.post<{ accepted: boolean; email: string; workspace: string }>(
      `${this.baseUrl}/staff/invitations/accept`,
      input,
    );
  }

  logout(): Observable<void> {
    return this.http
      .post<void>(
        `${this.baseUrl}/auth/logout`,
        {},
        { withCredentials: true, headers: this.mutationHeaders() },
      )
      .pipe(tap(() => this.profile.set(null)));
  }

  get<T>(path: string): Observable<T> {
    return this.http
      .get<T>(`${this.baseUrl}${path}`, { withCredentials: true })
      .pipe(catchError((error) => this.handleError(error)));
  }
  post<T>(path: string, body: unknown, idempotencyKey?: string): Observable<T> {
    let headers = this.mutationHeaders();
    if (idempotencyKey) headers = headers.set('idempotency-key', idempotencyKey);
    return this.http
      .post<T>(`${this.baseUrl}${path}`, body, { withCredentials: true, headers })
      .pipe(
        tap(() => this.changes.next()),
        catchError((error) => this.handleError(error)),
      );
  }
  patch<T>(path: string, body: unknown): Observable<T> {
    return this.http
      .patch<T>(`${this.baseUrl}${path}`, body, {
        withCredentials: true,
        headers: this.mutationHeaders(),
      })
      .pipe(
        tap(() => this.changes.next()),
        catchError((error) => this.handleError(error)),
      );
  }

  downloadUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private handleError(error: any): Observable<never> {
    if (error.status === 401) {
      this.profile.set(null);
      void this.router.navigate(['/auth']);
    }
    return throwError(() => error);
  }

  private mutationHeaders(): HttpHeaders {
    const token = this.profile()?.csrfToken;
    return token ? new HttpHeaders({ 'x-csrf-token': token }) : new HttpHeaders();
  }
}
