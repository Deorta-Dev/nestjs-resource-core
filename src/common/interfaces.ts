import { Observable } from 'rxjs';
import { IBaseRepositoryService } from './repository.interface';

export interface Workspace {
  id: string;
  name: string;
  type?: string;
  metadata?: Record<string, any>;
}

export interface AuthResourceApiContext<C = any> {
  token: string;
  userId: string;
  roles?: string[];
  permissions?: string[];
  workspace?: Workspace | null;
  payload?: C;
  allAccess?: boolean;
  propertyIds?: string[];
  metadata?: Record<string, any>;
  [key: string]: any;
}

export interface SessionData<S = any> {
  token: string;
  userId: string;
  expiresAt: Date;
  payload: S;
  revoked?: boolean;
  metadata?: Record<string, any>;
}

export interface SessionStore<S = any> {
  create(session: SessionData<S>): Observable<void>;
  get(token: string): Observable<SessionData<S> | null>;
  update(token: string, data: Partial<SessionData<S>>): Observable<void>;
  delete(token: string): Observable<void>;
  deleteByUser(userId: string): Observable<void>;
  touch(token: string, ttl?: number): Observable<void>;
  clearExpired(): Observable<number>;
}

export interface PermissionProvider {
  getPermissions(auth: AuthResourceApiContext): Observable<string[]>;
  hasPermission(auth: AuthResourceApiContext, permission: string): Observable<boolean>;
}

export interface WorkspaceProvider {
  getCurrent(auth: AuthResourceApiContext): Observable<Workspace | null>;
  list(auth: AuthResourceApiContext): Observable<Workspace[]>;
  select(auth: AuthResourceApiContext, workspaceId: string): Observable<Workspace>;
}

export interface AuthResourceApiStrategyProvider<C = any> {
  readonly type: string;
  authenticate(tokenOrCredential: string, request: any): Observable<AuthResourceApiContext<C>>;
  sessionStore?: SessionStore;
}

export type AuthResourceApiStrategyResolver = (
  request: any,
) => string | null | Observable<string | null>;

export interface PublicResourceRoute {
  name?: string;
  route?: string;
}

export interface AuthResourceApiModuleConfig {
  default: string;
  resolver?: AuthResourceApiStrategyResolver;
  publicResources?: PublicResourceRoute[];
  strategies: Record<string, any>;
  permissionProvider?: any; // Type or token
  workspace?: {
    enabled: boolean;
    provider: any;
    routes?: { current?: string; select?: string; list?: string; };
  };
}

export interface ResourceConfig<T = any> {
  name: string;
  route: string;
  basePath?: string;
  entity: any;
  repositoryService?: any;
  repositoryModule?: any;
  permissions?: { prefix?: string; defaults?: Record<string, string[]> };
  actions?: Record<string, { permission?: string | string[] }>;
  endpoints?: { mode?: 'inclusion' | 'exclusion'; include?: string[]; exclude?: string[] };
  query?: { scope?: (auth: AuthResourceApiContext, ctx?: any) => any; extraMatch?: any };
  filters?: { queryMatchDirectory?: Record<string, any> };
  views?: { default?: string; available?: string[]; paramName?: string; projections?: Record<string, any> };
  reports?: { enabled?: boolean; route?: string; metricMap?: any; dimensionMap?: any; pipelineBeforeReport?: any[]; sort?: any };
  choices?: { enabled?: boolean; fields?: string[]; invert?: boolean };
  gateway?: { enabled?: boolean; namespace?: string; events?: any; emitOn?: string[]; filters?: string[]; auth?: any; setGateway?: any };
  realtime?: { enabled?: boolean; event?: string; transform?: (msg: any) => any; persist?: boolean; emit?: boolean };
  hooks?: { beforeCreate?: (ctx: any) => Observable<any>; afterCreate?: (ctx: any) => Observable<any>; beforeUpdate?: (ctx: any) => Observable<any>; afterUpdate?: (ctx: any) => Observable<any>; };
  setServices?: any;
  addController?: any;
  [key: string]: any;
}
