# Ejemplo de implementación — Módulo Control con `@deorta-dev/nestjs-resource-core`

> Documento de referencia que mapea la arquitectura objetivo del Módulo Control (GPS/rastreo) sobre `@deorta-dev/nestjs-resource-core`. El propósito es validar la **viabilidad** de la librería tal como está documentada y mostrar los patrones concretos de configuración.

---

## 1. Mapeo dominio → librería

| Dominio (Control) | Pieza de la librería |
|---|---|
| `properties` (cliente/propietario) | **Workspace** (`WorkspaceProvider`) + recurso admin |
| `users` + `joints` | Usuarios del proyecto + `PermissionProvider` (multi-tenant vía joints) |
| `profiles` + `permissions` | Roles → permisos (`PermissionProvider`) |
| `sessions` (+ `currentPropertyId`) | `SessionStore` externo (Mongo) + workspace en el payload |
| `devices`, `mobiles`, `geofences`, `fleets`, `contacts`, `drivers`, `documents`, `simcards`, `templateMessages` | `ResourceApiModule.register(...)` con `workspace.field: 'propertyId'` |
| `currentMobiles` (mapa en vivo) | `CommonGateway` (Socket.IO) por recurso |
| Posiciones / consolidados | Recurso read-only + `reports` (`metricMap`/`dimensionMap`) |
| Scoping de usuarios (`moviles_usuarios`) | `query.scope` con `auth.propertyIds` (desde joints) |
| `alarmas`, `maintenances`, `geofences` embebidos | Campos embebidos del entity + `views.projections` |
| `tipo de vehículo`, `protocolo`, `operador`, `listener` | `choices` |
| Invitación de usuarios a un property | Patrón `Invitation` + `addController` público |

Regla de oro del dominio: **todo lo que no es usuario ni config pertenece a un `Property`**. Esa regla se traduce directamente en `workspace.field: 'propertyId'` en todos los recursos multi-tenant.

### Helpers compartidos (utils del proyecto)

```typescript
// control/shared/scope.ts — usados en todos los recursos
const ids = (xs?: string[]) => (xs ?? []).map((x) => oid(x));
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// auth.allAccess (operador central / property main) => ve todo; si no,
// solo los properties donde tiene joint (auth.propertyIds del payload).
const propertyScope = (auth) =>
  auth.allAccess
    ? {}
    : { propertyId: { $in: ids(auth.propertyIds) } };

const toBool = (v: string) => /^(s|yes|true|1|y)$/i.test(v);

// Jerarquía: workspace del usuario + TODOS sus sub-workspaces (materialized path)
const subtreeScope = (auth) => {
  if (auth.allAccess) return {};
  const roots = ids(auth.propertyIds).map(escapeRegex);
  return { path: { $regex: `^(${roots.join('|')})/` } };
};

// Crear un sub-workspace: el padre debe estar en tu scope.
// Factory: recibe el repo de properties (los hooks de config son funciones
// puras; si necesitas DI construye la config en una factory del proyecto).
const assertParentInScope = (properties: IBaseRepositoryService<Property>) => (auth, parentId) =>
  parentId
    ? properties.findOne({ _id: oid(parentId), ...subtreeScope(auth) })
    : of(null);

// El hijo como máximo puede tener lo del padre (features/roles ⊆ padre)
const assertChildWithinParent = (parent, child) => {
  const overflow = (child.features ?? []).filter((f) => !parent.features?.includes(f));
  if (overflow.length) {
    throw new BadRequestException(`Features fuera del alcance del padre: ${overflow.join(', ')}`);
  }
  return of(parent);
};
```

> `auth.propertyIds` y `auth.allAccess` se cargan en el payload de la sesión en el login (§2.4) desde los `joints` del usuario.

---

## 2. Auth: usuarios, joints y Property como workspace

### 2.1 `AuthResourceApiModule`

```typescript
// auth/core/auth.module.ts
import { AuthResourceApiModule } from '@deorta-dev/nestjs-resource-core';
import { SessionRepositoryModule } from '../session/session.repository.module';
import { JointPermissionProvider } from './permissions/joint-permission.provider';
import { PropertyWorkspaceProvider } from './workspace/property-workspace.provider';

AuthResourceApiModule.register({
  default: 'jwt',

  resolver: (request) => {
    // token en header Bearer o en cookie web
    if (request.headers.authorization?.startsWith('Bearer ')) return 'jwt';
    if (request.cookies?.token) return 'jwt';
    return null;
  },

  // SIN registro abierto: solo login y aceptar invitación son públicos
  publicResources: [
    { route: 'POST /auth/login' },
    { route: 'POST /invitations/accept' },
  ],

  strategies: {
    jwt: {
      type: 'jwt',
      secret: process.env.JWT_SECRET,
      expiresIn: '12h',
      issuer: 'megarastreo-api',
      // Sesiones persistidas en BD (colección `sessions`): no se pierden
      // al reiniciar el servicio. Limpieza de expiradas por cron.
      sessionStore: { type: 'database', repository: SessionRepositoryModule, ttl: 12 * 3600 },
    },
  },

  // permisos compartidos: se resuelven desde joints + profiles
  permissionProvider: JointPermissionProvider,

  // Property = workspace. `WorkspaceResourceApiService` expone
  // current/select/list sobre la sesión.
  workspace: {
    enabled: true,
    provider: PropertyWorkspaceProvider,
    routes: {
      current: 'property/current',
      select: 'property/select',
      list: 'property/list',
    },
  },
})
```

### 2.2 `JointPermissionProvider` — roles (`profiles`) → permisos

