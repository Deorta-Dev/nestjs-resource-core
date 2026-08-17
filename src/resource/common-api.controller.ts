import { Controller, Get, Post, Body, Param, Inject } from '@nestjs/common';
import { Observable } from 'rxjs';
import { CommonApiService } from './common-api.service';
import { AuthResourceApi } from '../common/decorators';
import { AuthResourceApiContext } from '../common/interfaces';

export function createCommonApiController(route: string, config: any) {
  @Controller(route)
  class DynamicCommonApiController {
    constructor(
      @Inject('RESOURCE_SERVICE') public readonly service: CommonApiService,
    ) {}

    @Get()
    list(@AuthResourceApi() auth: AuthResourceApiContext): Observable<any[]> {
      return this.service.list({ auth });
    }

    @Get(':id')
    get(@AuthResourceApi() auth: AuthResourceApiContext, @Param('id') id: string): Observable<any> {
      return this.service.get({ auth }, id);
    }

    @Post()
    create(@AuthResourceApi() auth: AuthResourceApiContext, @Body() body: any): Observable<any> {
      return this.service.create({ auth }, body);
    }
  }

  return DynamicCommonApiController;
}
