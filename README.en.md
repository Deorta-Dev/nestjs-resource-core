# @deorta-dev/nestjs-resource-core

Library for NestJS that **standardizes resource management** in an API: full CRUD, configurable prefix permissions, authentication-based scope/workspace, filtering, dynamic reports by metrics and dimensions, choices, projected views, real-time gateways, and automatic documentation with Scalar.

It is **independent of the data layer and authentication**: it never connects to the database nor defines the auth strategy directly. Authentication lives in its own **module** (`AuthResourceApiModule`) with interchangeable strategies, and data access is delegated to a dedicated repository (e.g. `@deorta-dev/nestjs-repository-core`). The library focuses on **control and business rules**.

## Philosophy

- **Decoupled from data**: Receives an `IBaseRepositoryService`. It doesn't know about Mongo, Postgres, or ORMs.
- **Decoupled from auth**: A global guard resolves the strategy per request (`jwt`, `api-key`, etc.). The resource doesn't handle authentication.
- **`AuthResourceApiModule.register()`** — configures the **authentication strategy**: how sessions are generated, where they are saved (memory/redis/db), how a token is authenticated, and how permissions are resolved. It is a single shared instance for all resources.
- **`ResourceApiModule.register()`** — configures **each resource**: entity, input/output DTOs, endpoints, permissions, filters, reports, choices, views, gateway, and workspace. It uses the auth instance from `AuthResourceApiModule`.

### Observables First

Following the reactive philosophy, **everything is an Observable** (`rxjs`). 

## Installation

```bash
npm install @deorta-dev/nestjs-resource-core
```

## Quick Start

```typescript
// auth.module.ts
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
          sessionStore: { type: 'database', repository: SessionRepositoryModule, ttl: 12 * 3600 },
        },
      },
    }),
  ],
})
export class AuthResourceApiCoreModule {}
```

```typescript
// mobile.resource.ts
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

  dtos: {
    input: {
      create: CreateMobileDto,
      update: UpdateMobileDto,
    },
    output: MobileResponseDto,
  },

  endpoints: {
    mode: 'inclusion',
    include: ['create', 'list', 'get', 'update', 'delete', 'count', 'choice'],
  },

  permissions: { prefix: 'mobile' },
});
```

With this, you obtain standard CRUD endpoints protected with the `jwt` strategy, documented, and fully integrated with business logic.

## Real-Time Gateway (Socket.IO)

Each resource can expose a socket namespace to emit element and list changes in real time. It uses a `CommonGateway<T>` base class that handles auth, scope/workspace, and filtered subscriptions.

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
  auth: { tokenQuery: 'token' },
}
```

## Realtime Bridge (Consuming external server sockets)

When processing lives in another microservice (e.g. normalizer like Traccar), `api-public` can consume those sockets and emit them to related resources.

```typescript
RealtimeBridgeModule.forRoot({
  url: process.env.NORMALIZER_WS_URL,
  auth: { token: process.env.NORMALIZER_TOKEN },
  events: ['position', 'device', 'event', 'alert'],
})
```

## Workspaces Hierarchy

Workspaces can have sub-workspaces via materialized path (`path`), allowing scoped queries covering the entire descendant subtree efficiently.
