import { Injectable } from '@nestjs/common';
import { CommonGateway } from './common.gateway';
import { IBaseRepositoryService } from '../common/repository.interface';

@Injectable()
export class GatewayRegistry {
  private gateways = new Map<string, CommonGateway<any>>();
  private repos = new Map<string, IBaseRepositoryService<any>>();

  register(name: string, gateway: CommonGateway<any>, repo: IBaseRepositoryService<any>) {
    this.gateways.set(name, gateway);
    this.repos.set(name, repo);
  }

  get(name: string): CommonGateway<any> {
    const gw = this.gateways.get(name);
    if (!gw) throw new Error(`Gateway for resource ${name} not found`);
    return gw;
  }
  
  repo(name: string): IBaseRepositoryService<any> {
    const r = this.repos.get(name);
    if (!r) throw new Error(`Repository for resource ${name} not found`);
    return r;
  }
}
