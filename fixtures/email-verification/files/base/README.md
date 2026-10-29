# acme-api

Backend for the Acme web app, built with NestJS and TypeORM.

## Getting started

```bash
npm install
npm run start:dev
```

The API listens on port 3000 by default. Copy `.env.example` to `.env` and fill in the database settings before starting.

## Configuration

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Secret used to sign access tokens |
| `SMTP_URL` | Mail server used for outgoing email |

## Authentication

Users sign up with `POST /auth/register` and sign in with `POST /auth/login`.

A successful login returns a JWT access token. Send it as `Authorization: Bearer <token>`.

Tokens expire after 15 minutes.

## Testing

```bash
npm test
```
