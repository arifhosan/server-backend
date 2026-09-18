import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FavouriteStation } from './entities/favourite-station.entity';
import { RadioBrowserClient } from './radio-browser/radio-browser.client';
import { RadioController } from './radio.controller';
import { RadioStreamController } from './radio-stream.controller';
import { FavouritesService } from './services/favourites.service';
import { StationDirectoryService } from './services/station-directory.service';
import { StreamHubService } from './services/stream-hub.service';

@Module({
  imports: [TypeOrmModule.forFeature([FavouriteStation])],
  controllers: [RadioController, RadioStreamController],
  providers: [
    RadioBrowserClient,
    StationDirectoryService,
    StreamHubService,
    FavouritesService,
  ],
})
export class RadioModule {}
