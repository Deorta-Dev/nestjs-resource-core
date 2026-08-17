import { Injectable, Inject, BadRequestException, NotFoundException, Optional } from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';
import { map, switchMap, tap } from 'rxjs/operators';
import { ResourceConfig, AuthResourceApiContext } from '../common/interfaces';
import { IBaseRepositoryService, FilterQuery } from '../common/repository.interface';
import { parseQueryMatchDirectory } from '../common/utils/query-parser';

export const RESOURCE_CONFIG = 'RESOURCE_CONFIG';
export const REPOSITORY_SERVICE = 'REPOSITORY_SERVICE';
export const GATEWAY_SERVICE = 'GATEWAY_SERVICE';

export interface ActionContext {
  auth: AuthResourceApiContext;
  query?: any;
  [key: string]: any;
}

@Injectable()
export class CommonApiService<T = any> {
  constructor(
    @Inject(RESOURCE_CONFIG) protected readonly config: ResourceConfig<T>,
    @Inject(REPOSITORY_SERVICE) protected readonly repository: IBaseRepositoryService<T>,
    @Optional() @Inject(GATEWAY_SERVICE) protected readonly gateway?: any, // CommonGateway
  ) {}

  protected buildQuery(ctx: ActionContext): FilterQuery<T> {
    let authMatch = {};
    if (this.config.query?.scope) {
      authMatch = this.config.query.scope(ctx.auth, ctx);
    }

    const extraMatch = this.config.query?.extraMatch || {};
    
    let clientFilter = {};
    if (ctx.query && this.config.filters?.queryMatchDirectory) {
      clientFilter = parseQueryMatchDirectory(ctx.query, this.config.filters.queryMatchDirectory);
    }

    return { $and: [authMatch, extraMatch, clientFilter] };
  }

  list(ctx: ActionContext): Observable<T[]> {
    const query = this.buildQuery(ctx);
    // Add pagination, sort, views here...
    return this.repository.find(query);
  }

  get(ctx: ActionContext, id: string): Observable<T> {
    const query = { $and: [{ _id: id }, this.buildQuery(ctx)] };
    return this.repository.findOne(query).pipe(
      switchMap(item => {
        if (!item) return throwError(() => new NotFoundException('Resource not found'));
        return of(item);
      })
    );
  }

  create(ctx: ActionContext, body: any): Observable<T> {
    const beforeHook = this.config.hooks?.beforeCreate ? this.config.hooks.beforeCreate({ body, auth: ctx.auth }) : of(body);
    
    return beforeHook.pipe(
      switchMap(data => this.repository.create(data)),
      tap(entity => {
         if (this.config.gateway?.emitOn?.includes('create') && this.gateway) {
             this.gateway.emitElement(entity);
         }
      }),
      switchMap(entity => {
        return this.config.hooks?.afterCreate ? this.config.hooks.afterCreate({ entity, auth: ctx.auth }).pipe(map(() => entity)) : of(entity);
      })
    );
  }

  update(ctx: ActionContext, id: string, body: any): Observable<T> {
    const query = { $and: [{ _id: id }, this.buildQuery(ctx)] };
    
    const beforeHook = this.config.hooks?.beforeUpdate ? this.config.hooks.beforeUpdate({ body, auth: ctx.auth, id }) : of(body);

    return beforeHook.pipe(
       switchMap(data => 
          this.repository.findOne(query).pipe(
            switchMap(item => {
              if (!item) return throwError(() => new NotFoundException('Resource not found'));
              return this.repository.update(id, data);
            })
          )
       ),
      tap(entity => {
         if (this.config.gateway?.emitOn?.includes('update') && this.gateway) {
             this.gateway.emitElement(entity);
         }
      }),
      switchMap(entity => {
        return this.config.hooks?.afterUpdate ? this.config.hooks.afterUpdate({ entity, auth: ctx.auth }).pipe(map(() => entity)) : of(entity);
      })
    );
  }

  delete(ctx: ActionContext, id: string): Observable<void> {
    const query = { $and: [{ _id: id }, this.buildQuery(ctx)] };
    return this.repository.findOne(query).pipe(
      switchMap(item => {
        if (!item) return throwError(() => new NotFoundException('Resource not found'));
        return this.repository.delete(id);
      }),
      tap(() => {
         if (this.config.gateway?.emitOn?.includes('delete') && this.gateway) {
             // In a real app we might emit the deleted ID
         }
      }),
      map(() => undefined)
    );
  }

  count(ctx: ActionContext): Observable<{ count: number }> {
    const query = this.buildQuery(ctx);
    return this.repository.count(query).pipe(map(count => ({ count })));
  }

  choice(ctx: ActionContext): Observable<any[]> {
     return of([]);
  }

  report(ctx: ActionContext): Observable<any[]> {
      return of([]);
  }
  
  transfer(ctx: ActionContext, body: any): Observable<any> {
      return of({});
  }
}
