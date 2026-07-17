#!/bin/bash
set -e
pnpm install --frozen-lockfile
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
pnpm --filter db push
