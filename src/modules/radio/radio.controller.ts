import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CreateFavouriteDto } from './dto/create-favourite.dto';
import { SearchStationsDto } from './dto/search-stations.dto';
import { FavouritesService, Preset } from './services/favourites.service';
import { StationDirectoryService } from './services/station-directory.service';
import { StreamHubService } from './services/stream-hub.service';
import {
  GeoPoints,
  RadioBrowserNameCount,
  StationStreamState,
  StationSummary,
} from './types/station.types';

const UI_FILE = 'index.html';

@Controller('radio')
export class RadioController {
  constructor(
    private readonly directory: StationDirectoryService,
    private readonly favourites: FavouritesService,
    private readonly hub: StreamHubService,
  ) {}

  @Get()
  player(@Res() response: Response): void {
    response.sendFile(resolveUiPath());
  }

  @Get('stations/search')
  search(@Query() query: SearchStationsDto): Promise<StationSummary[]> {
    return this.directory.search(query);
  }

  @Get('stations/geo')
  geo(
    @Query('limit', new DefaultValuePipe(12000), ParseIntPipe) limit: number,
  ): Promise<GeoPoints> {
    return this.directory.geoPoints(limit);
  }

  @Get('stations/:uuid')
  async station(@Param('uuid') uuid: string): Promise<StationSummary> {
    const resolved = await this.directory.getStation(uuid);
    if (!resolved) throw new NotFoundException('Unknown station');

    return resolved.summary;
  }

  @Get('countries')
  countries(): Promise<RadioBrowserNameCount[]> {
    return this.directory.countries();
  }

  @Get('tags')
  tags(): Promise<RadioBrowserNameCount[]> {
    return this.directory.tags();
  }

  @Get('active')
  active(): StationStreamState[] {
    return this.hub.active();
  }

  @Get('presets')
  presets(): Promise<Preset[]> {
    return this.favourites.list();
  }

  @Post('presets')
  addPreset(@Body() dto: CreateFavouriteDto): Promise<Preset> {
    return this.favourites.add(dto);
  }

  @Delete('presets/:uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  removePreset(@Param('uuid') uuid: string): Promise<void> {
    return this.favourites.remove(uuid);
  }
}

/** Falls back to the source tree when the build has not copied assets. */
function resolveUiPath(): string {
  const built = join(__dirname, 'public', UI_FILE);
  if (existsSync(built)) return built;

  return join(process.cwd(), 'src', 'modules', 'radio', 'public', UI_FILE);
}
