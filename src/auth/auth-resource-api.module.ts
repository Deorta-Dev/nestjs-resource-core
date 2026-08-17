import { DynamicModule, Module, Global, Provider } from '@nestjs/common';
import { AuthResourceApiModuleConfig } from '../common/interfaces';
import { AuthResourceApiService, AUTH_CONFIG } from './auth-resource-api.service';
import { AuthResourceApiGuard } from './auth-resource-api.guard';
import { APP_GUARD } from '@nestjs/core';

@Global()
@Module({})
export class AuthResourceApiModule {
  static register(config: AuthResourceApiModuleConfig): DynamicModule {
    const providers: Provider[] = [
      {
        provide: AUTH_CONFIG,
        useValue: config,
      },
      AuthResourceApiService,
      {
        provide: APP_GUARD,
        useClass: AuthResourceApiGuard,
      },
    ];

    const exportsList: any[] = [AuthResourceApiService, AUTH_CONFIG];

    if (config.permissionProvider) {
      providers.push({
        provide: 'PERMISSION_PROVIDER',
        useClass: config.permissionProvider,
      });
      exportsList.push('PERMISSION_PROVIDER');
    }
    
    if (config.workspace?.provider) {
        providers.push({
            provide: 'WORKSPACE_PROVIDER',
            useClass: config.workspace.provider,
        });
        exportsList.push('WORKSPACE_PROVIDER');
    }

    return {
      module: AuthResourceApiModule,
      providers,
      exports: exportsList,
    };
  }
}