```typescript
// auth/permissions/joint-permission.provider.ts
@Injectable()
export class JointPermissionProvider implements PermissionProvider {
  constructor(
    @RepositoryInject(JointRepositoryModule) private joints: IBaseRepositoryService<Joint>,
    @RepositoryInject(ProfileRepositoryModule) private profiles: IBaseRepositoryService<Profile>,
  ) {}

  // allAccess => ['*']; si no, union de joint.permissions + profile.permissions,
  // CLAMPADA por la cadena de ancestros (un sub-workspace nunca excede al padre).
  getPermissions(auth: AuthResourceApiContext): Observable<string[]> {
    if (auth.allAccess) return of(['*']);
    const userId = oid(auth.userId);
    const propertyId = oid(auth.workspace?.id);   // property activo de la sesión
    return this.joints.findOne({ userId, propertyId }).pipe(
      switchMap((joint) =>
        joint?.profileId
          ? this.profiles.findOne({ _id: joint.profileId })
          : of(null),
      ),
      switchMap(([joint, profile]) => {
        const assigned = [
          ...(joint?.permissions ?? []),
          ...(profile?.permissions ?? []),
        ];
        // el workspace actual NO es la raíz → recorta a lo que la cadena permite
        if (auth.workspace?.path) return this.clampByAncestors(auth.workspace.path, assigned);
        return of(assigned);
      }),
    );
  }

  // deja solo los permisos que TODOS los ancestros permiten (features/permissions)
  private clampByAncestors(path: string, assigned: string[]): Observable<string[]> {
    return this.properties.find({ path: { $regex: `^${escapeRegex(path)}` } }).pipe(
      map((ancestors) =>
        assigned.filter((p) =>
          ancestors.every((a) =>
            a.features?.includes(p) || a.permissions?.includes(p) || p === '*',
          ),
        ),
      ),
    );
  }

  hasPermission(auth, permission): Observable<boolean> {
    return this.getPermissions(auth).pipe(
      map((perms) => perms.includes('*') || perms.includes(permission)),
    );
  }
}
```

### 2.3 `PropertyWorkspaceProvider` — el workspace es un `Property`

```typescript
// auth/workspace/property-workspace.provider.ts
@Injectable()
export class PropertyWorkspaceProvider implements WorkspaceProvider {
  constructor(
    @RepositoryInject(PropertyRepositoryModule) private properties: IBaseRepositoryService<Property>,
    @RepositoryInject(JointRepositoryModule) private joints: IBaseRepositoryService<Joint>,
  ) {}

  // El payload de la sesión guarda propertyIds del usuario (sus joints)
  getCurrent(auth: AuthResourceApiContext): Observable<Workspace | null> {
    const id = auth.payload?.currentPropertyId;
    return id ? this.properties.findOne({ _id: oid(id) }) : of(null);
  }

  list(auth: AuthResourceApiContext): Observable<Workspace[]> {
    const ids = (auth.payload?.propertyIds ?? []).map(oid);
    return this.properties.find({ _id: { $in: ids } }).pipe(
      map((props) => props.map((p) => ({ id: p._id, name: p.name }))),
    );
  }

  select(auth: AuthResourceApiContext, workspaceId: string): Observable<Workspace> {
    // valida que el usuario tenga joint sobre ese property y lo persiste
    // en la sesión como currentPropertyId (vía AuthResourceApiService)
    return this.joints.findOne({ userId: oid(auth.userId), propertyId: oid(workspaceId) }).pipe(
      switchMap((joint) =>
        joint
          ? this.properties.findOne({ _id: oid(workspaceId) })
          : throwError(() => new ForbiddenException('Sin acceso al property')),
      ),
    );
  }
}
```

### 2.4 Login (custom, público)

```typescript
// auth/auth.controller.ts — del proyecto
@Controller('auth')
export class AuthController {
  constructor(
    private readonly users: UserRepositoryService,
    private readonly joints: JointRepositoryService,
    private readonly authSrv: AuthResourceApiService,
  ) {}

  @Post('login')
  @ResourceAction({ public: true })
  login(@Body() dto: LoginDto): Observable<{ token: string }> {
    return this.users.findOne({ username: dto.username }).pipe(
      switchMap((user) => {
        if (!user || !verifyPassword(dto.password, user.hash)) {
          throw new UnauthorizedException('Credenciales inválidas');
        }
        // Resuelve los joints del usuario: propertyIds + allAccess + roles
        return this.joints.find({ userId: oid(user._id) }).pipe(
          switchMap((joints) =>
            this.authSrv.createSession({
              userId: user._id,
              ttl: 12 * 3600,
              payload: {
                roles: user.roles,
                propertyIds: joints.map((j) => j.propertyId),
                allAccess: joints.some((j) => j.allAccess),
              },
            }),
          ),
        );
      }),
    );
  }
}
```

> El `auth.propertyIds` del payload alimenta `query.scope` de todos los recursos (multi-tenant por joints) y `auth.allAccess` lo usa el scope para devolver `{}`.

### 2.5 API keys permanentes (integradores sin login)

Para sistemas externos que consumen la API **sin sesión** (reportes, apps de terceros, normalizador cliente), se usa la estrategia `api-key` **stateless**: la key es una credencial permanente por property, con revocación instantánea.

```typescript
// auth.module.ts — resolver incluye apiKey
resolver: (request) => {
  if (request.headers['x-api-key']) return 'apiKey';
  if (request.headers.authorization?.startsWith('Bearer ')) return 'jwt';
  return null;
},

strategies: {
  jwt: { type: 'jwt', secret: process.env.JWT_SECRET, sessionStore: { type: 'database', repository: SessionRepositoryModule } },
  apiKey: { type: 'api-key', header: 'x-api-key', provider: ApiKeyProvider },   // sin sessionStore → permanente
},
```

