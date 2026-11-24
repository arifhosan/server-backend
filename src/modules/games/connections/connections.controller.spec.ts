import { NotFoundException } from '@nestjs/common';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';

describe('ConnectionsController', () => {
  const controller = new ConnectionsController({} as ConnectionsService);
  const user = { userId: 1 } as Parameters<ConnectionsController['sync']>[0];

  it('an unknown :provider is a 404', () => {
    expect(() => controller.sync(user, 'xbox')).toThrow(NotFoundException);
    expect(() => controller.remove(user, 'xbox')).toThrow(NotFoundException);
  });
});
