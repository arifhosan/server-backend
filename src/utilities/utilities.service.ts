import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from '@/database/entities/user.entity';
import { Utilities } from '@/database/entities/utilities.entity';
import { Repository } from 'typeorm';
import { UtilityDto } from './utilities.dto';

@Injectable()
export class UtilitiesService {
  constructor(
    @InjectRepository(Utilities)
    private utilityRepo: Repository<Utilities>,

    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {}

  async create(dto: UtilityDto, userId: number): Promise<Utilities> {
    const user = await this.userRepo.findOneBy({ id: userId });
    const utility = this.utilityRepo.create({ ...dto, user });
    return this.utilityRepo.save(utility);
  }

  async findAllByUser(userId: number): Promise<Utilities[]> {
    return this.utilityRepo.find({
      where: { user: { id: userId } },
      order: { date: 'DESC' },
    });
  }
  async delete(id: number, userId: number): Promise<void> {
    const record = await this.utilityRepo.findOneBy({ id });

    if (!record) {
      throw new NotFoundException('Utility record not found');
    }

    if (record.user.id !== userId) {
      throw new ForbiddenException(
        'You are not authorized to delete this record',
      );
    }

    await this.utilityRepo.remove(record);
  }
  async findUserMeters(userId: number) {
    return this.utilityRepo
      .createQueryBuilder('utility')
      .select(['utility.meterNumber', 'utility.type'])
      .where('utility.userId = :userId', { userId })
      .groupBy('utility.meterNumber')
      .addGroupBy('utility.type')
      .getRawMany();
  }
  async findByMeter(userId: number, meterNumber: string) {
    return this.utilityRepo.find({
      where: { user: { id: userId }, meterNumber },
      order: { date: 'ASC' },
    });
  }

  getForecastForMeter(meterId: number) {
    // TODO: Implement your forecast logic here.
    return {
      meterId,
      forecast: [
        { date: '2025-06-01', predictedValue: 100 },
        { date: '2025-06-02', predictedValue: 110 },
      ],
    };
  }
}