```typescript
// control/api-key/api-key.resource.ts — emisión de keys por property
ResourceApiModule.register({
  name: 'apiKey', route: 'api-keys', entity: ApiKey,
  workspace: { field: 'propertyId', required: true },
  actions: {
    list: { permission: 'apiKey.view' },
    get: { permission: 'apiKey.view' },
    create: { permission: 'apiKey.create' },
    delete: { permission: 'apiKey.create' },   // revocar (efecto inmediato)
  },
  endpoints: { include: ['create', 'list', 'get', 'delete'] },
  query: { scope: subtreeScope },             // workspace + sub-workspaces
  setServices: ApiKeyService,                 // genera la key, guarda SOLO el hash
})
```

```typescript
// auth/strategies/api-key.provider.ts — valida por hash, construye el contexto
@Injectable()
export class ApiKeyProvider implements AuthResourceApiStrategyProvider<ApiKeyPayload> {
  readonly type = 'api-key';
  constructor(private readonly apiKeys: IBaseRepositoryService<ApiKey>) {}

  authenticate(key: string): Observable<AuthResourceApiContext<ApiKeyPayload>> {
    return this.apiKeys.findOne({ keyHash: sha256(key) }).pipe(
      switchMap((apiKey) => {
        if (!apiKey || (apiKey.expiresAt && apiKey.expiresAt < new Date())) {
          throw new UnauthorizedException('API key inválida o expirada');
        }
        return of({
          token: apiKey.keyHash,                       // no es una sesión
          userId: apiKey.userId,
          workspace: { id: apiKey.propertyId, name: apiKey.propertyName },
          payload: { scopes: apiKey.permissions, propertyIds: [apiKey.propertyId] },
        } as AuthResourceApiContext<ApiKeyPayload>);
      }),
    );
  }
}
```

> La key se devuelve en claro **una sola vez** en el `POST` (la guarda `ApiKeyService` como `keyHash`). `expiresAt: null` = permanente; `DELETE` revoca al instante porque no hay sesión que invalidar. El scope (`subtreeScope`) aplica igual: la key solo ve su property y sub-workspaces.

---

## 3. Usuarios, joints y properties (recursos admin)

### 3.1 `properties` — recurso admin + workspace

```typescript
// control/property/property.resource.ts
import { PropertyRepositoryModule } from './property.repository.module';

ResourceApiModule.register({
  name: 'property',
  route: 'properties',
  entity: Property,

  // Integración con @deorta-dev/nestjs-repository-core
  repositoryModule: PropertyRepositoryModule,
  repositoryService: PropertyRepositoryModule, // El token suele ser el mismo módulo

  // Permisos del catálogo (UserPermissionKey), no prefijo por defecto
  permissions: { prefix: 'property' },
  actions: {
    list: { permission: 'property.view' },
    get: { permission: 'property.view' },
    create: { permission: 'property.create' },
    update: { permission: 'property.update' },
    delete: { permission: 'property.delete' },
  },
  endpoints: { include: ['list', 'get', 'create', 'update'] },   // sin delete público

  query: {
    // Jerarquía por `path` (materialized path): el workspace del usuario y
    // TODOS sus descendientes (sub-workspaces). Con `path` el scope es O(1).
    scope: (auth) => {
      if (auth.allAccess) return {};   // central: ve la jerarquía completa
      const roots = ids(auth.propertyIds).map(escapeRegex);
      return {
        $or: [
          { _id: { $in: ids(auth.propertyIds) } },
          { path: { $regex: `^(${roots.join('|')})/` } },   // sub-workspaces
        ],
      };
    },
  },

  hooks: {
    // Crear un sub-workspace: el padre debe estar en tu scope y lo que le
    // asignas (features/roles) NO puede exceder lo del padre. Los hooks son
    // funciones de config; construye la config en una factory si necesitas
    // inyectar el repo de properties (assertParentInScope(propertiesRepo)).
    beforeCreate: ({ body, auth }) =>
      assertParentInScope(propertiesRepo)(auth, body.propertyId).pipe(
        switchMap((parent) => assertChildWithinParent(parent, body)),  // features ⊆ padre
      ),
  },

  filters: {
    queryMatchDirectory: {
      name: { operation: 'regex', type: 'string' },
      type: { operation: 'eq', type: 'string' },
      propertyId: { operation: 'eq', type: 'id' },   // hijos de un padre
    },
  },
  choices: { enabled: true, fields: ['type'] },
  views: {
    default: 'summary',
    projections: {
      summary: ['id', 'name', 'type', 'disable', 'timezone'],
      detail: ['*'],
    },
  },
})
```

### 3.2 `users` y `joints` — admin multi-tenant

```typescript
// control/user/user.resource.ts — solo administradores centrales
ResourceApiModule.register({
  name: 'user',
  route: 'users',
  entity: User,
  permissions: { prefix: 'user' },
  actions: {
    list: { permission: 'user.view' },
    get: { permission: 'user.view' },
    create: { permission: 'user.create' },
    update: { permission: 'user.update' },
    delete: { permission: 'user.delete' },
  },
  endpoints: { include: ['list', 'get', 'create', 'update'] },
  // NOTA: `hash`/`salt` excluidos de serialización en el entity
})

// control/joint/joint.resource.ts — vínculo usuario ↔ property
ResourceApiModule.register({
  name: 'joint',
  route: 'joints',
  entity: Joint,
  permissions: { prefix: 'user' },
  actions: {
    list: { permission: 'user.view' },
    get: { permission: 'user.view' },
    create: { permission: 'user.manage' },   // asignar property/roles a un usuario
    update: { permission: 'user.manage' },
    delete: { permission: 'user.manage' },
  },
  query: {
    scope: (auth) => (auth.allAccess ? {} : { propertyId: { $in: ids(auth.propertyIds) } }),
  },
})
```

