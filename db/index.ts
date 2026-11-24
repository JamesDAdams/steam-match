import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.ts';

/**
 * Client Drizzle.
 *
 * En serverless on utilise le driver HTTP de Neon : pas de pool de connexions
 * TCP à maintenir entre deux invocations, donc pas de dépassement du quota
 * de connexions (problème classique de Postgres sur Vercel).
 */

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL manquant. Copie .env.example en .env.local et remplis-le.',
    );
  }

  const sql = neon(url);
  _db = drizzle(sql, { schema });
  return _db;
}

export { schema };
