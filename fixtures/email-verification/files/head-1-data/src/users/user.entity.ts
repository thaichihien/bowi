import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * An account that can sign in to the app.
 *
 * Passwords are stored as bcrypt hashes; the plain password never reaches the database.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'email_verified', default: false })
  emailVerified: boolean;

  @Column({ name: 'verify_token', nullable: true })
  verifyToken: string | null;
}
