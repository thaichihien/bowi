import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmailVerified1730 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE users
      ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
      ADD COLUMN verify_token varchar NULL`);
  }

  async down(q: QueryRunner) {
    await q.query(`ALTER TABLE users DROP COLUMN email_verified, DROP COLUMN verify_token`);
  }
}
