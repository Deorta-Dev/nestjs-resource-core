import { Injectable } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { SessionStore, SessionData } from '../../common/interfaces';

@Injectable()
export class MemorySessionStore implements SessionStore {
  private store = new Map<string, SessionData>();

  create(session: SessionData): Observable<void> {
    this.store.set(session.token, session);
    return of(undefined);
  }

  get(token: string): Observable<SessionData | null> {
    const session = this.store.get(token);
    if (!session) return of(null);
    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
      this.store.delete(token);
      return of(null);
    }
    return of(session);
  }

  update(token: string, data: Partial<SessionData>): Observable<void> {
    const session = this.store.get(token);
    if (session) {
      this.store.set(token, { ...session, ...data });
    }
    return of(undefined);
  }

  delete(token: string): Observable<void> {
    this.store.delete(token);
    return of(undefined);
  }

  deleteByUser(userId: string): Observable<void> {
    for (const [token, session] of this.store.entries()) {
      if (session.userId === userId) {
        this.store.delete(token);
      }
    }
    return of(undefined);
  }

  touch(token: string, ttl: number = 3600): Observable<void> {
    const session = this.store.get(token);
    if (session) {
      session.expiresAt = new Date(Date.now() + ttl * 1000);
      this.store.set(token, session);
    }
    return of(undefined);
  }

  clearExpired(): Observable<number> {
    let count = 0;
    const now = Date.now();
    for (const [token, session] of this.store.entries()) {
      if (session.expiresAt && session.expiresAt.getTime() < now) {
        this.store.delete(token);
        count++;
      }
    }
    return of(count);
  }
}
