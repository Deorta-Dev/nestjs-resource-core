import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const AUTH_RESOURCE_API_KEY = 'authResourceApi';

export const AuthResourceApi = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request[AUTH_RESOURCE_API_KEY];
  },
);

export const RESOURCE_ACTION_KEY = 'resourceAction';

export interface ResourceActionOptions {
  public?: boolean;
  strategy?: string;
  [key: string]: any;
}

export const ResourceAction = (options: ResourceActionOptions) => SetMetadata(RESOURCE_ACTION_KEY, options);
