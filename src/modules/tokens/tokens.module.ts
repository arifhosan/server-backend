import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TokenDay } from './entities/token-day.entity';
import { TokensController } from './tokens.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TokenDay])],
  controllers: [TokensController],
})
export class TokensModule {}