> `Joint` es el corazón del multi-tenancy: `{ userId, propertyId, owner, allAccess, permissions[], profileId }`. El `PermissionProvider` y el `WorkspaceProvider` leen de aquí. Los ids hardcodeados `[1, 13, 2405, ...]` del sistema actual desaparecen: los operadores centrales son `joints { allAccess: true }` del property `main`.

---

## 4. `devices` — hardware GPS

```typescript
// control/device/device.resource.ts
import { DeviceRepositoryModule } from './device.repository.module';

ResourceApiModule.register({
  name: 'device',
  route: 'devices',
  entity: Device,
  repositoryModule: DeviceRepositoryModule,
  repositoryService: DeviceRepositoryModule,
  workspace: { field: 'propertyId' },   // puede ser null en inventario

  permissions: { prefix: 'device' },
  actions: {
    list: { permission: 'device.view' },
    get: { permission: 'device.view' },
    create: { permission: 'device.create' },
    update: { permission: 'device.update' },
    delete: { permission: 'device.delete' },
  },

  query: {
    scope: propertyScope,                       // { propertyId: { $in: propertyIds } } | {}
    extraMatch: { status: { $ne: 'trashed' } },
  },

  filters: {
    queryMatchDirectory: {
      name: { operation: 'regex', type: 'string' },
      uniqueId: { operation: 'eq', type: 'string' },
      status: { operation: 'eq', type: 'string' },
      channelId: { operation: 'eq', type: 'id' },
      propertyId: { operation: 'eq', type: 'id' },
      originList: { operation: 'in', type: 'string' },
      hasDeviceTime: {
        expr: (v) => (['yes','true'].includes(v) ? { lastCommunication: { $ne: null } } : { lastCommunication: null }),
      },
    },
  },

  choices: {
    enabled: true,
    fields: ['status', 'protocol'],              // DeviceStatusEnum, ProtocolEnum
  },

  views: {
    default: 'summary',
    projections: {
      summary: ['id', 'uniqueId', 'name', 'status', 'propertyId'],
      detail: ['*'],
    },
  },

  // Sincronización híbrida Traccar: crear/actualizar → espejo en listener
  hooks: {
    afterCreate: ({ entity }) => syncTraccarDevice(entity),
    afterUpdate: ({ entity }) => syncTraccarDevice(entity),
  },

  // Opcional: reasignar un dispositivo de un property a otro
  // (usando el endpoint transfer de la librería)
  // transfer: { permission: 'device.update' },
})
```

> `uniqueId` (IMEI) es índice único de la colección; la librería no valida unicidad — eso queda en tu repositorio. El **cache** (`mobileNested`, `cached`) se refresca desde eventos de escritura de `mobile` (hooks) y se proyecta con `views`.

---

## 5. `mobiles` — vehículos (fusión `vehiculos` + `moviles`)

```typescript
// control/mobile/mobile.resource.ts
import { MobileRepositoryModule } from './mobile.repository.module';

ResourceApiModule.register({
  name: 'mobile',
  route: 'mobiles',
  entity: Mobile,
  repositoryModule: MobileRepositoryModule,
  repositoryService: MobileRepositoryModule,
  workspace: { field: 'propertyId', required: true },

  permissions: { prefix: 'mobile' },
  actions: {
    list: { permission: 'mobile.view' },           // hoy: moviles_usuarios
    get: { permission: 'mobile.view' },
    create: { permission: 'vehicle.create' },
    update: { permission: 'vehicle.update' },
    delete: { permission: 'vehicle.delete' },
    transfer: { permission: 'vehicle.update' },     // mover a otro property
  },

  query: {
    scope: propertyScope,
    extraMatch: { trashed: { $ne: true } },
  },

  filters: {
    queryMatchDirectory: {
      name: { operation: 'regex', type: 'string' },
      plate: { operation: 'regex', type: 'string' },
      deviceId: { operation: 'eq', type: 'id' },
      fleetId: { operation: 'eq', type: 'id' },
      propertyId: { operation: 'eq', type: 'id' },
      businessId: { operation: 'eq', type: 'id' },
      type: { operation: 'eq', type: 'string' },
      isOnline: {
        expr: (v) => ({ 'cached.states.isOnline': toBool(v) }),
      },
      hasAlarm: {
        expr: (v) => (toBool(v) ? { 'alarms': { $ne: [] } } : { alarms: [] }),
      },
    },
  },

  choices: {
    enabled: true,
    fields: ['type', 'model', 'emission'],          // vehicleType desde config
  },

  reports: {
    enabled: true,
    route: 'report',
    metricMap: {
      total: { $sum: 1 },
      online: { $sum: { $cond: [{ $eq: ['$cached.states.isOnline', true] }, 1, 0] } },
    },
    dimensionMap: {
      type: { expr: '$type' },
      propertyId: {
        expr: '$propertyId',
        replaceLookup: { ormService: propertySrv, foreignerKey: '_id', exprLabel: '$name' },
      },
    },
  },

  views: {
    default: 'base',
    available: ['base', 'summary', 'detail'],
    projections: {
      base: { cached: 0, trashed: 0 },               // quita cache pesada
      summary: ['id', 'plate', 'name', 'propertyId', 'deviceNested', 'currentStatus'],
      detail: ['*'],
    },
  },

  // Emisión de cambios en tiempo real a los sockets del mapa
  gateway: {
    enabled: true,
    namespace: '/mobiles',
    events: { element: 'mobile:element', list: 'mobile:list', subscribed: 'mobile:subscribed' },
    emitOn: ['create', 'update', 'delete', 'transfer'],
    filters: ['propertyId', 'status'],
    auth: { tokenQuery: 'token' },
  },

  setServices: MobileService,   // lógica custom: instalación de device, cache, alarmas
})
```

