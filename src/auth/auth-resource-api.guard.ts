import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { AuthResourceApiService, AUTH_CONFIG } from './auth-resource-api.service';
import { RESOURCE_ACTION_KEY, ResourceActionOptions, AUTH_RESOURCE_API_KEY } from '../common/decorators';
import { Inject } from '@nestjs/common';

@Injectable()
export class AuthResourceApiGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthResourceApiService,
    @Inject(AUTH_CONFIG) private readonly config: any,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const actionOptions = this.reflector.get<ResourceActionOptions>(
      RESOURCE_ACTION_KEY,
      context.getHandler(),
    );

    if (actionOptions?.public) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Token not found');
    }

    return this.authService.getAuthentication(token, actionOptions?.strategy).pipe(
      map((authContext) => {
        request[AUTH_RESOURCE_API_KEY] = authContext;
        return true;
      }),
      catchError(() => {
        throw new UnauthorizedException();
      }),
    );
  }

  private extractToken(request: any): string | null {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return request.headers['x-api-key'] || null;
  }
}
