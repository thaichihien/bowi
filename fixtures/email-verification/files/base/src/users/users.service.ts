import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
}

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  create(input: CreateUserInput): Promise<User> {
    return this.repo.save(this.repo.create(input));
  }

  findByEmail(email: string): Promise<User | null> {
    return this.repo.findOneBy({ email });
  }

  findOneBy(where: Partial<User>): Promise<User | null> {
    return this.repo.findOneBy(where);
  }

  async update(id: string, changes: Partial<User>): Promise<void> {
    await this.repo.update(id, changes);
  }

  save(user: User): Promise<User> {
    return this.repo.save(user);
  }
}