### 5.1 `MobileService` — reglas de negocio (instalación + cache)

```typescript
// control/mobile/mobile.service.ts
@Injectable()
export class MobileService extends CommonApiService<Mobile> {
  constructor(
    config: ResourceConfig<Mobile>,
    private readonly devices: IBaseRepositoryService<Device>,
  ) {
    super(config);
  }

  // Al crear/actualizar: sincroniza device.mobileNested y mobile.deviceNested
  protected override onAfterCreate(ctx: ActionContext, entity: Mobile): Observable<void> {
    return this.devices.update(entity.deviceId, {
      mobileNested: { _id: entity._id, name: entity.plate },
      propertyId: entity.propertyId,                    // el dispositivo sigue al vehículo
    }).pipe(map(() => undefined));
  }
}
```

> Las **alarmas** (`mobile.alarms[]`), mantenimientos (`maintenances[]`) y geocercas (`geofences[]`) son **embebidos** del entity: la librería los trata como campos normales y `views` controla cuánto se proyecta. El scoping de usuarios (`moviles_usuarios`) desaparece: lo reemplaza `query.scope` + permisos (`mobile.view` + lista vía joints).

---

## 6. `currentMobiles` — mapa en tiempo real (`CommonGateway`)

`currentMobiles` lo **escribe el normalizer** (procesadores `process-*.ts`), no la API. El recurso es read-only y su gateway es la fuente del mapa.

```typescript
// control/current-mobile/current-mobile.resource.ts
import { CurrentMobileRepositoryModule } from './current-mobile.repository.module';

ResourceApiModule.register({
  name: 'currentMobile',
  route: 'current-mobiles',
  entity: CurrentMobile,
  repositoryModule: CurrentMobileRepositoryModule,
  repositoryService: CurrentMobileRepositoryModule,

  // Solo lectura + reporte
  endpoints: { include: ['list', 'get', 'count', 'report'] },

  permissions: { prefix: 'position' },
  actions: {
    list: { permission: 'position.view' },
    get: { permission: 'position.view' },
    report: { permission: 'position.history' },
  },

  query: {
    // propertyId embebido en currentMobile (scope por property)
    scope: (auth) => (auth.allAccess ? {} : { propertyId: { $in: ids(auth.propertyIds) } }),
  },

  filters: {
    queryMatchDirectory: {
      mobileId: { operation: 'eq', type: 'id' },
      deviceId: { operation: 'eq', type: 'id' },
      deviceTime: { operation: 'eq', type: 'date' },
      minSpeed: { attribute: 'speed', operation: 'gte', type: 'number' },
    },
  },

  reports: {
    enabled: true,
    route: 'report',
    metricMap: {
      count: { $sum: 1 },
      maxSpeed: { $max: '$speed' },
      lastDeviceTime: { $max: '$deviceTime' },
    },
    dimensionMap: {
      mobileId: { expr: '$mobileId' },
      mobileName: { expr: '$mobileId', replaceLookup: { ormService: mobileSrv, foreignerKey: '_id', exprLabel: '$name' } },
    },
    pipelineBeforeReport: [{ $sort: { deviceTime: -1 } }],
    sort: { default: { key: 'deviceTime', value: 'desc' }, attributes: { deviceTime: 'deviceTime', speed: 'speed' } },
  },

  gateway: {
    enabled: true,
    namespace: '/map',
    events: { element: 'position', list: 'map', subscribed: 'map:subscribed' },
    emitOn: ['update', 'create'],
    filters: ['propertyId', 'deviceId', 'mobileId'],
    auth: { tokenQuery: 'token' },
    setGateway: MapGateway,
  },
})
```

### 6.1 `MapGateway` — enriquece la posición antes de emitir

```typescript
// control/current-mobile/map.gateway.ts
@WebSocketGateway({ namespace: '/map' })
export class MapGateway extends CommonGateway<CurrentMobile> {
  constructor(
    config: ResourceConfig<CurrentMobile>,
    authService: AuthResourceApiService,
    private readonly mobiles: IBaseRepositoryService<Mobile>,
  ) {
    super(config, authService);
  }

  protected override emitElement(current: CurrentMobile): void {
    // cache del vehículo: plate y nombre para el mapa
    this.mobiles.findOne({ _id: oid(current.mobileId) }).pipe(
      map((mobile) => ({
        ...current,
        plate: mobile?.plate,
        icon: mobile?.icon,
      })),
    ).subscribe((payload) => super.emitElement(payload));
  }
}
```

### 6.2 El normalizer emite posiciones

```typescript
// apps/normalizer/position.processor.ts
@Injectable()
export class PositionProcessor {
  constructor(
    // el gateway del recurso está registrado como provider del ResourceApiModule
    private readonly mapGateway: MapGateway,
    private readonly currentMobiles: IBaseRepositoryService<CurrentMobile>,
  ) {}

  process(message: PositionMessage): Observable<void> {
    return this.currentMobiles.upsertByDevice(message).pipe(
      tap((current) => this.mapGateway.emitElement(current)),   // → evento 'position'
      map(() => undefined),
    );
  }
}
```

> El cliente se conecta a `io('/map?token=...')` y recibe `position` solo para los vehículos de sus properties (`filters.propertyId` + scope). Es el reemplazo de `api-proposal/current-mobile`.

### 6.3 Consumir el server socket del normalizador (bridge)

El normalizador vive en **otro microservicio** y **emite por un server socket** (estilo Traccar): posiciones, dispositivos, eventos y alarmas. `api-public` (con resource-core) escucha ese socket con un **`RealtimeBridge`** y alimenta los gateways de los recursos relacionados (`currentMobile`, `position`, `device`, `mobile`, `event`).

