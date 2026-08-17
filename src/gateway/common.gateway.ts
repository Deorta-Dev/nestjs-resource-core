import { OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, WebSocketServer, SubscribeMessage } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ResourceConfig, AuthResourceApiContext } from '../common/interfaces';
import { AuthResourceApiService } from '../auth/auth-resource-api.service';

export interface SocketData<T> {
  socket: Socket;
  auth: AuthResourceApiContext;
  workspaceValue?: string;
  emitValidateFn: (element: T) => boolean;
}

export abstract class CommonGateway<T = any> implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  protected socketDataMap = new Map<string, SocketData<T>>();

  constructor(
    protected readonly config: ResourceConfig<T>,
    protected readonly authService: AuthResourceApiService,
  ) {}

  afterInit(server: Server) {}

  handleConnection(client: Socket) {
    const token = client.handshake.query[this.config.gateway?.auth?.tokenQuery || 'token'] as string;
    if (!token) {
        client.disconnect();
        return;
    }
    this.authService.getAuthentication(token).subscribe({
        next: (authContext) => {
            const workspaceValue = authContext.workspace?.id;
            this.socketDataMap.set(client.id, {
                socket: client,
                auth: authContext,
                workspaceValue,
                emitValidateFn: () => true
            });
        },
        error: () => client.disconnect()
    });
  }

  handleDisconnect(client: Socket) {
    this.socketDataMap.delete(client.id);
  }

  @SubscribeMessage('subscribe')
  subscribe(client: Socket, payload: any): void {
      const data = this.socketDataMap.get(client.id);
      if (data) {
          data.emitValidateFn = (element: T) => {
              // Advanced matching would go here
              return true; 
          };
          client.emit(this.config.gateway?.events?.subscribed || 'subscribed');
      }
  }

  emitElement(element: T): void {
      if (!this.config.gateway?.events?.element) return;
      
      for (const [id, data] of this.socketDataMap.entries()) {
          if (data.emitValidateFn(element)) {
              data.socket.emit(this.config.gateway.events.element, element);
          }
      }
  }
}
