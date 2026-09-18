import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CreateFavouriteDto,
  MAX_PRESET_SLOT,
} from '../dto/create-favourite.dto';
import { FavouriteStation } from '../entities/favourite-station.entity';
import { StationDirectoryService } from './station-directory.service';

export interface Preset {
  slot: number;
  uuid: string;
  name: string;
  stream: string;
}

@Injectable()
export class FavouritesService {
  constructor(
    @InjectRepository(FavouriteStation)
    private readonly repository: Repository<FavouriteStation>,
    private readonly directory: StationDirectoryService,
  ) {}

  async list(): Promise<Preset[]> {
    const favourites = await this.repository.find({ order: { slot: 'ASC' } });

    return favourites.map((favourite) => ({
      slot: favourite.slot,
      uuid: favourite.stationUuid,
      name: favourite.name,
      stream: `/radio/stream/${favourite.stationUuid}`,
    }));
  }

  async add(dto: CreateFavouriteDto): Promise<Preset> {
    const existing = await this.repository.findOneBy({
      stationUuid: dto.stationUuid,
    });
    if (existing) return this.toPreset(existing);

    const station = await this.directory.getStation(dto.stationUuid);
    if (!station) throw new NotFoundException('Unknown station');

    const slot = dto.slot ?? (await this.firstFreeSlot());

    const favourite = await this.repository.save(
      this.repository.create({
        stationUuid: dto.stationUuid,
        name: dto.name ?? station.summary.name,
        countryCode: station.summary.countryCode,
        slot,
      }),
    );

    return this.toPreset(favourite);
  }

  async remove(uuid: string): Promise<void> {
    const result = await this.repository.delete({ stationUuid: uuid });
    if (!result.affected) throw new NotFoundException('Not a favourite');
  }

  async uuidForSlot(slot: number): Promise<string | null> {
    const favourite = await this.repository.findOneBy({ slot });
    return favourite?.stationUuid ?? null;
  }

  private async firstFreeSlot(): Promise<number> {
    const taken = new Set(
      (await this.repository.find()).map((row) => row.slot),
    );

    for (let slot = 1; slot <= MAX_PRESET_SLOT; slot++) {
      if (!taken.has(slot)) return slot;
    }

    throw new BadRequestException(
      `All ${MAX_PRESET_SLOT} preset slots are taken`,
    );
  }

  private toPreset(favourite: FavouriteStation): Preset {
    return {
      slot: favourite.slot,
      uuid: favourite.stationUuid,
      name: favourite.name,
      stream: `/radio/stream/${favourite.stationUuid}`,
    };
  }
}