```typescript
// api-public/app.module.ts — global del bridge
RealtimeBridgeModule.forRoot({
  url: process.env.NORMALIZER_WS_URL,          // server socket del normalizador
  auth: { token: process.env.NORMALIZER_TOKEN },  // handshake server-to-server
  events: ['position', 'device', 'mobile', 'event', 'alarm'],
})
```

Cada recurso declara su consumo:

```typescript
// currentMobile — el normalizador ya persiste en BD: solo emitir al mapa
realtime: {
  enabled: true,
  event: 'position',
  transform: (msg) => toCurrentMobile(msg),   // payload → CurrentMobile
  persist: false,                             // ya está en BD
  emit: true,                                 // → gateway /map → 'position'
}

// device — actualiza estado online y emite
realtime: {
  enabled: true,
  event: 'device',
  transform: (msg) => ({
    _id: msg.deviceId,
    status: msg.status,
    lastCommunication: new Date(msg.deviceTime),
    lastChangeToOnline: msg.status === 'online' ? new Date(msg.deviceTime) : undefined,
  }),
  persist: true,    // update en devices (el normalizador no escribe este campo)
  emit: true,       // → gateway /devices → 'device:element'
}

// mobile — refresca el cache operativo (estado del vehículo)
realtime: {
  enabled: true,
  event: 'mobile',
  transform: (msg) => ({
    _id: msg.mobileId,
    cached: { states: msg.states },            // ignition, motor, isOnline, ...
    currentStatus: msg.states.currentStatus,
  }),
  persist: true,
  emit: true,       // → gateway /mobiles → 'mobile:element'
}

// event — alertas: persiste y emite
realtime: {
  enabled: true,
  event: 'event',
  transform: (msg) => toEventEntity(msg),
  persist: true,
  emit: true,       // → gateway /events → 'event'
}
```

El bridge enruta por evento usando el `GatewayRegistry` de la librería:

```typescript
// api-public/realtime/realtime-bridge.service.ts
@Injectable()
export class RealtimeBridge {
  constructor(
    private readonly gateways: GatewayRegistry,     // name → CommonGateway
    private readonly config: RealtimeBridgeConfig,
  ) {}

  onModuleInit(): void {
    const socket = io(this.config.url, { auth: { token: this.config.auth.token } });
    this.config.events.forEach((event) =>
      fromEvent(socket, event)
        .pipe(mergeMap((msg) => this.dispatch(event, msg)))
        .subscribe(),
    );
  }

  private dispatch(event: string, msg: any): Observable<void> {
    return this.config.routes[event].pipe(
      mergeMap((route) => {
        const gateway = this.gateways.get(route.resource);
        const entity = route.transform(msg);
        const persist = route.persist
          ? this.gateways.repo(route.resource).upsert(entity)   // server-to-server
          : of(entity);
        return persist.pipe(
          tap((final) => { if (route.emit) gateway.emitElement(final); }),
          map(() => undefined),
        );
      }),
    );
  }
}
```

> **Escalado:** el normalizador puede emitir por **canal por property** (`event: 'position:{propertyId}'`). El bridge se suscribe a los canales en un broadcast y `CommonGateway` filtra igual por scope; o cada `api-public` replica se suscribe solo a los properties que sirve (sharding por property).

---

## 7. `positions` (historial) — recurso read-only + reportes

```typescript
// control/position/position.resource.ts
import { PositionRepositoryModule } from './position.repository.module';

ResourceApiModule.register({
  name: 'position',
  route: 'positions',
  entity: Position,
  repositoryModule: PositionRepositoryModule,
  repositoryService: PositionRepositoryModule,

  endpoints: { include: ['list', 'get', 'count', 'report'] },

  permissions: { prefix: 'position' },
  actions: {
    list: { permission: 'position.history' },
    get: { permission: 'position.history' },
    report: { permission: 'position.report' },
  },

  query: {
    scope: propertyScope,   // propertyId en cada posición (serie temporal)
  },

  filters: {
    queryMatchDirectory: {
      deviceTime: { operation: 'gte', type: 'date' },
      endDeviceTime: { attribute: 'deviceTime', operation: 'lt', type: 'date' },
      mobileId: { operation: 'eq', type: 'id' },
      minSpeed: { attribute: 'speed', operation: 'gte', type: 'number' },
    },
  },

  reports: {
    enabled: true,
    route: 'report',
    metricMap: {
      total: { $sum: 1 },
      distance: { $sum: '$distance' },
      maxSpeed: { $max: '$speed' },
      avgSpeed: { $avg: '$speed' },
      firstDeviceTime: { $min: '$deviceTime' },
      lastDeviceTime: { $max: '$deviceTime' },
    },
    dimensionMap: {
      mobileId: { expr: '$mobileId' },
      day: { expr: { $dateToString: { format: '%Y-%m-%d', date: '$deviceTime' } } },
      mobileName: { expr: '$mobileId', replaceLookup: { ormService: mobileSrv, foreignerKey: '_id', exprLabel: '$name' } },
    },
    pipelineBeforeReport: [{ $sort: { deviceTime: 1 } }],
  },
})
```

> `GET /positions?deviceTime[$gte]=2026-01-01&mobileId=...&$metric:total=count&$dimension:day` devuelve el consolidado diario. El payload de `aggregate()` es opaco para la librería (lo pasa tal cual a tu repositorio Mongo).

---

## 8. Recursos secundarios (resumen)

Todos siguen el mismo patrón: `workspace.field: 'propertyId'`, scope por property, permisos del catálogo, filtros y views.

