import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Chiffrement des jetons GOG / Epic.
 *
 * POURQUOI : contrairement à une clé Steam (lecture seule sur une
 * ludothèque), un refresh token GOG ou Epic ouvre le compte entier. Il ne doit
 * donc jamais être stocké en clair ni renvoyé au navigateur — même par erreur
 * dans un JSON de débogage.
 *
 * AES-256-GCM, clé dérivée de SESSION_SECRET (scrypt, sel fixe) : pas de
 * variable d'environnement supplémentaire à configurer, et une rotation du
 * secret invalide proprement tous les jetons (il faut relier les comptes).
 * Le IV est aléatoire par valeur ; le tag d'authentification détecte toute
 * altération.
 */

const SALT = 'bastion-external-tokens';

function key(): Buffer {
  const secret = process.env.SESSION_SECRET ?? '';
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET manquant ou trop court (32+ caractères).');
  }
  return scryptSync(secret, SALT, 32);
}

/** "iv.tag.chiffré" en base64url — une seule colonne texte suffit. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('base64url')).join('.');
}

export function open(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [ivB64, tagB64, dataB64] = sealed.split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    // Secret changé ou donnée corrompue : il faut relier le compte à nouveau.
    return null;
  }
}
