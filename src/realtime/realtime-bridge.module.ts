import { DynamicModule, Module, Global, Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { fromEvent, Observable, of, from } from 'rxjs';
import { mergeMap, tap, map } from 'rxjs/operators';
import { GatewayRegistry } from '../gateway/gateway-registry';
// @ts-ignore
import { io, Socket } from 'socket.io-client';

export interface RealtimeRoute {
  resource: string;
  transform: (msg: any) => any;
  persist?: boolean;
  emit?: boolean;
}

export interface RealtimeBridgeConfig {
  url: string;
  auth: { token: string };
  events: string[];
  routes?: Record<string, RealtimeRoute[]>;
}

export const REALTIME_CONFIG = 'REALTIME_CONFIG';

@Injectable()
export class RealtimeBridgeService implements OnModuleInit {
  private socket: Socket;

  constructor(
    @Inject(REALTIME_CONFIG) private readonly config: RealtimeBridgeConfig,
    private readonly gateways: GatewayRegistry,
  ) {
      if (!this.config.routes) this.config.routes = {};
  }

  registerRoute(event: string, route: RealtimeRoute) {
      if (!this.config.routes![event]) this.config.routes![event] = [];
      this.config.routes![event].push(route);
  }

  onModuleInit() {
      if (!this.config.url) return;
      
      this.socket = io(this.config.url, {
          auth: { token: this.config.auth.token }
      });

      this.config.events.forEach(event => {
          fromEvent(this.socket as any, event).pipe(
              mergeMap(msg => this.dispatch(event, msg))
          ).subscribe();
      });
  }

  private dispatch(event: string, msg: any): Observable<void> {
      const routes = this.config.routes![event] || [];
      if (routes.length === 0) return of(undefined);
      
      return from(routes).pipe(
          mergeMap(route => this.applyRoute(route, msg))
      );
  }

  private applyRoute(route: RealtimeRoute, msg: any): Observable<void> {
      const gateway = this.gateways.get(route.resource);
      const entity = route.transform(msg);
      
      const persistObs = route.persist 
          ? (this.gateways.repo(route.resource).upsert 
              ? this.gateways.repo(route.resource).upsert!({}, entity) 
              : this.gateways.repo(route.resource).update(entity.id || entity._id, entity))
          : of(entity);

      return persistObs.pipe(
          tap(final => {
              if (route.emit) gateway.emitElement(final);
          }),
          map(() => undefined)
      );
  }
}

@Global()
@Module({})
export class RealtimeBridgeModule {
  static forRoot(config: RealtimeBridgeConfig): DynamicModule {
    return {
      module: RealtimeBridgeModule,
      providers: [
        { provide: REALTIME_CONFIG, useValue: config },
        RealtimeBridgeService,
        GatewayRegistry,
      ],
      exports: [RealtimeBridgeService, GatewayRegistry],
    };
  }
}