```typescript
// geofences — geometría GeoJSON (índice 2dsphere en el repositorio)
ResourceApiModule.register({
  name: 'geofence', route: 'geofences', entity: Geofence,
  workspace: { field: 'propertyId' },
  actions: {
    list: { permission: 'geofence.view' },
    get: { permission: 'geofence.view' },
    create: { permission: 'geofence.create' },
    update: { permission: 'geofence.update' },
    delete: { permission: 'geofence.delete' },
  },
  query: { scope: propertyScope },
  filters: {
    queryMatchDirectory: {
      name: { operation: 'regex', type: 'string' },
      type: { operation: 'eq', type: 'string' },
    },
  },
  hooks: {
    // asignar/desasignar de mobile.geofences[] y device.geofenceIds
    afterCreate: ({ entity }) => assignGeofence(entity),
    afterUpdate: ({ entity }) => assignGeofence(entity),
    afterDelete: ({ entity }) => unassignGeofence(entity),
  },
})

// fleets — grupo de vehículos
ResourceApiModule.register({
  name: 'fleet', route: 'fleets', entity: Fleet,
  workspace: { field: 'propertyId', required: true },
  actions: {
    list: { permission: 'fleet.view' },
    get: { permission: 'fleet.view' },
    create: { permission: 'fleet.create' },
    update: { permission: 'fleet.update' },
    delete: { permission: 'fleet.delete' },
  },
  query: { scope: propertyScope },
  filters: {
    queryMatchDirectory: { name: { operation: 'regex', type: 'string' } },
  },
})

// contacts — contactos de notificación (heredan ContactPerson)
ResourceApiModule.register({
  name: 'contact', route: 'contacts', entity: Contact,
  workspace: { field: 'propertyId', required: true },
  actions: {
    list: { permission: 'contact.view' },
    get: { permission: 'contact.view' },
    create: { permission: 'contact.create' },
    update: { permission: 'contact.update' },
    delete: { permission: 'contact.delete' },
  },
  query: { scope: propertyScope },
  filters: {
    queryMatchDirectory: {
      email: { operation: 'regex', type: 'string' },
      phone: { operation: 'eq', type: 'string' },
      verified: { operation: 'eq', type: 'string' },
    },
  },
})

// drivers — conductores (extienden ContactPerson)
ResourceApiModule.register({
  name: 'driver', route: 'drivers', entity: Driver,
  workspace: { field: 'propertyId', required: true },
  actions: {
    list: { permission: 'driver.view' },
    get: { permission: 'driver.view' },
    create: { permission: 'driver.create' },
    update: { permission: 'driver.update' },
    delete: { permission: 'driver.delete' },
  },
  query: { scope: propertyScope },
  choices: { enabled: true, fields: ['active'] },
})

// documents — documentación del vehículo (documents[] embebido)
ResourceApiModule.register({
  name: 'document', route: 'documents', entity: Document,
  workspace: { field: 'propertyId', required: true },
  actions: {
    list: { permission: 'document.view' },
    get: { permission: 'document.view' },
    update: { permission: 'document.update' },
  },
  query: { scope: propertyScope },
  filters: {
    queryMatchDirectory: { mobileId: { operation: 'eq', type: 'id' } },
  },
})

// simcards
ResourceApiModule.register({
  name: 'simcard', route: 'simcards', entity: Simcard,
  workspace: { field: 'propertyId' },
  actions: {
    list: { permission: 'simcard.view' },
    get: { permission: 'simcard.view' },
    create: { permission: 'simcard.create' },
    update: { permission: 'simcard.update' },
    delete: { permission: 'simcard.delete' },
  },
  query: { scope: propertyScope },
  choices: { enabled: true, fields: ['operator'] },
})

// templateMessages — plantillas por canal (sms/email/whatsapp)
ResourceApiModule.register({
  name: 'templateMessage', route: 'template-messages', entity: TemplateMessage,
  workspace: { field: 'propertyId', required: true },
  actions: {
    list: { permission: 'notification.template.view' },
    get: { permission: 'notification.template.view' },
    create: { permission: 'notification.template.create' },
    update: { permission: 'notification.template.update' },
    delete: { permission: 'notification.template.delete' },
  },
  query: { scope: propertyScope },
  choices: { enabled: true, fields: ['type', 'notificationName'] },
})
```

---

## 9. Invitaciones a un property

Sin registro abierto: un administrador del property invita por email; el alta del usuario ocurre al aceptar.

```typescript
// control/invitation/invitation.resource.ts
ResourceApiModule.register({
  name: 'invitation',
  route: 'invitations',
  entity: Invitation,
  workspace: { field: 'propertyId', required: true },

  permissions: { prefix: 'user' },
  actions: {
    create: { permission: 'user.manage' },     // invitar (admin del property)
    list: { permission: 'user.view' },
    get: { permission: 'user.view' },
    update: { permission: 'user.manage' },     // revocar / reasignar roles
    delete: { permission: 'user.manage' },
  },
  endpoints: { include: ['create', 'list', 'get', 'update', 'delete'] },

  hooks: {
    afterCreate: ({ entity }) => sendInviteEmail(entity),   // link con el token
  },

  addController: InvitationAcceptController,   // POST /invitations/accept (público)
})

// control/invitation/invitation-accept.controller.ts
@Controller('invitations')
export class InvitationAcceptController implements ICustomActionController<Invitation> {
  constructor(
    private readonly invitations: IBaseRepositoryService<Invitation>,
    private readonly users: IBaseRepositoryService<User>,
    private readonly joints: IBaseRepositoryService<Joint>,
  ) {}

  @Post('accept')
  @ResourceAction({ public: true })            // sin auth: el token ES la credencial
  accept(@Body() dto: { token: string }): Observable<User> {
    return this.invitations.findOne({ token: dto.token }).pipe(
      switchMap((inv) => {
        if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) {
          throw new BadRequestException('Invitación inválida o expirada');
        }
        // usuario (si no existe) + joint { userId, propertyId, roles → profileId }
        return createUserIfMissing(this.users, inv.email).pipe(
          switchMap((user) =>
            this.joints.create({
              userId: user._id,
              propertyId: inv.propertyId,
              profileId: inv.profileId,
            }),
          ),
          switchMap(() =>
            this.invitations.update(inv.id, { status: 'accepted' }).pipe(map(() => user)),
          ),
        );
      }),
    );
  }
}
```

