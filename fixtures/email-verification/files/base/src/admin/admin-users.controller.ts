import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminGuard } from './admin.guard';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';

interface CreateUserDto {
  email: string;
  password: string;
}

@Controller('admin/users')
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  async create(@Body() dto: CreateUserDto): Promise<User> {
    const passwordHash = await bcrypt.hash(dto.password, 12);
    return this.users.create({ email: dto.email, passwordHash });
  }
}
