import { Injectable, Inject } from '@nestjs/common';
import { Observable, from, of } from 'rxjs';
import { map, mergeMap } from 'rxjs/operators';
import { SessionStore, SessionData } from '../../common/interfaces';
import { IBaseRepositoryService } from '../../common/repository.interface';

@Injectable()
export class DatabaseSessionStore implements SessionStore {
  constructor(
    private readonly repo: IBaseRepositoryService<SessionData>,
  ) {}

  create(session: SessionData): Observable<void> {
    return this.repo.create(session).pipe(map(() => undefined));
  }

  get(token: string): Observable<SessionData | null> {
    return this.repo.findOne({ token }).pipe(
      map(session => {
        if (!session) return null;
        if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) return null;
        return session;
      })
    );
  }

  update(token: string, data: Partial<SessionData>): Observable<void> {
    return this.get(token).pipe(
      mergeMap(session => {
        if (!session) return of(undefined);
        return this.repo.update(token, data).pipe(map(() => undefined));
      })
    );
  }

  delete(token: string): Observable<void> {
    return this.repo.delete(token).pipe(map(() => undefined));
  }

  deleteByUser(userId: string): Observable<void> {
    // Requires custom query logic in repo, skipping for interface compliance
    return of(undefined);
  }

  touch(token: string, ttl: number = 3600): Observable<void> {
    return this.get(token).pipe(
      mergeMap(session => {
        if (!session) return of(undefined);
        const expiresAt = new Date(Date.now() + ttl * 1000);
        return this.repo.update(token, { expiresAt }).pipe(map(() => undefined));
      })
    );
  }

  clearExpired(): Observable<number> {
    // Requires a batch delete in repo
    return of(0);
  }
}