> Al aceptar se crea el `Joint`; el usuario ya aparece en `WorkspaceProvider.list` y puede `select` el property. Los roles de la invitación se materializan como `profileId` del joint.

---

## 10. Evaluación de viabilidad

### ✅ Cubierto por la librería tal como está

| Necesidad del Control | Soporte |
|---|---|
| CRUD por recurso con endpoints por inclusión/exclusión | `endpoints.include/exclude` |
| Multi-tenancy por `propertyId` configurable | `workspace.field` + `query.scope` |
| Sub-workspaces / jerarquía de properties | recurso `properties` + scope por `path` + clamp de permisos en `PermissionProvider` |
| `allAccess` (operadores centrales) | scope devuelve `{}` + permiso `*` |
| Roles → permisos (profiles + permissions) | `PermissionProvider` externo |
| Login/registro/invitaciones custom | `publicResources` + `addController` + `@ResourceAction({ public: true })` |
| API keys permanentes (integradores sin login) | estrategia `api-key` stateless (`sessionStore` opcional) + recurso `apiKeys` |
| Sesiones en Mongo/Redis | `SessionStore` externo (interfaz) |
| Mapas en tiempo real (`currentMobiles`) | `CommonGateway` + `setGateway` + inyección desde el normalizer |
| Reportes por métricas/dimensiones | `reports.metricMap/dimensionMap/pipelineBeforeReport/sort` |
| Choices (vehicleType, protocol, operator…) | `choices.fields` |
| Vistas proyectadas (caches embebidos) | `views.projections` (listas o expresiones) |
| Embebidos (alarmas, maintenances, geofences) | Campos normales del entity |
| Sync híbrida Traccar / cache | `hooks` + `setServices` |
| Reasignar recurso entre properties | `transfer` |
| Historial de posiciones read-only | `endpoints.include` (sin create) + `reports` |

### ⚠️ Puntos a resolver en implementación (no bloquean)

1. **Unicidad de `plate` / `uniqueId` / `number`**: la librería no valida índices únicos; hay que capturar el error de tu repositorio en `hooks.beforeCreate`/`setServices` y traducirlo a `409 Conflict`.
2. **`JointPermissionProvider` necesita el joint del property activo** (un usuario puede tener N joints; los permisos se evalúan contra el workspace actual). El `PermissionProvider` recibe `auth.workspace?.id` — ya contemplado en §2.2.
3. **`auth.propertyIds` en el payload** se fija en login; si cambian los joints en caliente hay que refrescar la sesión (o resolverlos siempre en el scope — cuestión de rendimiento).
4. **El normalizer escribe `currentMobiles` fuera de la API**: el `CommonGateway` queda registrado como provider del `ResourceApiModule`, así que el normalizer lo inyecta y llama `emitElement` (mostrado en §6.2).
5. **`profiles` / `permissions` como catálogo** no necesitan endpoint propio; pueden ser recursos internos (sin `route` expuesta) o catálogo de config.

### ✍️ Ajustes menores sugeridos a la librería

- **`choices` con origen externo**: hoy `fields` toma los valores de los datos del recurso. Para `vehicleType`, `operator`, `protocol` (catálogos de 01-config) sería útil un `choices.fields[i].source: 'config'` con `type` (`vehicleType`, `listener`, `protocol`, `operator`, `notificationName`).
- **`PermissionProvider` multi-joint**: un helper que reciba el workspace activo para resolver permisos por joint del property actual (patrón ya usado en §2.2, pero la librería podría tipar el `auth.workspace` para comodidad).
- **`sessionStore` opcional en estrategias**: ya ajustado en la interfaz — `sessionStore?` permite estrategias **stateless** (API keys permanentes). Con `sessionStore` ausente no se crea sesión.
- **Error de unicidad**: helper `catchDuplicate(repoError)` en hooks para mapear `E11000` → `409`.

---

## 11. Preguntas abiertas del documento — respuesta a la luz de la librería

1. **¿`imei` en `mobile` (cache) o resolver vía `device.uniqueId`?** → Con la librería, cache en `mobile.deviceNested`/`cached` y resolver con `views.projections`. Se proyecta `{ uniqueId: '$deviceNested.uniqueId' }`-style vía `replaceLookup` en `views`/`reports` cuando haga falta; sin joins forzados.
2. **¿`drivers` reemplaza a `contacts` o coexisten?** → Son **recursos distintos** con la misma base `ContactPerson`. Coexisten: `contact` (notificaciones) y `driver` (conductor, `mobileId`). La librería no impone nada; cada uno con su scope y permisos.
3. **¿`mobile.view` requiere `mobileIds[]` explícitos en el Joint o basta `allAccess` + permissions?** → Con la librería **basta** `allAccess` (scope `{}` + permiso `*`) o la **lista vía joints** → `auth.propertyIds` → `query.scope`. `moviles_usuarios` desaparece: el scope ya limita a los properties del usuario; si además se necesita limitar a vehículos puntuales, se agrega `auth.mobileIds` al payload y `query.scope` lo incluye.