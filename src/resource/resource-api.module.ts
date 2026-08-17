import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { ResourceConfig } from '../common/interfaces';
import { CommonApiService, RESOURCE_CONFIG, REPOSITORY_SERVICE, GATEWAY_SERVICE } from './common-api.service';
import { createCommonApiController } from './common-api.controller';

@Module({})
export class ResourceApiModule {
  static register(config: ResourceConfig): DynamicModule {
    const providers: Provider[] = [
      {
        provide: RESOURCE_CONFIG,
        useValue: config,
      },
    ];

    const imports: any[] = [];
    if (config.repositoryModule) {
        imports.push(config.repositoryModule);
    }
    
    if (config.repositoryToken) {
        providers.push({
            provide: REPOSITORY_SERVICE,
            useExisting: config.repositoryToken,
        });
    } else if (config.repositoryModule && config.repositoryModule.exports?.length) {
        // Auto-descubrimiento del token desde el módulo dinámico exportado
        let token = config.repositoryModule.exports[0];
        if (typeof token === 'object' && token.provide) {
            token = token.provide;
        }
        providers.push({
            provide: REPOSITORY_SERVICE,
            useExisting: token,
        });
    } else if (config.repositoryService) {
        // Wrapper manual
        providers.push(config.repositoryService);
        providers.push({
            provide: REPOSITORY_SERVICE,
            useExisting: config.repositoryService,
        });
    } else {
        // Fallback for testing, in memory dummy repo
        providers.push({
            provide: REPOSITORY_SERVICE,
            useValue: {
                find: () => require('rxjs').of([]),
                findOne: () => require('rxjs').of(null),
                create: (d) => require('rxjs').of({ id: Math.random().toString(), ...d }),
                update: (id, d) => require('rxjs').of({ id, ...d }),
                delete: () => require('rxjs').of(undefined),
                count: () => require('rxjs').of(0),
            }
        });
    }
    
    // Gateway logic optional provider
    providers.push({
        provide: GATEWAY_SERVICE,
        useValue: null // Mocking missing gateway for now to prevent errors
    });

    let ServiceClass = CommonApiService;
    if (config.setServices) {
      ServiceClass = config.setServices;
    }

    providers.push({
      provide: 'RESOURCE_SERVICE',
      useClass: ServiceClass,
    });

    const ControllerClass = createCommonApiController(config.route, config);

    const controllers = [ControllerClass];

    if (config.addController) {
      controllers.push(config.addController);
    }

    return {
      module: ResourceApiModule,
      imports,
      controllers,
      providers,
    };
  }
}
