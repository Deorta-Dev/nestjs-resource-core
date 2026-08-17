# @deorta-dev/nestjs-resource-core

Librería para NestJS que **estandariza el manejo de recursos** en una API: CRUD completo, permisos con prefijo configurable, scope/workspace por autenticación, filtrado, reportes dinámicos por métricas y dimensiones, choices, vistas proyectadas, gateways de tiempo real y documentación automática con Scalar.

Es **independiente de la capa de datos y de la autenticación**: nunca se conecta a la base de datos ni define la estrategia de auth directamente. La autenticación vive en un **módulo propio** (`AuthResourceApiModule`) con estrategias intercambiables, y el acceso a datos se delega a un repositorio dedicado (p. ej. [`@deorta-dev/nestjs-repository-core`](https://github.com/Deorta-Dev/nestjs-repository-core)). La librería se concentra en **control y reglas de negocio**.

## Filosofía

Hay dos piezas de configuración separadas:

- **`AuthResourceApiModule.register()`** — configura la **estrategia de autenticación**: cómo se generan las sesiones, cómo se guardan (memoria/redis/bd), cómo se autentica un token y cómo se resuelven los permisos. Es **una sola instancia compartida** por todos los recursos, y soporta **múltiples estrategias** a la vez (jwt, api-key, oauth, custom).
- **`ResourceApiModule.register()`** — configura **cada recurso**: entidad, DTOs de entrada/salida, endpoints, permisos, filtros, reportes, choices, vistas, gateway y workspace. **Usa la instancia de auth** que ya configuraste en el `AuthResourceApiModule`.

Todo se construye sobre dos clases base configurables: **`CommonApiController`** (registra los endpoints habilitados) y **`CommonApiService`** (lógica de negocio estandarizada).

### Observables primero

La librería está construida **sobre Observables (rxjs)**. Todo el flujo interno — y el contrato de sus interfaces — usa `Observable<T>` como primitiva asíncrona principal y **evita `Promise` siempre que es posible**. Esto permite componer pipelines reactivos (reportes, gateways, lookups, emisiones en tiempo real) con operadores de rxjs.

- Los servicios y controladores devuelven `Observable<T>`.
- Las interfaces (`SessionStore`, `RepositoryService`, `PermissionProvider`, `WorkspaceProvider`, `AuthResourceApiStrategyProvider`, hooks) se definen con `Observable`.
- En las **fronteras externas** (Redis, base de datos, SDKs basados en Promise) el adaptador implementa la interfaz envolviendo con `from()`; nunca al revés.
- Al exponer un endpoint HTTP, Nest se encarga de subscribirse al Observable y resolver la respuesta.

## Instalación

```bash
npm install @deorta-dev/nestjs-resource-core
# o
yarn add @deorta-dev/nestjs-resource-core
```

Peer dependencies:

```bash
npm install @nestjs/common @nestjs/core reflect-metadata rxjs
```

Para documentación con Scalar:

```bash
npm install @scalar/nestjs-api-reference
```

## Inicio rápido

```typescript
// auth.module.ts — una sola estrategia compartida por todos los recursos
import { AuthResourceApiModule } from '@deorta-dev/nestjs-resource-core';
import { SessionRepositoryModule } from './repositories/session';

@Module({
  imports: [
    AuthResourceApiModule.register({
      default: 'jwt',
      strategies: {
        jwt: {
          type: 'jwt',
          secret: process.env.JWT_SECRET,
          expiresIn: '12h',
          // Sesiones persistidas en BD: no se borran al reiniciar el servicio.
          // Para desarrollo puedes usar { type: 'memory' }.
          sessionStore: { type: 'database', repository: SessionRepositoryModule, ttl: 12 * 3600 },
        },
      },
    }),
  ],
})
export class AuthResourceApiCoreModule {}
```

```typescript
// mobile.resource.ts — el recurso NO configura auth; el AuthResourceApiModule
// resuelve la estrategia automáticamente por request
import { ResourceApiModule } from '@deorta-dev/nestjs-resource-core';
import { MobileRepositoryModule, MobileRepositoryService } from './repositories/mobile';
import { MobileEntity } from './entities/mobile.entity';
import { CreateMobileDto, UpdateMobileDto, MobileResponseDto } from './dtos';

export const MobileResourceApiModule = ResourceApiModule.register({
  name: 'mobile',
  route: 'mobiles',

  entity: MobileEntity,
  repositoryService: MobileRepositoryService,
  repositoryModule: MobileRepositoryModule,

  // DTOs de entrada y salida (documentación + tipado)
  dtos: {
    input: {
      create: CreateMobileDto,
      update: UpdateMobileDto,
      transfer: TransferMobileDto,
    },
    output: {
      get: MobileResponseDto,
      list: MobileListResponseDto,
      create: MobileResponseDto,
    },
  },

  endpoints: {
    mode: 'inclusion',
    include: ['create', 'list', 'get', 'update', 'delete', 'count', 'choice'],
  },

  permissions: { prefix: 'mobile' },
});
```

```typescript
// app.module.ts
@Module({
  imports: [AuthResourceApiCoreModule, MobileResourceApiModule],
})
export class AppModule {}
```

Con esto obtienes `POST /mobiles`, `GET /mobiles`, `GET /mobiles/:id`, `PUT /mobiles/:id`, `DELETE /mobiles/:id`, `GET /mobiles/count` y `GET /mobiles/choice`, protegidos con la estrategia `jwt`, con permisos `mobile:create`, `mobile:list`, etc., y documentados en Scalar.

---

## Módulo de Autenticación (`AuthResourceApiModule`)

El `AuthResourceApiModule` es **único en la app** y centraliza toda la autenticación. Varios recursos comparten la misma instancia y las mismas sesiones. Soporta **varias estrategias simultáneas** y decide por request cuál usar (el recurso no elige).

### `AuthResourceApiModule.register(config)`

```typescript
AuthResourceApiModule.register({
  default: 'jwt',                   // estrategia usada por defecto (fallback)

  // Selección de estrategia por request: decide cuál usar según la
  // credencial presente. Si devuelve null/undefined, usa `default`.
  resolver: (request) => {
    if (request.headers['x-api-key']) return 'apiKey';
    if (request.headers.authorization?.startsWith('Bearer ')) return 'jwt';
    if (request.headers.authorization?.startsWith('OAuth ')) return 'oauth';
    return null;                    // → usa `default`
  },

  // Recursos/endpoints públicos: no requieren autenticación.
  // Se puede declarar por nombre de recurso (todos sus endpoints) o por ruta.
  publicResources: [
    { name: 'catalog' },            // recurso completo público
    { route: 'GET /health' },       // ruta puntual pública
    { route: 'POST /auth/login' },  // (ej.: login no requiere auth)
  ],

  strategies: {
    // ----- JWT -----
    jwt: {
      type: 'jwt',
      secret: process.env.JWT_SECRET,
      expiresIn: '1h',
      // Genera/valida el payload de la sesión
      issuer: 'my-api',
    },

    // ----- API Key -----
    apiKey: {
      type: 'api-key',
      header: 'x-api-key',          // header donde viaja la key
      provider: MyApiKeyProvider,   // valida la key y devuelve el AuthResourceApiContext
      // Sin sessionStore → STATELESS (key permanente, ver "API keys permanentes").
      // Con sessionStore opcional → cache de resolución + lastUsedAt.
    },

    // ----- OAuth / OIDC -----
    oauth: {
      type: 'oauth',
      provider: MyOAuthProvider,    // intercambia token OAuth por AuthResourceApiContext
      sessionStore: { type: 'custom', provider: DatabaseSessionStore },
    },

    // ----- Estrategia custom -----
    custom: {
      type: 'custom',
      provider: MyAuthResourceApiStrategyProvider, // implements AuthResourceApiStrategyProvider
      sessionStore: { type: 'custom', provider: MySessionStore },
    },
  },

  // Estrategia de permisos compartida (ver "Permisos")
  permissionProvider: MyPermissionProvider,

  // Workspaces (ver "Workspaces") — estrategia de la sesión, compartida por todos los recursos
  workspace: {
    enabled: true,
    provider: MyWorkspaceProvider,   // implements WorkspaceProvider
    routes: {
      current: 'workspace/current',  // GET: workspace actual de la sesión
      select: 'workspace/select',    // PUT: seleccionar workspace
      list: 'workspace/list',        // GET: workspaces a los que tiene acceso
    },
  },
})
```

### Qué expone el `AuthResourceApiModule`

- `AuthResourceApiService` — servicio inyectable con `getAuthentication(token)`, `createSession()`, `destroySession()`, etc. Lo usan los guards de todos los recursos.
- `WorkspaceResourceApiService` — servicio de workspaces (`getCurrent()`, `list()`, `select()`) que alimenta las rutas de workspace y expone el workspace actual de la sesión para que los recursos lo usen en su scope.
- `AuthResourceApiGuard` — guard global que resuelve la estrategia por request (`resolver` + `default`) y verifica `publicResources`.
- `@AuthResourceApi()` — decorador que inyecta el `AuthResourceApiContext` resuelto en el request.
- `publicResources` — registro central de recursos/endpoints públicos, consultado por el guard.

### Cómo se elige la estrategia

La selección vive **solo en el `AuthResourceApiModule`**; el `ResourceApiModule` no configura nada de auth. Un guard global (`AuthResourceApiGuard`) aplica el `resolver` a **todos** los endpoints:

1. Si el endpoint está en `publicResources` → se sirve sin autenticación.
2. Si el endpoint declara `@ResourceAction({ strategy: 'apiKey' })` → usa esa estrategia.
3. Si el `resolver(request)` devuelve una estrategia → la usa.
4. Si no → usa `default`.

```typescript
// Tipo del resolver (interfaz provista por la librería)
export type AuthResourceApiStrategyResolver = (
  request: any,
) => string | null | Observable<string | null>;

// Guard global registrado por AuthResourceApiModule (no se configura por recurso)
AuthResourceApiGuard.apply(resolver); // interno
```

> El `ResourceApiModule` **no recibe `authStrategy`**: no conoce ni elige estrategias. La decisión la toma `AuthResourceApiModule` por request.

### Endpoints públicos y excepciones por endpoint

Los casos especiales se declaran **en el endpoint**, no en el recurso:

```typescript
@Get('health')
@ResourceAction({ public: true })      // público, sin auth
status(@AuthResourceApi() auth) { ... }

@Get('external/report')
@ResourceAction({ strategy: 'apiKey' }) // excepción puntual: usa apiKey
report(@AuthResourceApi() auth) { ... }
```

> Un endpoint marcado `public: true` se sirve sin autenticación (sin `@AuthResourceApi()` resuelto). Un `strategy` concreto sobreescribe la decisión del `resolver`/`default` para ese endpoint.

### Estrategia custom (`AuthResourceApiStrategyProvider`)

La librería solo define la interfaz; la implementación la aporta tu proyecto (o un paquete complementario).

```typescript
export interface AuthResourceApiStrategyProvider<C = any> {
  readonly type: string;

  // Dado el token/credencial, devuelve el contexto de autenticación
  authenticate(tokenOrCredential: string, request: any): Observable<AuthResourceApiContext<C>>;

  // Opcional: si NO se provee, la estrategia es STATELESS (sin sesión).
  // Las API keys permanentes no necesitan sesión: la key es la credencial.
  sessionStore?: SessionStore;
}
```

> `sessionStore` es opcional. **Sin `sessionStore` la estrategia es stateless**: no se crea ni se persiste sesión (ideal para API keys permanentes). Con `sessionStore` (p. ej. memoria con TTL corto) puedes **cachear** la resolución de la key y registrar `lastUsedAt`.

### API keys permanentes (acceso sin login)

Para que un usuario consuma la API **sin login, de forma permanente**, se usa la estrategia `api-key` con un provider que valida la key contra la colección de `apiKeys` del proyecto. La key **no es una sesión**: es una credencial estática con su propio ciclo de vida (revocación inmediata al borrarla).

**1. Configura la estrategia y el resolver** (en `AuthResourceApiModule`):

```typescript
AuthResourceApiModule.register({
  default: 'jwt',

  resolver: (request) => {
    if (request.headers['x-api-key']) return 'apiKey';            // → key permanente
    if (request.headers.authorization?.startsWith('Bearer ')) return 'jwt';  // → sesión
    return null;
  },

  strategies: {
    jwt: {
      type: 'jwt',
      secret: process.env.JWT_SECRET,
      sessionStore: { type: 'database', repository: SessionRepositoryModule, ttl: 12 * 3600 },
    },
    apiKey: {
      type: 'api-key',
      header: 'x-api-key',
      provider: ApiKeyProvider,        // valida la key y construye el contexto
      // sin sessionStore: STATELESS (la key es permanente)
    },
  },
})
```

**2. `apiKeys` como recurso** (scoped por workspace; `expiresAt: null` = permanente):

```typescript
// control/api-key/api-key.resource.ts
ResourceApiModule.register({
  name: 'apiKey',
  route: 'api-keys',
  entity: ApiKey,
  workspace: { field: 'propertyId', required: true },

  actions: {
    list: { permission: 'apiKey.view' },
    get: { permission: 'apiKey.view' },
    create: { permission: 'apiKey.create' },
    delete: { permission: 'apiKey.create' },   // revocar
  },
  endpoints: { include: ['create', 'list', 'get', 'delete'] },

  query: { scope: subtreeScope },   // el workspace y sus sub-workspaces

  setServices: ApiKeyService,       // genera la key, guarda SOLO el hash
})
```

**3. `ApiKeyService`** — genera la key en claro una única vez y guarda el hash (el claro nunca se persiste):

```typescript
@Injectable()
export class ApiKeyService extends CommonApiService<ApiKey> {
  override create(ctx, body): Observable<{ id: string; key: string; expiresAt: Date | null }> {
    const key = randomBytes(32).toString('hex');            // clave en claro (solo ahora)
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;   // null = permanente
    return this.repository.create({
      ...body,
      keyHash: sha256(key),                                 // SOLO el hash se guarda
      createdBy: ctx.auth.userId,
    }).pipe(
      map((entity) => ({ id: entity._id, key, expiresAt })),  // se devuelve UNA vez
    );
  }
}
```

**4. `ApiKeyProvider`** — valida la key por hash y **construye el contexto directamente** (sin sesión):

```typescript
// auth/strategies/api-key.provider.ts
@Injectable()
export class ApiKeyProvider implements AuthResourceApiStrategyProvider<ApiKeyPayload> {
  readonly type = 'api-key';

  constructor(private readonly apiKeys: IBaseRepositoryService<ApiKey>) {}

  // sin sessionStore → stateless: la key ES la credencial, no caduca
  authenticate(key: string, request: any): Observable<AuthResourceApiContext<ApiKeyPayload>> {
    return this.apiKeys.findOne({ keyHash: sha256(key) }).pipe(
      switchMap((apiKey) => {
        if (!apiKey || (apiKey.expiresAt && apiKey.expiresAt < new Date())) {
          throw new UnauthorizedException('API key inválida o expirada');
        }
        return this.apiKeys.update(apiKey._id, { lastUsedAt: new Date() }).pipe(   // opcional
          map(() => ({
            token: apiKey.keyHash,                     // no es una sesión
            userId: apiKey.userId,
            workspace: { id: apiKey.propertyId, name: apiKey.propertyName },   // workspace fijo
            payload: { scopes: apiKey.permissions, propertyIds: [apiKey.propertyId] },
          }) as AuthResourceApiContext<ApiKeyPayload>),
        );
      }),
    );
  }
}
```

**5. Revocación** — como la estrategia es **stateless**, revocar es instantáneo: `DELETE /api-keys/:id` borra la key y el provider deja de encontrarla por hash. No hay sesiones que matar.

```typescript
// el cliente solo envía el header
fetch('/mobiles', { headers: { 'x-api-key': key } });
```

> En el **Módulo Control**, este mecanismo cubre las integraciones permanentes (sistemas externos, servicios de reporte, apps de terceros). Como la key es del `workspace` (`propertyId`), el scope (`query.scope`) aplica igual: solo ve los recursos de su property y sub-workspaces. Los ids hardcodeados del sistema actual se reemplazan por `apiKeys` de cada property.

---

## Sesiones de autenticación (persistencia en BD)

Las sesiones **se persisten en base de datos por defecto**, de modo que **no se pierden al reiniciar el servicio**. La librería no conoce tu ORM, pero **suministra el `DatabaseSessionStore`** que usa tu `RepositoryService<Session>` (vía `@deorta-dev/nestjs-repository-core`): solo necesitas darle el repositorio de la colección `sessions`.

### Interfaz base

```typescript
export interface SessionData<S = any> {
  token: string;
  userId: string;
  expiresAt: Date;
  payload: S;
  revoked?: boolean;
  metadata?: Record<string, any>;
}

// Observable-first: los adaptadores externos envuelven con `from()`
export interface SessionStore<S = any> {
  create(session: SessionData<S>): Observable<void>;
  get(token: string): Observable<SessionData<S> | null>;
  update(token: string, data: Partial<SessionData<S>>): Observable<void>;
  delete(token: string): Observable<void>;
  deleteByUser(userId: string): Observable<void>;
  touch(token: string, ttl?: number): Observable<void>;
  clearExpired(): Observable<number>;
}
```

### Store por defecto: base de datos

`DatabaseSessionStore` (provisto por la librería) persiste en tu BD y sobrevive a reinicios y reempliegues. Requiere un repositorio de sesiones (`sessions`) expuesto por tu `RepositoryService`:

```typescript
// sessions.repository.module.ts — de tu proyecto (repositorio de la colección sessions)
@RepositoryModule({ name: 'session', model: Session })
export class SessionRepositoryModule {}
```

```typescript
strategies: {
  jwt: {
    type: 'jwt',
    secret: process.env.JWT_SECRET,
    expiresIn: '12h',
    // Persistencia en BD: las sesiones no se borran al reiniciar el servicio
    sessionStore: { type: 'database', repository: SessionRepositoryModule, ttl: 12 * 3600 },
  },
}
```

Comportamiento del store:

- `get(token)` consulta `{ token, expiresAt: { $gt: now } }`: una sesión expirada no se devuelve (equivale a no existir).
- `create` guarda la sesión con su `expiresAt` (TTL).
- `touch(token, ttl)` **extiende** `expiresAt` (actividad del usuario).
- `deleteByUser(userId)` revoca todas las sesiones de un usuario (logout global).
- `clearExpired()` borra `{ expiresAt: { $lt: now } }`. Ejecútalo en un cron (`@nestjs/schedule`) para no acumular registros.

```typescript
// app.module.ts — limpieza periódica de sesiones expiradas
@Cron(CronExpression.EVERY_10_MINUTES)
clearExpiredSessions(): void {
  this.authSrv.clearExpiredSessions().subscribe();   // delega en el SessionStore
}
```

**Índices recomendados** en la colección `sessions`: `{ token: 1 }` único, `{ userId: 1 }`, `{ expiresAt: 1 }` (para `clearExpired`).

### Store de memoria: solo desarrollo

La implementación en memoria se mantiene para desarrollo/pruebas: **no persiste entre reinicios**.

```typescript
sessionStore: { type: 'memory', ttl: 3600 },
```

### Redis: capa opcional (no fuente de verdad)

Redis es útil como **capa de cache/TTL** con acceso O(1), pero **si es el único store, las sesiones se pierden al reiniciar** (o al perder Redis, salvo AOF/RDB). Para persistencia real la fuente de verdad es la BD. Si usas Redis, implementa la interfaz `SessionStore` (o un paquete complementario):

```typescript
// my-redis-session.store.ts
import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Observable, from, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { SessionData, SessionStore } from '@deorta-dev/nestjs-resource-core';

@Injectable()
export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  create(session: SessionData): Observable<void> {
    return from(this.redis.setex(
      `session:${session.token}`,
      Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
      JSON.stringify(session),
    )).pipe(map(() => undefined));
  }

  get(token: string): Observable<SessionData | null> {
    return from(this.redis.get(`session:${token}`)).pipe(
      map((raw) => (raw ? JSON.parse(raw) : null)),
    );
  }

  update(token: string, data: Partial<SessionData>): Observable<void> {
    return this.get(token).pipe(
      mergeMap((session) => (session ? this.create({ ...session, ...data }) : of(undefined))),
    );
  }

  delete(token: string): Observable<void> {
    return from(this.redis.del(`session:${token}`)).pipe(map(() => undefined));
  }

  deleteByUser(userId: string): Observable<void> {
    return of(undefined);   // indexar por usuario si se necesita
  }

  touch(token: string, ttl?: number): Observable<void> {
    return from(this.redis.expire(`session:${token}`, ttl ?? 3600)).pipe(map(() => undefined));
  }

  clearExpired(): Observable<number> {
    return of(0); // Redis expira solo
  }
}
```

### Store externo (`custom`)

Para casos especiales (otra BD, cache-first con write-through, etc.) implementas la interfaz y la registras:

```typescript
sessionStore: {
  type: 'custom',
  provider: RedisSessionStore,   // clase o instancia que implementa SessionStore
}
```

> La misma lógica aplica para cache: la librería define la interfaz `CacheStore`; su única implementación interna es la de memoria (los cachés también pueden persistirse en BD si lo requieren).

---

## Login, registro de usuarios, roles y contexto

La librería **no gestiona usuarios, ni login, ni registro**. Solo gestiona **sesiones** (`SessionStore`), **validación de tokens** (`AuthResourceApiService`) y **permisos** (`PermissionProvider`). Los usuarios, sus credenciales y sus roles viven en **tu repositorio de usuarios** (base de datos del proyecto); el login y el registro son **endpoints custom** que tú implementas y declaras como públicos.

### El contexto (`AuthResourceApiContext`)

Es el objeto que recibe cada handler vía `@AuthResourceApi()`. La librería lo construye desde la sesión y los providers:

```typescript
export interface AuthResourceApiContext<C = any> {
  token: string;                       // token autenticado (de la sesión)
  userId: string;                      // usuario autenticado
  roles?: string[];                    // roles del usuario (los pone tu proyecto)
  permissions?: string[];              // permisos resueltos (PermissionProvider)
  workspace?: Workspace | null;        // workspace actual de la sesión
  payload?: C;                         // payload de la estrategia (lo que quieras)
  metadata?: Record<string, any>;
  [key: string]: any;                  // extiende con datos propios del proyecto
}
```

### Registro de usuarios

El registro es un **endpoint custom y público** de tu proyecto. La librería no interviene: tú validas, hasheas la contraseña, creas el usuario (con su rol) en tu repositorio y —si quieres— haces login automático:

```typescript
// auth.controller.ts — controlador del PROYECTO (no de la librería)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly users: UserRepositoryService,      // repo externo de tu proyecto
    private readonly authSrv: AuthResourceApiService,   // de la librería
  ) {}

  @Post('register')
  @ResourceAction({ public: true })                     // público: sin autenticación
  register(@Body() dto: RegisterDto): Observable<TokenResponse> {
    const passwordHash = hashPassword(dto.password);
    return this.users.create({
      email: dto.email,
      passwordHash,
      roles: dto.roles ?? ['user'],                     // roles asignados en el registro
    }).pipe(
      switchMap(() => this.login({ email: dto.email, password: dto.password })),
    );
  }
}
```

> Recuerda registrar `POST /auth/register` en `publicResources` (junto a `POST /auth/login`). Los roles son **strings de tu dominio** (`admin`, `user`, `property-admin`, ...); la librería no los conoce ni los valida.

### Login

El login también es un endpoint **custom y público**. Flujo:

1. El cliente envía credenciales a `POST /auth/login`.
2. Tu proyecto valida contra el **repositorio de usuarios** (externo).
3. Construye el `payload` de la sesión (roles, workspace, etc.).
4. Llama a `AuthResourceApiService.createSession()`: la librería genera el token y lo **persiste en el `SessionStore` configurado** (memoria/Redis/BD).
5. Devuelve el token al cliente.

```typescript
@Post('login')
@ResourceAction({ public: true })
login(@Body() dto: LoginDto): Observable<{ token: string }> {
  return this.users.findOne({ email: dto.email }).pipe(
    switchMap((user) => {
      if (!user || !verifyPassword(dto.password, user.passwordHash)) {
        throw new UnauthorizedException('Credenciales inválidas');
      }
      return this.authSrv.createSession({
        userId: user.id,
        ttl: 3600,                                   // expiración (la respeta el SessionStore)
        payload: {
          email: user.email,
          roles: user.roles,                         // para el contexto
          // workspace, propertyIds, etc. según tu estrategia
        },
      });
    }),
  );
}
```

### Cómo se resuelve el contexto en cada request

1. El cliente envía `Authorization: Bearer <token>` (o la credencial de la estrategia resuelta).
2. `AuthResourceApiGuard` (global) elige la estrategia con `resolver`/`default`.
3. La estrategia consulta `SessionStore.get(token)` y valida expiración/revocación.
4. La librería hidrata el `AuthResourceApiContext`: `userId`, `permissions` (vía `PermissionProvider.getPermissions`), `workspace` (vía `WorkspaceResourceApiService`), `payload`.
5. El handler lo recibe con `@AuthResourceApi()` y lo usa en `query.scope`, permisos, hooks, etc.

### Roles → permisos

La librería trabaja con **permisos (strings)**; la traducción roles→permisos la hace tu proyecto en `PermissionProvider`:

```typescript
@Injectable()
export class MyPermissionProvider implements PermissionProvider {
  constructor(private readonly users: UserRepositoryService) {}

  getPermissions(auth: AuthResourceApiContext): Observable<string[]> {
    return this.users.findOne({ _id: oid(auth.userId) }).pipe(
      map((user) => flattenPermissions(user.roles)),  // admin → ['*'], user → ['mobile:list', ...]
    );
  }

  hasPermission(auth: AuthResourceApiContext, permission: string): Observable<boolean> {
    return this.getPermissions(auth).pipe(
      map((perms) => perms.includes('*') || perms.includes(permission)),
    );
  }
}
```

### Resumen de responsabilidades

| Tema | ¿Quién lo gestiona? |
|------|---------------------|
| Usuarios, contraseñas, roles | Tu proyecto (repositorio de usuarios) |
| Registro de usuarios | Tu proyecto (endpoint custom público) |
| Login (validar credenciales) | Tu proyecto (endpoint custom público) |
| Roles → permisos | Tu proyecto (`PermissionProvider`) |
| Persistir sesión/token | La librería (`DatabaseSessionStore` sobre tu `sessions`) |
| Validar token por request | La librería (`AuthResourceApiService.getAuthentication`) |
| Verificar permiso por endpoint | La librería (guard + `PermissionProvider`) |
| Contexto por request | La librería (`@AuthResourceApi()` → `AuthResourceApiContext`) |

---

## Invitaciones de usuarios por workspace

La librería tampoco gestiona invitaciones: son una **entidad de tu proyecto** (como cualquier recurso). El patrón recomendado es modelar `Invitation` con `ResourceApiModule` (scoped por workspace) y exponer solo dos flujos:

1. **Invitar** — autenticado, requiere permiso sobre el workspace.
2. **Aceptar** — **público**, autenticado por el **token de la invitación** (no por sesión), ya que el invitado aún no es usuario.

### Exposición del registro

El registro **se expone o no según lo que pongas en `publicResources`**. Para que los usuarios **solo** entren por invitación:

- No declares `POST /auth/register` en `publicResources` (o ni lo implementes).
- El alta de cuenta ocurre únicamente dentro del flujo de **aceptar invitación** (token válido → se crea el usuario). Así no hay registro abierto.

### Recurso `Invitation`

```typescript
// invitation.resource.ts — como cualquier recurso, scoped por workspace
ResourceApiModule.register({
  name: 'invitation',
  route: 'invitations',
  entity: InvitationEntity,

  // el workspace es la entidad sobre la que se invita
  workspace: { field: 'workspaceId', required: true },

  permissions: { prefix: 'workspace' },   // workspace:invite, workspace:invite.list, ...

  actions: {
    create: { permission: 'workspace:invite' },
    list: { permission: 'workspace:invite.list' },
    get: { permission: 'workspace:invite.list' },
    update: { permission: 'workspace:invite' },
    delete: { permission: 'workspace:invite' },
  },

  endpoints: { include: ['create', 'list', 'get', 'update', 'delete'] },

  // Crear una invitación genera su token y dispara el envío.
  // Los hooks son funciones de config: para usar servicios inyectables
  // envuélvelos en una factory o delega en tu dominio (sendInviteEmail).
  hooks: {
    afterCreate: ({ entity }) =>
      sendInviteEmail(entity),   // función de tu dominio (usa el token del body)
  },
})
```

Cada invitación guarda: `workspaceId`, `email`, `roles` (los que se asignarán), `token`, `status` (`pending`/`accepted`/`revoked`) y `expiresAt`.

### Aceptar la invitación (público)

Es un endpoint **custom y público** que valida el token de la invitación (no una sesión). Se agrega con `addController`:

```typescript
@Controller('invitations')
export class InvitationAcceptController implements ICustomActionController<Invitation> {
  constructor(
    private readonly invitations: InvitationRepositoryService,  // repo del proyecto
    private readonly users: UserRepositoryService,              // repo de usuarios
  ) {}

  // NO está en publicResources por ruta: se marca público en el endpoint
  @Post('accept')
  @ResourceAction({ public: true })                 // sin auth: el token ES la credencial
  accept(@Body() dto: { token: string }): Observable<User> {
    return this.invitations.findOne({ token: dto.token }).pipe(
      switchMap((inv) => {
        if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) {
          throw new BadRequestException('Invitación inválida o expirada');
        }
        // Crea (o actualiza) el usuario con los roles de la invitación y
        // lo vincula al workspace. A partir de aquí aparece en
        // WorkspaceProvider.list(auth) y puede hacer `select`.
        return this.users.createOrAttachToWorkspace({
          email: inv.email,
          roles: inv.roles,
          workspaceId: inv.workspaceId,
        }).pipe(
          switchMap((user) =>
            this.invitations.update(inv.id, { status: 'accepted' }).pipe(map(() => user)),
          ),
        );
      }),
    );
  }
}
```

```typescript
ResourceApiModule.register({
  name: 'invitation',
  route: 'invitations',
  addController: InvitationAcceptController,
  ...
})
```

### Flujo completo

1. Un usuario con `workspace:invite` invita a `email` (con `roles`) → se crea `Invitation` y se envía el link.
2. El invitado abre el link. Dos casos:
   - **Ya tiene cuenta** → inicia sesión (`POST /auth/login`, público) y acepta la invitación; el `PermissionProvider` ya le otorga los roles.
   - **No tiene cuenta** → `POST /invitations/accept` (público) valida el token y **crea el usuario** con los roles de la invitación, sin registro abierto.
3. El usuario acepta y ya puede `select` ese workspace (`WorkspaceResourceApiService`).

> Con este flujo **no necesitas exponer `register`**: el alta de usuarios queda limitada a invitaciones válidas. Si además quieres registro abierto, simplemente agrégalo a `publicResources`.

---

## Configuración completa del recurso

### `ResourceApiModule.register(config: ResourceConfig)`

```typescript
ResourceApiModule.register({
  // ---------------------------------------------------------------
  // Identidad del recurso
  // ---------------------------------------------------------------
  name: 'mobile',
  route: 'mobiles',
  basePath: '/api/v1',           // Prefijo global opcional

  // ---------------------------------------------------------------
  // Entidad y DTOs (entrada y salida)
  // ---------------------------------------------------------------
  entity: MobileEntity,
  dtos: {
    input: {
      create: CreateMobileDto,
      update: UpdateMobileDto,
      list: ListMobileDto,           // query params tipados
      delete: DeleteMobileDto,
      transfer: TransferMobileDto,
      // custom: CustomActionDto,
    },
    output: {
      create: MobileResponseDto,
      update: MobileResponseDto,
      get: MobileResponseDto,
      list: MobileListResponseDto,   // { objects, pagination }
      count: CountResponseDto,
      choice: ChoiceResponseDto,
      transfer: TransferResponseDto,
      // custom: CustomActionResponseDto,
    },
  },

  // ---------------------------------------------------------------
  // Capa de datos (delegada a nestjs-repository-core o equivalente)
  // ---------------------------------------------------------------
  repositoryService: MobileRepositoryService,
  repositoryModule: MobileRepositoryModule,

  // Nota: NO se configura auth aquí. La estrategia, endpoints públicos
  // y resolución por request viven en AuthResourceApiModule.

  // ---------------------------------------------------------------
  // Endpoints habilitados — por inclusión o exclusión
  // ---------------------------------------------------------------
  endpoints: {
    mode: 'inclusion',             // 'inclusion' | 'exclusion'
    include: [
      'create', 'list', 'get', 'update', 'delete',
      'count', 'choice', 'transfer',
    ],
    // o si mode = 'exclusion':
    // exclude: ['transfer'],
    //
    // Nota: getCurrent, updateCurrent, consolidate y similares NO son
    // acciones base. Son funciones personalizadas: agrégalas con
    // `addController` o heredando de CommonApiService.
  },

  // ---------------------------------------------------------------
  // Permisos — prefijo por defecto + overrides por endpoint
  // ---------------------------------------------------------------
  permissions: {
    prefix: 'mobile',              // 'mobile' -> mobile:create, mobile:list ...
    delimiter: ':',
    // defaults: sobrescribe los permisos base por acción
    defaults: {
      create: ['mobile:create'],
      list: ['mobile:list'],
      get: ['mobile:read'],
      update: ['mobile:update'],
      delete: ['mobile:delete'],
      count: ['mobile:count'],
      choice: ['mobile:choice'],
      transfer: ['mobile:transfer'],
      report: ['mobile:report'],
    },
  },

  // Permiso específico por endpoint (reemplaza el prefijo)
  actions: {
    create: { permission: ['mobile:create', 'admin:mobiles'] },
    list: { permission: 'mobile:list' },
    get: { permission: 'mobile:read' },
    update: { permission: 'mobile:update' },
    delete: { permission: 'mobile:delete' },
    count: { permission: 'mobile:count' },
    choice: { permission: 'mobile:choice' },
    // transfer mueve el recurso de un workspace a otro
    transfer: { permission: 'mobile:transfer' },
  },

  // ---------------------------------------------------------------
  // Scope de la query — basado en auth (equivalente a authFunction)
  // Se inyecta en TODA operación del recurso (list, get, update, ...)
  // ---------------------------------------------------------------
  query: {
    // Recibe el auth (con su workspace actual) y devuelve el filtro que
    // restringe los datos del recurso al ámbito del usuario
    scope: (auth, ctx) => ({
      $or: [
        { mobilePropertyId: { $in: auth.propertyIds } },
        { devicePropertyId: { $in: auth.propertyIds } },
      ],
    }),

    // Filtros extra siempre presentes (p. ej. no mostrar eliminados)
    extraMatch: { status: { $ne: 'deleted' } },

    // Nota: la proyección de lectura NO va aquí — se configura en `views`
    // (views.projections + views.default). Ver sección "Vistas proyectadas".
  },

  // ---------------------------------------------------------------
  // Workspace del recurso — campo configurable de la entidad que
  // identifica a qué workspace pertenece. NO tiene por qué llamarse
  // workspaceId: puede ser propertyId, spaceId, projectId, etc.
  // ---------------------------------------------------------------
  workspace: {
    field: 'propertyId',           // campo de la entidad (configurable)
    // required: true,             // opcional: el recurso siempre pertenece a un workspace
  },

  // ---------------------------------------------------------------
  // Filtrado — conversión de HTTP GET a filtro del repositorio (Mongo)
  // Cada clave del dict es un query param; define cómo convertirlo
  // (ver sección "Filtrado: de HTTP GET a MongoDB")
  // ---------------------------------------------------------------
  filters: {
    // Diccionario de conversión (equivalente a queryMatchDirectory)
    queryMatchDirectory: {
      // Filtro simple sobre la misma columna
      name: { operation: 'regex', type: 'string' },
      status: { operation: 'eq', type: 'string' },

      // Filtro sobre otra columna (attribute) con cast de tipo
      deviceId: { operation: 'eq', type: 'id' },
      startDeviceTime: { attribute: 'deviceTime', type: 'date', operation: 'gte' },
      endDeviceTime: { attribute: 'deviceTime', type: 'date', operation: 'lt' },

      // Params anidados (dot path) y tipo
      prevStartDeviceTime: { attribute: 'prev.deviceTime', type: 'date', operation: 'gte' },

      // Expresión personalizada (recibe el valor crudo del query)
      sensor: {
        expr: (value) => {
          const queries = (Array.isArray(value) ? value : [value]).map((v) => {
            const [sensorKey, valueString] = v.split('=');
            return { $eq: [{ $toString: `$${sensorKey}` }, valueString] };
          });
          return { $expr: { $or: queries } };
        },
      },

      // Params requeridos (error 400 si faltan)
      hasMobile: {
        expr: (value) => {
          const booleans = (Array.isArray(value) ? value : [value]).map(
            (v) => /^(s|yes|true|1|y)$/gi.test(v)
          );
          return {
            $or: booleans.map((b) => ({
              mobileId: { [b ? '$ne' : '$eq']: null },
            })),
          };
        },
        require: true,
      },
    },

    // Paginación (query: $size, $page)
    maxLimit: 100,
    defaultLimit: 20,
    defaultPage: 1,

    // Ordenamiento (query: $sort:<campo>=asc|desc)
    sort: {
      default: { key: 'createdAt', value: 'desc' },
      attributes: { createdAt: 'createdAt', name: 'name', lastPositionTime: 'interaction.lastPositionTime' },
    },
  },

  // ---------------------------------------------------------------
  // Reportes dinámicos — métricas y dimensiones
  // ---------------------------------------------------------------
  reports: {
    enabled: true,
    route: 'report',               // GET /mobiles/report
    metricMap: {
      total: { $sum: 1 },
      maxSpeed: { $max: '$speed' },
      lastDeviceTime: { $max: '$deviceTime' },
      firstDeviceTime: { $min: '$deviceTime' },
    },
    dimensionMap: {
      mobileId: { expr: '$mobileId' },
      mobileName: {
        expr: '$mobileId',
        replaceLookup: {
          ormService: mobileSrv,       // repositorio externo
          foreignerKey: '_id',
          exprLabel: '$name',
        },
      },
    },
    pipelineBeforeReport: [{ $sort: { deviceTime: -1 } }],
    sort: {
      default: { key: 'deviceTime', value: 'asc' },
      attributes: { deviceTime: 'deviceTime', speed: 'speed' },
    },
  },

  // ---------------------------------------------------------------
  // Choices (listas de selección para frontend)
  // ---------------------------------------------------------------
  choices: {
    enabled: true,
    fields: ['type', 'status', 'category'],
    // La inversión se hace en el mismo endpoint /choice con ?invert=true
    invert: true,
  },

  // ---------------------------------------------------------------
  // Vistas proyectadas — fuente ÚNICA de proyección de lectura
  // (sustituye al antiguo query.projection)
  // ---------------------------------------------------------------
  views: {
    default: 'base',               // proyección aplicada si no llega ?view=
    available: ['base', 'summary', 'detail', 'minimal'],
    paramName: 'view',             // ?view=summary

    projections: {
      // Campos a proyectar (lista) ...
      summary: ['id', 'name', 'status', 'type'],
      detail: ['*'],
      minimal: ['id', 'name'],
      // ... o expresión cruda (p. ej. estilo Mongo/aggregate)
      base: { processPipe: 0 },
    },
  },

  // ---------------------------------------------------------------
  // Gateway de tiempo real (Socket.IO) — por recurso.
  // Cada cambio (create/update/delete/transfer) emite a los sockets
  // autenticados cuya suscripción (filtro + scope) coincide con el elemento.
  // ---------------------------------------------------------------
  gateway: {
    enabled: true,
    namespace: '/mobiles',        // namespace propio del recurso

    // Eventos que emite el gateway
    events: {
      element: 'mobile:element',        // elemento emitido
      list: 'mobile:list',              // cambio de lista filtrada
      subscribed: 'mobile:subscribed',  // confirmación de suscripción
    },

    // Acciones CRUD que disparan emisión
    emitOn: ['create', 'update', 'delete', 'transfer'],

    // Qué suscribir: reutiliza `queryMatchDirectory` del recurso, pero
    // limitado a estos campos. El scope (query.scope) siempre se aplica.
    filters: ['status', 'type', 'propertyId'],

    // Autenticación: token en el handshake. La estrategia se resuelve
    // por AuthResourceApiModule (resolver/default) igual que en HTTP.
    auth: { tokenQuery: 'token' },

    // Opcional: clase propia que extiende CommonGateway
    // setGateway: MobileGateway,
  },

  // ---------------------------------------------------------------
  // Bridge de tiempo real — consume un server socket externo
  // (p. ej. el normalizador, estilo Traccar) y emite en este recurso.
  // Ver sección "Bridge de tiempo real (consumir un server socket externo)".
  // ---------------------------------------------------------------
  realtime: {
    enabled: true,
    event: 'position',                    // evento del server socket que consume
    transform: (msg) => toEntity(msg),    // payload normalizador → entidad del recurso
    persist: false,                       // false: el normalizador ya escribió en BD
    emit: true,                           // true: emite vía el gateway del recurso
  },

  // ---------------------------------------------------------------
  // Hooks de ciclo de vida (reglas de negocio)
  // ---------------------------------------------------------------
  hooks: {
    // Los hooks reciben el contexto y devuelven Observable (o valor directo)
    beforeCreate: ({ body, auth }) => of(body),
    afterCreate: ({ entity, auth }) => of(entity),
    beforeList: ({ query, auth }) => of(query),
    afterList: ({ result, auth }) => of(result),
    beforeUpdate: ({ id, body, auth }) => of(body),
    afterUpdate: ({ entity, auth }) => of(entity),
    beforeDelete: ({ id, auth }) => of(true),
    afterDelete: ({ id, auth }) => of(true),
  },

  // ---------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------
  cache: {
    enabled: true,
    store: 'memory',               // 'memory' | custom
    ttl: 300,
    keyPrefix: 'resource:mobiles',
    invalidateOn: ['create', 'update', 'delete'],
  },

  // ---------------------------------------------------------------
  // Validación de DTOs
  // ---------------------------------------------------------------
  validation: {
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  },

  // ---------------------------------------------------------------
  // Documentación con Scalar — config GENÉRICA del recurso
  // CommonApiController la lleva consigo y los endpoints personalizados
  // (addController / setController) la COMPLETAN con lo que falta.
  // ---------------------------------------------------------------
  scalar: {
    enabled: true,
    title: 'API de Móviles',          // título del tag del recurso
    description: 'Gestión de móviles', // descripción del recurso
    tags: ['Mobiles'],
    // DTOs base (entrada/salida) ya vienen de `dtos`; aquí solo
    // se personaliza el resumen/descripción por acción base.
    decorators: {
      create: {
        summary: 'Crear móvil',
        description: 'Registra un nuevo móvil en el workspace actual.',
        responses: {
          201: { description: 'Móvil creado' },
          400: { description: 'Body inválido' },
        },
      },
      list: { summary: 'Listar móviles' },
    },
  },

  // ---------------------------------------------------------------
  // Personalización — clases que siguen interfaces específicas
  // (ver sección "Personalización")
  // ---------------------------------------------------------------
  setServices: MobileService,               // class implements ICustomService<T> extends CommonApiService<T>
  setController: MobileController,          // class extends CommonApiController<T>
  addController: [MobileActionsController], // class implements ICustomActionController<T>
})
```

---

## DTOs de entrada y salida

Los DTOs son esenciales para **documentar** (Scalar) y **tipar** las respuestas. Se configuran por separado:

- **`dtos.input`** — lo que el cliente envía (body y query).
- **`dtos.output`** — lo que la API devuelve (serialización y documentación).

```typescript
dtos: {
  input: {
    create: CreateMobileDto,
    update: UpdateMobileDto,
    list: ListMobileDto,
    delete: DeleteMobileDto,
    transfer: TransferMobileDto,
  },
  output: {
    create: MobileResponseDto,
    update: MobileResponseDto,
    get: MobileResponseDto,
    list: MobileListResponseDto,
  },
}
```

La librería usa `dtos.input.create` para validar el body de `POST`, y `dtos.output.get` para declarar el tipo de respuesta en Scalar y para la serialización (p. ej. ocultar campos sensibles).

---

## Permisos

### Prefijo por defecto

Todos los endpoints heredan un prefijo de permiso. Con `prefix: 'mobile'`, cada acción exige `mobile:<accion>`:

| Acción | Permiso requerido |
|--------|-------------------|
| `create` | `mobile:create` |
| `list` | `mobile:list` |
| `get` | `mobile:read` |
| `update` | `mobile:update` |
| `delete` | `mobile:delete` |
| `count` | `mobile:count` |
| `choice` | `mobile:choice` |
| `transfer` | `mobile:transfer` (mueve el recurso a otro workspace) |
| `report` | `mobile:report` |

> **`getCurrent`, `updateCurrent`, `consolidate`** no son acciones base: son **funciones personalizadas** de cada recurso. Agrégalas con `addController` o heredando de `CommonApiService`, y define su propio permiso (`mobile:current`, `mobile:consolidate`, etc.).

### Permiso personalizado por endpoint

```typescript
actions: {
  create: { permission: ['mobile:create', 'admin:mobiles'] },  // AND
  transfer: { permission: 'mobile:transfer.manual' },
}
```

Si no se configura, se completa automáticamente con `<prefix>:<accion>`.

### Resolución de permisos de la sesión

La estrategia de permisos se define **una sola vez** en el `AuthResourceApiModule` (compartida por todos los recursos):

```typescript
export interface PermissionProvider {
  getPermissions(auth: AuthResourceApiContext): Observable<string[]>;
  hasPermission(auth: AuthResourceApiContext, permission: string): Observable<boolean>;
}
```

```typescript
// auth.module.ts
AuthResourceApiModule.register({
  default: 'jwt',
  strategies: { jwt: { type: 'jwt', sessionStore: { type: 'database', repository: SessionRepositoryModule } } },
  permissionProvider: MyPermissionProvider,
});
```

> También puedes resolver permisos desde el payload de la sesión si tu estrategia ya los incluye en `auth.permissions`.

---

## Endpoints: inclusión y exclusión

`CommonApiController` registra solo los endpoints que habilites.

```typescript
// Solo estos endpoints
endpoints: { mode: 'inclusion', include: ['create', 'list', 'get', 'update', 'delete'] }

// Todos excepto estos
endpoints: { mode: 'exclusion', exclude: ['transfer', 'report'] }
```

Por defecto, si no se configura, se habilitan los CRUD estándar: `create`, `list`, `get`, `update`, `delete`, `count`, `choice`.

---

## `transfer` — mover un recurso entre workspaces

`transfer` mueve un recurso **de un workspace a otro**. Verifica que el usuario tenga acceso al workspace de origen (via `query.scope`) y al de destino, y actualiza **el campo configurado en `workspace.field`** del recurso.

```typescript
// PUT /mobiles/transfer
// Body (TransferMobileDto)
{
  "id": "64b3abc...",
  "workspaceId": "64b3def..."     // id del workspace de destino
}
```

```typescript
// resource
ResourceApiModule.register({
  ...
  workspace: { field: 'propertyId' },   // ← campo que se actualiza en el transfer
  ...
})
```

Internamente el servicio:

1. Valida el permiso `mobile:transfer`.
2. Verifica que el recurso pertenece al workspace actual del usuario (`query.scope`).
3. Comprueba que el usuario tiene acceso al workspace de destino (vía `WorkspaceResourceApiService`).
4. Actualiza el campo del workspace (**`workspace.field`**, p. ej. `propertyId` = destino) y registra el movimiento (hook `afterTransfer`).

> Si el recurso usa un campo distinto (por ejemplo `spaceId`, `projectId`), `transfer` lo actualiza igual: el nombre del campo lo decide `workspace.field`, no el nombre del body. Para personalizar validaciones usa `hooks.beforeTransfer` / `hooks.afterTransfer` o sobrescribe el método con `setServices`.

---

## Scope por query (`query.scope` / authFunction)

Cada recurso define **qué datos puede ver/editar un usuario** mediante una función de scope (`query.scope`) que recibe el `auth` (con su workspace actual) y devuelve el filtro que se inyecta en **toda operación** del recurso (list, get, update, delete, count, report, choice). Es el equivalente directo de `authFunction` del ejemplo de Posiciones:

```typescript
// position.resource.ts
ResourceApiModule.register({
  name: 'position',
  route: 'positions',
  ...
  query: {
    // authFunction: restringe los datos al ámbito del usuario
    scope: (auth, ctx) => {
      const propertyIds = (auth?.propertyIds || []).map((id) => oid(id));
      return {
        $or: [
          { mobilePropertyId: { $in: propertyIds } },
          { devicePropertyId: { $in: propertyIds } },
        ],
      };
    },

    // Filtros siempre presentes
    extraMatch: { status: { $ne: 'deleted' } },

    // Pipeline opcional que corre antes de reportes
    pipelineBeforeReport: [{ $sort: { deviceTime: -1 } }],

    // Nota: la proyección (p. ej. { processPipe: 0 }) se configura en `views`
  },
})
```

### Interfaz

```typescript
export interface QueryScope<T = any> {
  // Equivalente a authFunction: filtro del ámbito a partir del auth
  scope: (auth: AuthResourceApiContext, ctx: ActionContext) => FilterQuery<T>;

  // Filtros estáticos siempre presentes (AND)
  extraMatch?: FilterQuery<T>;

  // Pipeline previo a la agregación de reportes
  pipelineBeforeReport?: PipelineStage[];
}
```

> La **proyección de lectura** no forma parte de `query`; se declara en `views.projections` y se elige con `views.default` o `?view=`. Así evitamos solapar dos configuraciones para lo mismo.

### Orden de composición

Cada operación construye su query en este orden:

1. `query.scope(auth)` — ámbito del usuario (workspace, propiedad, organización).
2. `extraMatch` — filtros estáticos del recurso.
3. Filtros del cliente (`filters` / query params).
4. Hooks `before*`.

```typescript
// internamente (list, por ejemplo)
const authMatch = config.query.scope(auth, ctx);
const extraMatch = config.query.extraMatch ?? {};
// Convierte los query params a filtro Mongo según queryMatchDirectory
const clientFilter = this.extractFilter(ctx.query, config.filters, ctx);
const finalQuery = { $and: [authMatch, extraMatch, clientFilter] };
```

> El scope se aplica **siempre**, incluso en `get`, `update` y `delete` por id, para impedir acceder a datos fuera del ámbito del usuario.

---

## Filtrado: de HTTP GET a MongoDB (`queryMatchDirectory`)

El servicio convierte los **query params de la URL** en un filtro del repositorio (Mongo/aggregate). La configuración es un **diccionario** (`queryMatchDirectory`) donde cada clave es un query param y su valor describe cómo convertirlo.

### Interfaz

```typescript
export type TypeValueOperation =
  | 'string' | 'number' | 'date' | 'boolean' | 'id';

export interface QueryMatchConfig {
  // Operación a aplicar sobre el atributo
  operation?: 'gte' | 'gt' | 'lt' | 'lte' | 'ne' | 'eq' | 'regex';
  // Expresión personalizada (recibe el valor crudo + el contexto HTTP)
  expr?: (value: string | string[], httpData?: ActionContext) => Expression;
  // Tipo para hacer cast del valor recibido (string) al tipo real
  type?: TypeValueOperation;
  // Campo de la entidad sobre el que se filtra (soporta dot path).
  // Si no se define, usa el nombre del query param.
  attribute?: string;
  // true => error 400 si el param no viene en el query
  require?: boolean;
}
```

### Conversión de cada param

Para cada clave del query que exista en el `queryMatchDirectory`:

1. **Resuelve el atributo**: `attribute ?? clave` (admite dot path: `prev.deviceTime`).
2. **Convierte el valor** según `type`:

| `type` | Cast del valor recibido |
|--------|-------------------------|
| `string` | `String(value)` |
| `number` | `Number(value)` |
| `date` | `new Date(value)` (ISO 8601) |
| `boolean` | `parseBoolean(value)` (`true/false/1/0/yes/no/s`) |
| `id` | `ObjectId(value)` (`oid`) |

3. **Aplica la operación**:

| `operation` | Filtro generado |
|-------------|-----------------|
| `eq` | `{ [attr]: value }` |
| `ne` | `{ [attr]: { $ne: value } }` |
| `gt` | `{ [attr]: { $gt: value } }` |
| `gte` | `{ [attr]: { $gte: value } }` |
| `lt` | `{ [attr]: { $lt: value } }` |
| `lte` | `{ [attr]: { $lte: value } }` |
| `regex` | `{ [attr]: { $regex: value, $options: 'i' } }` |
| `expr` | Devuelve lo que retorne la función (se usa tal cual) |

4. Si el valor es un **array** (param repetido `?deviceId=a&deviceId=b`): para `eq`/`ne` se genera `$in`/`$nin`; para el resto, cada elemento genera su condición.

5. Todas las condiciones generadas se combinan con `$and`.

### Ejemplo real (Posiciones)

```typescript
// position.resource.ts
filters: {
  queryMatchDirectory: {
    // ?deviceTime=... filtra sobre el campo deviceTime
    startDeviceTime: { attribute: 'deviceTime', type: 'date', operation: 'gte' },
    endDeviceTime:   { attribute: 'deviceTime', type: 'date', operation: 'lt' },

    prevStartDeviceTime: { attribute: 'prev.deviceTime', type: 'date', operation: 'gte' },
    prevEndDeviceTime:   { attribute: 'prev.deviceTime', type: 'date', operation: 'lt' },

    deviceId: { operation: 'eq', type: 'id' },
    mobileId: { operation: 'eq', type: 'id' },

    // Params con expresión personalizada
    sensor: {
      expr: (value) => {
        const queries = (Array.isArray(value) ? value : [value]).map((v) => {
          const [sensorKey, valueString] = v.split('=');
          return { $eq: [{ $toString: `$${sensorKey}` }, valueString] };
        });
        return { $expr: { $or: queries } };
      },
    },

    hasMobile: {
      expr: (value) => {
        const booleans = (Array.isArray(value) ? value : [value]).map(
          (v) => /^(s|yes|true|1|y)$/gi.test(v)
        );
        return {
          $or: booleans.map((b) => ({ mobileId: { [b ? '$ne' : '$eq']: null } })),
        };
      },
    },
  },

  maxLimit: 100,
  defaultLimit: 20,

  sort: {
    default: { key: 'deviceTime', value: 'asc' },
    attributes: { deviceTime: 'deviceTime', speed: 'speed', address: 'address' },
  },
}
```

### Query param → filtro Mongo

```http
GET /positions?startDeviceTime=2026-08-01T00:00:00Z&endDeviceTime=2026-08-02T00:00:00Z&deviceId=64b3abc...&sensor=ignition=true&sensor=door=closed
```

Se convierte a:

```typescript
{
  $and: [
    { deviceTime: { $gte: ISODate('2026-08-01T00:00:00Z'), $lt: ISODate('2026-08-02T00:00:00Z') } },
    { deviceId: ObjectId('64b3abc...') },
    {
      $expr: {
        $or: [
          { $eq: [{ $toString: '$ignition' }, 'true'] },
          { $eq: [{ $toString: '$door' }, 'closed'] },
        ],
      },
    },
  ],
}
```

### Query params reservados

Estos params **nunca** entran al filtro; se extraen antes:

| Param | Uso |
|-------|-----|
| `$size`, `$page` | Paginación |
| `$sort:<campo>` | Ordenamiento (`asc`/`desc`), mapeado por `sort.attributes` |
| `$select` | Vista/proyección (`views`) |
| `$metric:<nombre>`, `$dimension:<nombre>` | Reportes |

---

## Personalización: `setServices`, `setController` y `addController`

`setServices`, `setController` y `addController` reciben **clases** (no funciones). Cada una sigue una interfaz específica y recibe sus dependencias por inyección de Nest.

| Opción | Qué recibe | Extiende la clase común |
|--------|------------|-------------------------|
| `setServices` | Clase que **implementa `ICustomService<T>`** y **extiende `CommonApiService<T>`** | ✅ (hereda la lógica y recibe inyecciones) |
| `setController` | Clase que **extiende `CommonApiController<T>`** | ✅ (hereda los endpoints y recibe el servicio) |
| `addController` | Clase que **implementa `ICustomActionController<T>`** | ❌ (solo cumple la interfaz) |

### Cómo se documenta un endpoint personalizado

`CommonApiController` ya trae la **configuración genérica de documentación** del recurso (`scalar.title`, `scalar.description`, `scalar.tags`) y los **DTOs** (`dtos.input` / `dtos.output`). Cuando agregas o sobrescribes un endpoint, solo necesitas **completar lo que falta**: `summary`, `description` y `responses`. La librería fusiona ambos:

```
Documentación final del endpoint =
  config genérica del recurso (scalar + dtos)   // la pone CommonApiController
  + metadata del endpoint (summary/description/responses)
  + DTOs del endpoint (inputDto/outputDto)        // si aplica
```

### `setServices` — servicio personalizado

El módulo instancia esta clase como servicio del recurso, inyectándole la `ResourceConfig` más tus dependencias propias.

```typescript
// mobile.service.ts
import { CommonApiService, ResourceConfig, ActionContext } from '@deorta-dev/nestjs-resource-core';

// Interfaz que debe cumplir la clase (se extiende CommonApiService para
// recibir la config + inyecciones internas por DI)
export interface ICustomService<T = any> extends CommonApiService<T> {
  restore(ctx: ActionContext): Observable<RestoreResponseDto>;
  getHistory(ctx: ActionContext): Observable<HistoryDto>;
}

@Injectable()
export class MobileService
  extends CommonApiService<Mobile>
  implements ICustomService<Mobile>
{
  constructor(
    // Inyección del módulo: la configuración del recurso
    config: ResourceConfig<Mobile>,
    // Inyecciones propias (Nest las resuelve al registrar la clase)
    private readonly deviceSrv: DeviceRepositoryService,
  ) {
    super(config);
  }

  // Sobrescribir regla de negocio (todo en Observable)
  override create(ctx: ActionContext<CreateMobileDto>): Observable<Mobile> {
    return this.deviceSrv.findOne({ _id: oid(ctx.body.deviceId) }).pipe(
      tap((device) => { if (device) ctx.body.simCardId = device.simCardId; }),
      mergeMap(() => super.create(ctx)),
    );
  }

  // Métodos nuevos reutilizando internals de la clase base
  restore(ctx: ActionContext): Observable<RestoreResponseDto> {
    return this.updateOne({ trashed: false }, ctx);
  }
}
```

```typescript
// mobile.resource.ts
ResourceApiModule.register({
  ...
  setServices: MobileService,   // clase, no función
})
```

> Extender `CommonApiService` garantiza que la clase reciba la `ResourceConfig` y los servicios internos (filtros, lookups, reportes, etc.) por DI, sin configuración manual.

### `setController` — controlador personalizado

El módulo registra esta clase como controlador del recurso. Recibe el servicio (el común o el de `setServices`) por DI.

```typescript
// mobile.controller.ts
import { CommonApiController, ResourceAction } from '@deorta-dev/nestjs-resource-core';

@Controller('mobiles')
export class MobileController extends CommonApiController<Mobile> {
  constructor(service: MobileService) {   // el servicio de setServices (o el común)
    super(service);
  }

  // Sobrescribir un endpoint base (hereda la doc de scalar.decorators.get
  // y dtos.output.get; solo se completa lo que cambie)
  @Get(':id')
  @ResourceAction({
    outputDto: MobileDetailResponseDto,
    summary: 'Obtener móvil con detalle',
  })
  override get(
    @Param() params: Record<string, string>,
    @AuthResourceApi() auth: AuthResourceApiContext,
  ) {
    return this.service.getWithDetail({ params, auth });
  }

  // Agregar endpoints propios: CommonApiController ya tiene la config
  // genérica (scalar + dtos), aquí se COMPLETA la doc del endpoint
  @Get(':id/history')
  @ResourceAction({
    permission: 'mobile:history',
    outputDto: HistoryDto,
    summary: 'Historial del móvil',
    description: 'Devuelve el historial de cambios del móvil.',
    responses: {
      200: { description: 'Historial obtenido' },
      404: { description: 'Móvil no encontrado' },
    },
  })
  history(
    @Param() params: Record<string, string>,
    @AuthResourceApi() auth: AuthResourceApiContext,
  ) {
    return this.service.getHistory({ params, auth });
  }
}
```

```typescript
ResourceApiModule.register({
  ...
  setServices: MobileService,
  setController: MobileController,
})
```

> Si `setController` sobrescribe métodos, usa `override` para que TypeScript verifique la firma contra el método base.

### `addController` — acciones adicionales

No extiende la clase común: es una clase independiente que **implementa la interfaz** `ICustomActionController<T>` y define sus endpoints con decoradores Nest. Recibe el servicio (común o personalizado) por DI.

```typescript
// mobile.actions.controller.ts
import { ICustomActionController, ResourceAction, AuthResourceApi } from '@deorta-dev/nestjs-resource-core';

@Controller('mobiles')
export class MobileActionsController implements ICustomActionController<Mobile> {
  constructor(
    public readonly service: MobileService,      // servicio común/personalizado
    private readonly auditSrv: AuditService,     // inyecciones propias
  ) {}

  @Post('restore')
  @ResourceAction({
    permission: 'mobile:restore',
    inputDto: RestoreMobileDto,
    outputDto: RestoreResponseDto,
    summary: 'Restaurar móvil',
    description: 'Re-activa un móvil que fue marcado como eliminado.',
    responses: {
      200: { description: 'Móvil restaurado' },
      404: { description: 'Móvil no encontrado' },
    },
  })
  restore(
    @Param() params: Record<string, string>,
    @Body() body: RestoreMobileDto,
    @AuthResourceApi() auth: AuthResourceApiContext,
  ) {
    return this.service.restore({ params, body, auth });
  }

  @Post('bulk/delete')
  @ResourceAction({
    permission: 'mobile:bulkDelete',
    inputDto: BulkDeleteDto,
    summary: 'Eliminación masiva',
  })
  deleteBulk(
    @Query() query: Record<string, string>,
    @AuthResourceApi() auth: AuthResourceApiContext,
  ) {
    return this.service.deleteBulk({ query, auth });
  }

  @Get('stats/:period')
  @ResourceAction({
    permission: 'mobile:stats',
    outputDto: StatsResponseDto,
    summary: 'Estadísticas por período',
  })
  stats(
    @Param() params: Record<string, string>,
    @AuthResourceApi() auth: AuthResourceApiContext,
  ) {
    return this.service.generateStats({ params, auth });
  }
}
```

```typescript
ResourceApiModule.register({
  ...
  setServices: MobileService,
  addController: [MobileActionsController],   // clase o array de clases
})
```

### Interfaz `ICustomActionController` y decorador `@ResourceAction`

```typescript
export interface ICustomActionController<T = any> {
  // El módulo inyecta el servicio del recurso (común o de setServices)
  service: CommonApiService<T>;
}

// Metadatos de la acción: permiso + DTOs + doc del endpoint + auth.
// La config genérica (scalar + dtos) ya la trae CommonApiController;
// aquí solo se COMPLETA lo que falta para la documentación y auth.
export const ResourceAction = (meta: {
  permission?: string | string[];
  public?: boolean;                  // endpoint público (sin autenticación)
  strategy?: string;                 // sobreescribe la estrategia del AuthResourceApiModule
  inputDto?: Type<any>;
  outputDto?: Type<any>;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  responses?: Record<number, { description?: string; type?: Type<any> }>;
}) => SetMetadata('resource:action', meta);
```

### Resumen de qué completa cada pieza

| Información | La pone `CommonApiController` | La completas con `@ResourceAction` |
|-------------|------------------------------|-----------------------------------|
| Título del tag / recurso | `scalar.title` | — |
| Descripción del recurso | `scalar.description` | — |
| Tags | `scalar.tags` | — |
| Resumen/descripción por acción base | `scalar.decorators.<accion>` | `summary` / `description` |
| DTO de entrada (body) | `dtos.input` | `inputDto` |
| DTO de salida (respuesta) | `dtos.output` | `outputDto` |
| Respuestas HTTP | opcionales en `scalar.decorators` | `responses` |
| Permiso | `permissions.defaults.<accion>` | `permission` |
| Endpoint público / estrategia | `AuthResourceApiModule.publicResources` | `public` / `strategy` |

Cada endpoint recibe el mismo contexto `{ params, query, body, auth }` y puede declarar su propio permiso y DTOs de entrada/salida para documentación con Scalar.

---

## Reportes dinámicos (métricas y dimensiones)

El reporte se genera con `GET /mobiles/report`, combinando **métricas** (agregaciones) y **dimensiones** (agrupaciones) vía query params:

- `?$dimension:mobileId=1` — agrupa por `mobileId`
- `?$metric:total=1&$metric:maxSpeed=1` — calcula métricas
- Soporta paginación y ordenamiento igual que `list`

```typescript
reports: {
  enabled: true,
  metricMap: {
    total: { $sum: 1 },
    workTimeHours: {
      $sum: {
        $cond: [
          { $and: [{ $eq: ['$sensors.ignition', true] }] },
          { $divide: [{ $subtract: ['$deviceTime', { $ifNull: ['$prev.deviceTime', '$deviceTime'] }] }, 3600000] },
          0,
        ],
      },
    },
    maxSpeed: { $max: '$speed' },
    lastDeviceTime: { $max: '$deviceTime' },
    firstDeviceTime: { $min: '$deviceTime' },
  },
  dimensionMap: {
    mobile: {
      expr: '$mobileId',
      replaceLookup: { ormService: mobileSrv, foreignerKey: '_id', exprLabel: '$name' },
    },
    status: { expr: '$status' },
  },
  pipelineBeforeReport: [{ $sort: { deviceTime: -1 } }],
  sort: {
    default: { key: 'deviceTime', value: 'asc' },
    attributes: { deviceTime: 'deviceTime', speed: 'speed' },
  },
}
```

### Tipo de las expresiones

Como la librería es agnóstica al almacenamiento, las expresiones de `metricMap` y `dimensionMap` son **opacas**: se pasan tal cual al método `aggregate()` de tu repositorio (Mongo/Mongoose, SQL JSON, etc.). La librería solo estandariza el **contrato de query** (`$metric:`, `$dimension:`, paginación, sort) y la construcción del pipeline.

```typescript
export interface MetricMap {
  [key: string]: unknown | ((ctx: ActionContext) => unknown);
}

export interface DimensionMap {
  [key: string]: {
    expr: unknown;
    replaceLookup?: {
      ormService: RepositoryService<any>;
      foreignerKey: string;
      exprLabel: unknown;
    };
  };
}
```

---

## Gateway de tiempo real (Socket.IO) — `CommonGateway`

Cada recurso puede exponer un namespace de sockets para emitir **cambios de elementos y de listas filtradas** en tiempo real. Se construye sobre una clase base **`CommonGateway<T>`** (equivalente a `CommonApiService`, pero para sockets) que maneja: autenticación, scope/workspace, suscripción por filtros y emisión.

Es la adaptación (mejorada) de `SpecialBaseGateway`: **Observable-first**, autenticación vía `AuthResourceApiService` + `SessionStore`, filtros reutilizando `queryMatchDirectory` y scope vía `query.scope`.

### Configuración

```typescript
gateway: {
  enabled: true,
  namespace: '/mobiles',
  events: {
    element: 'mobile:element',
    list: 'mobile:list',
    subscribed: 'mobile:subscribed',
  },
  emitOn: ['create', 'update', 'delete', 'transfer'],
  filters: ['status', 'type', 'propertyId'],
  auth: { tokenQuery: 'token' },   // estrategia resuelta por AuthResourceApiModule
  setGateway: MobileGateway,       // opcional: clase que extiende CommonGateway
}
```

### `CommonGateway<T>` (base)

```typescript
import {
  Server, Socket,
  OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit,
} from '@nestjs/websockets';
import { from, mergeMap, filter, Observable } from 'rxjs';
import {
  CommonGateway, AuthResourceApiContext, FilterQuery,
  compileMatcher, extractFilter,
} from '@deorta-dev/nestjs-resource-core';

// Estado por socket: auth + matcher de suscripción compilado
interface SocketData<T> {
  socket: Socket;
  auth: AuthResourceApiContext;
  workspaceValue?: string;   // valor del campo configurado en workspace.field
  emitValidateFn: (element: T) => boolean;   // filtro + scope compilados
}
```

### `setGateway` — gateway personalizado (hereda la base)

Como `CommonApiService`, la personalización es por **clase** que extiende `CommonGateway`. Recibe la `ResourceConfig`, el `AuthResourceApiService` y el `WorkspaceResourceApiService` por DI, y puede inyectar sus propias dependencias.

```typescript
// mobile.gateway.ts
import { CommonGateway, ResourceConfig, AuthResourceApiService } from '@deorta-dev/nestjs-resource-core';

@WebSocketGateway({ namespace: '/mobiles' })
export class MobileGateway extends CommonGateway<Mobile> {
  constructor(
    config: ResourceConfig<Mobile>,
    authService: AuthResourceApiService,
    private readonly deviceSrv: DeviceRepositoryService,   // inyecciones propias
  ) {
    super(config, authService);
  }

  // Sobrescribir la emisión para enriquecer el elemento antes de enviarlo
  protected emitElement(element: Mobile): void {
    this.deviceSrv.findOne({ _id: oid(element.deviceId) }).pipe(
      map((device) => ({ ...element, deviceName: device?.name })),
    ).subscribe((enriched) => super.emitElement(enriched));
  }

  // Eventos propios (p. ej. emitir a un cliente específico)
  emitToUser(userId: string, event: string, payload: any): void {
    this.socketsByUser(userId).forEach((socket) => socket.emit(event, payload));
  }
}
```

```typescript
ResourceApiModule.register({
  ...
  gateway: {
    enabled: true,
    namespace: '/mobiles',
    setGateway: MobileGateway,
  },
})
```

### Flujo

1. El cliente se conecta a `io('/mobiles?token=...')`.
2. `CommonGateway.handleConnection` toma el token del handshake y llama a `AuthResourceApiService.getAuthentication(token)` (Observable). Si la sesión es válida, registra el socket; si no, lo desconecta.
3. El cliente suscribe listas: `socket.emit('subscribe', { status: 'active' })`. El gateway convierte la suscripción con `queryMatchDirectory` + `query.scope` (como en HTTP) y compila un matcher.
4. Ante un `create/update/delete/transfer` (config `emitOn`), el servicio llama `gateway.emitElement(element)`:
   - Valida el **scope** (`query.scope`) y el **filtro de suscripción** del socket contra el elemento.
   - Si coincide → emite `mobile:element`.
   - Si cambia una lista (filtro de listado) → emite `mobile:list` a los sockets cuya suscripción incluye ese elemento.

```typescript
const socket = io('/mobiles', { query: { token } });
socket.on('mobile:element', (element) => console.log('cambio', element));
socket.on('mobile:subscribed', () => console.log('suscrito'));
socket.emit('subscribe', { status: 'active' });
```

### Cómo emite el servicio

`CommonApiService` emite automáticamente tras cada operación de `emitOn`:

```typescript
// internamente en CommonApiService
create(ctx): Observable<T> {
  return this.repository.create(body).pipe(
    tap((entity) => this.gateway?.emitElement(entity)),   // emisión
  );
}
```

El gateway decide a **qué sockets** llega según su `emitValidateFn` (auth + workspace + suscripción). Si no hay gateway configurado, `this.gateway` es `undefined` y no se emite nada.

### Interfaz pública de `CommonGateway`

```typescript
export abstract class CommonGateway<T = any>
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  protected socketDataMap = new Map<string, SocketData<T>>();
  // Indexado por el valor de workspace.field del recurso (configurable)
  protected workspaceMap: Record<string, Map<string, SocketData<T>>> = {};

  // Emitir un elemento a los sockets cuyo matcher coincide
  protected emitElement(element: T): void;

  // Emitir a un socket específico
  emitTo(socketId: string, event: string, payload: any): void;

  // Conexión/autenticación (interno): auth vía AuthResourceApiService
  handleConnection(client: Socket): void;
  handleDisconnect(client: Socket): void;
  afterInit(server: Server): void;

  // Suscripción por filtros (queryMatchDirectory + query.scope)
  subscribe(client: Socket, payload: Record<string, string | string[]>): Observable<void>;
  unsubscribe(client: Socket): Observable<void>;
}
```

> **Mejoras sobre `SpecialBaseGateway`:** todo en `Observable` (auth y suscripciones con rxjs), auth delegada a `AuthResourceApiService`/`SessionStore` (sin depender de un `AuthManager` concreto), filtros y scope reutilizando exactamente `queryMatchDirectory` + `query.scope` del recurso, soporte de workspace por socket y `setGateway` para personalización por herencia.

---

## Bridge de tiempo real (consumir un server socket externo)

Cuando el **procesamiento vive en otro microservicio** (p. ej. el **normalizador**, que recibe tramas GPS y publica posiciones/dispositivos/eventos **como Traccar**), `api-public` (con `resource-core`) debe **escuchar ese server socket** y emitir en los recursos relacionados (`positions`, `devices`, `mobiles`, `events`, `currentMobiles`, ...). Ese adaptador es el **`RealtimeBridge`**.

```
 normalizador (server socket, estilo Traccar)
      │  emite: position / device / event / alert
      ▼
 api-public (nestjs-resource-core)
      RealtimeBridge (socket.io-client + rxjs)
        ├─ 1. conecta al server socket (handshake server-to-server)
        ├─ 2. enruta cada evento → config `realtime` del recurso
        ├─ 3. (opcional) persiste en el repositorio del recurso
        └─ 4. gateway.emitElement(entity) → CommonGateway
                → filtra scope (workspace.field) + suscripción por cliente
                → emite a los sockets del frontend
```

### Config global del bridge

```typescript
// app.module.ts — api-public
RealtimeBridgeModule.forRoot({
  url: process.env.NORMALIZER_WS_URL,          // server socket del normalizador
  auth: { token: process.env.NORMALIZER_TOKEN }, // credencial server-to-server
  events: ['position', 'device', 'event', 'alert'],   // canales que consume
})
```

### Config `realtime` por recurso

Cada recurso declara **qué evento del server socket consume** y cómo convertir el payload a su entidad:

```typescript
ResourceApiModule.register({
  name: 'currentMobile',
  route: 'current-mobiles',
  ...
  realtime: {
    enabled: true,
    event: 'position',                    // evento del server socket que consume
    transform: (msg) => toCurrentMobile(msg),  // payload normalizador → entidad
    persist: false,                       // false: el normalizador ya escribió en BD
    emit: true,                           // emite vía el gateway del recurso
  },
})
```

### `persist: true` — el bridge escribe

Para recursos que el normalizador **no** persiste (p. ej. actualizar `mobile.cached.states` cuando llega un `device`):

```typescript
ResourceApiModule.register({
  name: 'mobile',
  route: 'mobiles',
  ...
  realtime: {
    enabled: true,
    event: 'device',
    transform: (msg) => ({ deviceId: msg.deviceId, cached: { states: msg.states } }),
    persist: true,     // update en el repo del recurso (server-to-server, sin auth de usuario)
    emit: true,        // luego gateway.emitElement(entidad actualizada)
  },
})
```

### `GatewayRegistry` — emitir desde cualquier lugar

El bridge necesita emitir en el gateway de **cualquier** recurso sin depender de la clase concreta. La librería expone un registro `{ nombre del recurso → CommonGateway }`:

```typescript
// realtime-bridge.service.ts — api-public (o utilidad de la librería)
@Injectable()
export class RealtimeBridge {
  constructor(
    private readonly gateways: GatewayRegistry,       // name → CommonGateway
    private readonly config: RealtimeBridgeConfig,
  ) {}

  onModuleInit(): void {
    this.connect();   // socket.io-client envuelto en rxjs (fromEvent)
  }

  private connect(): void {
    const socket = io(this.config.url, {
      auth: { token: this.config.auth.token },
    });
    this.config.events.forEach((event) =>
      fromEvent(socket, event)
        .pipe(
          filter(() => this.config.enabled),
          mergeMap((msg) => this.dispatch(event, msg)),
        )
        .subscribe(),
    );
  }

  private dispatch(event: string, msg: any): Observable<void> {
    // enruta por evento → todos los recursos con realtime.event === event
    return this.config.routes[event].pipe(
      mergeMap((route) => this.applyRoute(route, msg)),
    );
  }

  private applyRoute(route: RealtimeRoute, msg: any): Observable<void> {
    const gateway = this.gateways.get(route.resource);
    const entity = route.transform(msg);
    const persist = route.persist
      ? this.gateways.repo(route.resource).upsert(entity)   // server-to-server
      : of(entity);
    return persist.pipe(
      tap((final) => { if (route.emit) gateway.emitElement(final); }),
      map(() => undefined),
    );
  }
}
```

### Emisión de eventos y alertas (normalizador → api-public)

| Evento del server socket | Recurso | Acción del bridge |
|---|---|---|
| `position` | `currentMobile` | `emit` `position` al mapa (scope por property) |
| `position` | `position` | `persist` (si el normalizador no escribe) + `emit` |
| `device` | `device` | `persist` `status`/`lastCommunication` + `emit` `device:element` |
| `mobile` | `mobile` | `persist` `cached.states`/`currentStatus` + `emit` `mobile:element` |
| `event` / `alert` | `event` | `persist` + `emit` `event` |
| `alarm` | `mobile` | `persist` `mobile.alarms[]` + `emit` `mobile:element` |

> La **emisión siempre respeta el scope del recurso** (`workspace.field`, p. ej. `propertyId`) y la **suscripción por filtros** de cada cliente: el bridge alimenta el gateway, y `CommonGateway` decide a qué sockets llega. El bridge es **server-to-server** (no hay usuario); el scope de los *clientes finales* lo aplica el gateway al emitir.

> Para múltiples normalizadores o protocolos, registra varias rutas por evento o un `transform` por origen. Si el normalizador **no** usa Socket.IO (p. ej. `ws` puro o TCP), solo cambia la capa de conexión del bridge; `dispatch`/`realtime` no cambian.

---

## Workspaces

La librería soporta **entidades de workspace configurables** (Propietario/Cliente/Vendedor, Espacio, Proyecto, etc.) o **funcionar sin workspace**.

La **estrategia de workspace vive en el `AuthResourceApiModule`** (es parte de la sesión y es compartida por todos los recursos). Cada recurso decide cómo traducir ese workspace a un filtro de query mediante `query.scope` (equivalent a `authFunction`).

### Sin workspace

Omite `workspace` en el `AuthResourceApiModule`. El scope se aplica por recurso con `query.scope` o con `hooks`.

### Con workspace

Configuras un `provider` en el `AuthResourceApiModule` que implementa la interfaz. El `AuthResourceApiModule` expone automáticamente las acciones de workspace:

```typescript
export interface Workspace {
  id: string;
  name: string;
  type?: string;
  metadata?: Record<string, any>;
}

export interface WorkspaceProvider {
  getCurrent(auth: AuthResourceApiContext): Observable<Workspace | null>;
  list(auth: AuthResourceApiContext): Observable<Workspace[]>;
  select(auth: AuthResourceApiContext, workspaceId: string): Observable<Workspace>;
}
```

```typescript
// auth.module.ts
AuthResourceApiModule.register({
  default: 'jwt',
  strategies: { jwt: { type: 'jwt', sessionStore: { type: 'database', repository: SessionRepositoryModule } } },

  workspace: {
    enabled: true,
    provider: PropertyWorkspaceProvider,
    routes: {
      current: 'workspace/current',  // GET -> workspace actual de la sesión
      select: 'workspace/select',    // PUT { id } -> seleccionar workspace
      list: 'workspace/list',        // GET -> workspaces a los que tiene acceso
    },
  },
})
```

El workspace seleccionado queda **dentro del `AuthResourceApiContext`** (`auth.workspace`). Cada recurso declara **qué campo de su entidad** identifica el workspace (`workspace.field`) y lo usa en `query.scope` para filtrar:

```typescript
// mobile.resource.ts — el campo del workspace es 'propertyId'
ResourceApiModule.register({
  ...
  workspace: { field: 'propertyId' },   // configurable: propertyId | spaceId | projectId | ...
  query: {
    // auth.workspace es el workspace actual de la sesión (definido en AuthResourceApiModule)
    scope: (auth, ctx) => {
      const workspaceId = auth.workspace?.id;
      // filtra por el campo configurado en workspace.field (aquí: propertyId)
      return workspaceId ? { propertyId: oid(workspaceId) } : {};
    },
  },
})

// space.resource.ts — otro workspace, otro campo de entidad
ResourceApiModule.register({
  ...
  workspace: { field: 'spaceId' },
  query: {
    scope: (auth, ctx) =>
      auth.workspace ? { spaceId: oid(auth.workspace.id) } : {},
  },
})

// position.resource.ts — sin workspace simple: varios campos, mismo provider
ResourceApiModule.register({
  ...
  workspace: { field: 'mobilePropertyId' },
  query: {
    scope: (auth, ctx) => {
      const propertyIds = (auth?.propertyIds || []).map((id) => oid(id));
      return {
        $or: [
          { mobilePropertyId: { $in: propertyIds } },
          { devicePropertyId: { $in: propertyIds } },
        ],
      };
    },
    // La proyección va en `views`, no aquí
    views: { default: 'base', projections: { base: { processPipe: 0 } } },
  },
})
```

> `workspace.field` no impone el filtro automáticamente: es la declaración del campo para que `transfer` sepa qué columna actualizar y el gateway indexe por ese valor. El filtrado efectivo lo decides en `query.scope`.

### Jerarquía de workspaces: sub-workspaces / sub-properties

El `WorkspaceProvider` solo **lee/selecciona** el workspace actual. **Crear workspaces (y sub-workspaces) es una operación de recurso**: modelas `properties` como recurso y cada sub-property es un `POST /properties` cuyo `propertyId` es el **padre**.

```typescript
// POST /properties  → crea un sub-workspace
{
  "name": "Cliente ACME",
  "type": "client",
  "propertyId": "64b3abc...",   // padre (null para la raíz 'main')
  "features": ["vehicle.create", "vehicle.update"],   // ⊆ features del padre
  "timezone": "America/Bogota"
}
```

#### Árbol con materialized path

Para que el scope vea **todo el subárbol** (workspace + descendientes) de forma O(1) sin resolver hijos recursivamente, cada `Property` guarda su ruta materializada:

| Campo | Ejemplo | Descripción |
|---|---|---|
| `propertyId` | `oid(raiz)` | Padre directo |
| `path` | `/main/acme/central` | Ruta completa de ancestros (índice con `text` o regex) |

```typescript
ResourceApiModule.register({
  name: 'property',
  route: 'properties',
  entity: Property,

  actions: {
    list: { permission: 'property.view' },
    get: { permission: 'property.view' },
    create: { permission: 'property.create' },
    update: { permission: 'property.update' },
  },

  query: {
    // scope con jerarquía: el workspace del usuario y TODOS sus descendientes
    scope: (auth) => {
      if (auth.allAccess) return {};
      const roots = ids(auth.propertyIds).map(escapeRegex);   // workspaces del usuario
      return {
        $or: [
          { _id: { $in: ids(auth.propertyIds) } },
          { path: { $regex: `^(${roots.join('|')})/` } },     // descendientes
        ],
      };
    },
  },

  hooks: {
    // Crear un sub-workspace valida que el PADRE esté en tu scope y que lo
    // que asignas (features/roles) NO exceda lo del padre.
    beforeCreate: ({ body, auth }) =>
      assertParentInScope(auth, body.propertyId).pipe(       // padre accesible
        switchMap((parent) => assertChildWithinParent(parent, body)),  // features ⊆ padre
      ),
  },
})
```

Con `path` en cada recurso multi-tenant el scope de **cualquier** recurso ve el subárbol completo:

```typescript
// mobile.resource.ts — vehículos del workspace y sus sub-workspaces
scope: (auth) => {
  if (auth.allAccess) return {};
  const roots = ids(auth.propertyIds).map(escapeRegex);
  // join con la colección properties por propertyId → path del dueño
  return { path: { $regex: `^(${roots.join('|')})/` } };
}
```

#### Herencia de permisos: el hijo máximo tiene los permisos del padre

La regla "un sub-workspace **como máximo puede tener los permisos del padre**" se aplica en dos frentes:

1. **Al crear/asignar** (`beforeCreate`/`beforeUpdate` de `properties` o `joints`): validas que lo que le otorgas al hijo esté contenido en lo que tú tienes sobre el padre. Así un `client` no puede crear un sub-workspace con `invoice.create` si el padre no lo tiene.

```typescript
// helper del proyecto
function assertChildWithinParent(parent, child): Observable<Property> {
  const overflow = (child.features ?? []).filter((f) => !parent.features.includes(f));
  if (overflow.length) {
    throw new BadRequestException(
      `Features fuera del alcance del padre: ${overflow.join(', ')}`,
    );
  }
  return of(parent);
}
```

2. **Al resolver permisos** (`PermissionProvider`): el permiso efectivo de un usuario en el workspace es el **intersección de la cadena de ancestros** (su asignación en ese workspace ∩ el permiso de cada ancestro). `auth.workspace.path` te da la cadena.

```typescript
// joint-permission.provider.ts (fragmento)
getPermissions(auth: AuthResourceApiContext): Observable<string[]> {
  // permisos asignados al usuario en el workspace actual (joint + profile)
  return this.assignedInWorkspace(auth.userId, auth.workspace.id).pipe(
    switchMap((assigned) => this.clampByAncestors(auth.workspace.path, assigned)),
  );
}

// recorre la cadena de ancestros y deja solo los permisos que TODOS tienen
private clampByAncestors(path: string, assigned: string[]): Observable<string[]> {
  return this.properties.find({ path: { $regex: `^${escapeRegex(path)}` } }).pipe(
    map((ancestors) => assigned.filter((p) => ancestors.every((a) => a.features.includes(p) || a.permissions?.includes(p)))),
  );
}
```

> Con esto: el **property `main`** es la raíz (sin `propertyId`), los operadores centrales usan `joints { allAccess: true }` del `main`, y cada sub-workspace se crea desde el recurso `properties` con validación de alcance. La creación de workspaces es solo **otro CRUD** con su scope + hooks; el `WorkspaceProvider` sigue siendo solo de lectura/selección.

### Ejemplo de implementación del provider

```typescript
@Injectable()
export class PropertyWorkspaceProvider implements WorkspaceProvider {
  constructor(
    @RepositoryInject(PropertyRepositoryModule)
    private properties: IBaseRepositoryService<Property>,
  ) {}

  getCurrent(auth: AuthResourceApiContext): Observable<Workspace | null> {
    if (!auth?.property) return of(null);
    return of({ id: auth.property._id, name: auth.property.name });
  }

  list(auth: AuthResourceApiContext): Observable<Workspace[]> {
    return this.properties.find({ _id: { $in: auth.propertyIds.map(oid) } }).pipe(
      map((properties) => properties.map((p) => ({ id: p._id, name: p.name }))),
    );
  }

  select(auth: AuthResourceApiContext, workspaceId: string): Observable<Workspace> {
    return this.properties.findOne({ _id: oid(workspaceId) }).pipe(
      // persiste el workspace seleccionado en la sesión (vía SessionStore)
      map((property) => ({ id: property._id, name: property.name })),
    );
  }
}
```

> El filtrado de datos por workspace **no es automático**: lo define cada recurso en `query.scope`. El recurso declara su campo en `workspace.field` (p. ej. `propertyId`, `spaceId`, `projectId`) y `query.scope` decide cómo combinarlo con el `auth.workspace` y otros criterios del auth.

---

## Documentación con Scalar

La librería genera la referencia de API con **Scalar** (`@scalar/nestjs-api-reference`).

```typescript
// resource
scalar: {
  enabled: true,
  title: 'API de Móviles',
  description: 'Gestión de móviles',
  tags: ['Mobiles'],
  decorators: {
    create: { summary: 'Crear móvil' },
    list: { summary: 'Listar móviles' },
  },
}
```

En el `AppModule` raíz se sirve la referencia:

```typescript
import { ScalarModule } from '@deorta-dev/nestjs-resource-core';

@Module({
  imports: [ScalarModule.forRoot({ title: 'Mi API', version: '1.0.0' })],
})
export class AppModule {}
```

---

## Integración con `@deorta-dev/nestjs-repository-core`

La capa de datos se delega completamente. `ResourceApiModule` necesita tener acceso al módulo de base de datos y al servicio/repositorio para inyectarlo en `CommonApiService`.

### Cómo enlazar el repositorio en la configuración

Para vincular el repositorio de `@deorta-dev/nestjs-repository-core`, utilizas las propiedades `repositoryModule` y `repositoryService` en la configuración del recurso.

**Opción 1: Usando el token de inyección directo (Recomendado)**
Si la librería de repositorios exporta el servicio con un token (por ejemplo, el mismo módulo o una constante), se lo pasas directamente a `repositoryService`. La librería internamente usa `useExisting` para hacer el alias.

```typescript
// mobile.resource.ts
import { ResourceApiModule } from '@deorta-dev/nestjs-resource-core';
import { MobileRepositoryModule } from './repositories/mobile.repository.module';

export const MobileResourceApiModule = ResourceApiModule.register({
  name: 'mobile',
  route: 'mobiles',
  entity: MobileEntity,
  
  // 1. Importas el módulo que provee la conexión a la base de datos para este recurso
  repositoryModule: MobileRepositoryModule, 
  
  // 2. Le indicas a la librería con qué token (clase o string) se inyecta el repositorio.
  // Si usabas @RepositoryInject(MobileRepositoryModule), entonces el token es el módulo:
  repositoryService: MobileRepositoryModule, 
});
```

**Opción 2: Usando un servicio Wrapper**
Si prefieres envolver la lógica del repositorio en una clase propia de tu proyecto para adaptar los métodos u observables, creas una clase `@Injectable()` y la pasas:

```typescript
// mobile.repository.service.ts
@Injectable()
export class MobileRepositoryService implements IBaseRepositoryService<MobileEntity> {
  constructor(
    // Inyectas la dependencia de tu librería externa
    @RepositoryInject(MobileRepositoryModule) private readonly repo: IBaseRepositoryService<MobileEntity>
  ) {}

  find(filters) { return this.repo.find(filters); }
  create(data) { return this.repo.create(data); }
  // ...
}
```

```typescript
// mobile.resource.ts
export const MobileResourceApiModule = ResourceApiModule.register({
  name: 'mobile',
  route: 'mobiles',
  entity: MobileEntity,
  
  repositoryModule: MobileRepositoryModule,
  repositoryService: MobileRepositoryService, // Pasas tu clase Wrapper
});
```

### Contrato del Repositorio

El repositorio (sea inyectado directo o por wrapper) debe exponer (al menos) los métodos que el servicio CRUD usa, **todos en Observable** (`IBaseRepositoryService`):

```typescript
export interface IBaseRepositoryService<T> {
  create(data: Partial<T>): Observable<T>;
  find(filters?: any, options?: any): Observable<T[]>;
  findOne(filters: any, options?: any): Observable<T | null>;
  update(id: string | any, data: Partial<T>): Observable<T>;
  delete(id: string | any): Observable<void>;
  count(filters?: any): Observable<number>;
  aggregate?(pipeline: any[]): Observable<any[]>;
  upsert?(query: any, data: any): Observable<T>;
}
```

> Si tu repositorio subyacente devuelve `Promise`, envuélvelo con `from()` en un adaptador (Opción 2). La librería **nunca** convierte sus internals a Promise; solo usa `Observable`.

---

## Resumen de endpoints generados

| Endpoint | Método | Permiso default | DTO entrada | DTO salida |
|----------|--------|-----------------|-------------|------------|
| `/mobiles` | `POST` | `mobile:create` | `CreateMobileDto` | `MobileResponseDto` |
| `/mobiles` | `GET` | `mobile:list` | `ListMobileDto` | `MobileListResponseDto` |
| `/mobiles/count` | `GET` | `mobile:count` | `ListMobileDto` | `CountResponseDto` |
| `/mobiles/choice` | `GET` | `mobile:choice` | — | `ChoiceResponseDto` |
| `/mobiles/:id` | `GET` | `mobile:read` | — | `MobileResponseDto` |
| `/mobiles/:id` | `PUT` | `mobile:update` | `UpdateMobileDto` | `MobileResponseDto` |
| `/mobiles/:id` | `DELETE` | `mobile:delete` | `DeleteMobileDto` | — |
| `/mobiles/transfer` | `PUT` | `mobile:transfer` | `TransferMobileDto` | `TransferResponseDto` |
| `/mobiles/report` | `GET` | `mobile:report` | `ReportQueryDto` | `ReportResponseDto` |
| `/workspace/current` | `GET` | — | — | `WorkspaceDto` |
| `/workspace/list` | `GET` | — | — | `WorkspaceListDto` |
| `/workspace/select` | `PUT` | — | `SelectWorkspaceDto` | `WorkspaceDto` |

> `GET /mobiles/choice` soporta inversión con `?invert=true` (ya no existe `/choice/invert`). `getCurrent`, `updateCurrent` y `consolidate` se registran como funciones personalizadas vía `addController` o herencia.

---

## Roadmap

- [ ] Fase 1: Core — `ResourceApiModule`, `AuthResourceApiModule`, interfaces, DI tokens, decoradores.
- [ ] Fase 2: Núcleo reactivo — todos los servicios e interfaces en `Observable` (rxjs), `from()` como puente en fronteras externas.
- [ ] Fase 2: `CommonApiController` / `CommonApiService` con habilitación por inclusión/exclusión.
- [ ] Fase 3: `AuthResourceApiModule` multi-estrategia (jwt, api-key, oauth, custom) + `AuthResourceApiService`.
- [ ] Fase 3b: Resolución de estrategia por request — `resolver`, `default`, `publicResources` y `@ResourceAction({ public | strategy })`.
- [ ] Fase 4: Sesiones — `SessionStore` + `DatabaseSessionStore` (persistencia en BD) + store de memoria para desarrollo.
- [ ] Fase 5: Scope por query — `query.scope` (authFunction) + `extraMatch` + proyección.
- [ ] Fase 6: DTOs de entrada/salida + validación.
- [ ] Fase 7: Permisos con prefijo + overrides + `PermissionProvider`.
- [ ] Fase 8: Filtros, búsqueda, paginación y ordenamiento.
- [ ] Fase 9: Reportes dinámicos (métricas/dimensiones).
- [ ] Fase 10: Choices y vistas proyectadas.
- [ ] Fase 11: Gateway de tiempo real — `CommonGateway` (auth + scope + suscripción por filtros + `setGateway`).
- [ ] Fase 12: `RealtimeBridge` + `GatewayRegistry` — consumir un server socket externo (normalizador) y emitir en los recursos (`realtime`).
- [ ] Fase 13: Workspaces en `AuthResourceApiModule` (provider + acciones de sesión).
- [ ] Fase 14: Personalización `setController` / `setServices` / `addController`.
- [ ] Fase 15: Documentación con Scalar.
- [ ] Fase 16: Cache, hooks y eventos.
- [ ] Fase 17: Testing, ADR y documentación técnica de arquitectura.
- [ ] Fase 18: Publicación y guía de migración.

---

## Contribución

¿Encontraste un bug o quieres proponer una mejora? Abre un issue o PR en el repositorio.

## Licencia

MIT