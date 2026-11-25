#!/usr/bin/env node
/**
 * Scan anti-secret.
 *
 * Bloque le commit si une clé API Steam, une URL Postgres avec mot de passe,
 * ou un secret de session apparaît dans un fichier stagé.
 * Filet de sécurité : .gitignore protège déjà .env.local, mais celui-ci
 * attrape les copies collées dans un fichier source par inadvertance.
 *
 * Sort en code 1 dès la première détection, avec le fichier et la ligne.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// Une clé Steam = 32 caractères hexadécimaux.
const PATTERNS = [
  {
    name: 'Clé API Steam',
    re: /STEAM_API_KEY\s*[=:]\s*['"]?([0-9A-Fa-f]{32})['"]?/,
    hint: 'Mets-la dans .env.local, jamais dans le code. Révoque-la sur steamcommunity.com/dev/apikey si elle a fuité.',
  },
  {
    name: 'Clé Steam (valeur brute)',
    re: /\b[0-9A-Fa-f]{32}\b/,
    hint: 'Ressemble à une clé API Steam en dur. Utilise process.env.STEAM_API_KEY.',
  },
  {
    name: 'URL Postgres avec mot de passe',
    re: /postgres(?:ql)?:\/\/[^:\s"']+:[^@\s"']+@/,
    hint: 'DATABASE_URL ne doit vivre que dans .env.local.',
  },
  {
    name: 'Secret de session',
    re: /SESSION_SECRET\s*[=:]\s*['"]?([A-Za-z0-9+/=_-]{32,})['"]?/,
    hint: 'Génère-le dans .env.local (openssl rand -hex 32).',
  },
  {
    name: 'Fichier .env traqué',
    re: /^$/,
    special: 'envfile',
  },
];

// Extensions que l'on scanne.
const SCANNABLE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|json|yml|yaml|md|txt|sh|html|css|py|go|rb|java)$/i;

function stagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', {
      encoding: 'utf8',
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function readStaged(file) {
  try {
    // On lit la version STAGÉE (index), pas le worktree.
    return execSync(`git show :${JSON.stringify(file)}`, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const files = stagedFiles();
const findings = [];

/**
 * Valeurs de .env.local à rechercher dans le dépôt.
 *
 * POURQUOI : Netlify bloque un déploiement lorsque la valeur d'une variable
 * d'environnement de production apparaît dans le code (« Exposed secrets
 * detected »). Ça arrive même avec un identifiant public — un identifiant
 * d'application Discord collé dans un test, par exemple. On reproduit donc ce
 * contrôle en local, pour échouer au commit plutôt qu'au déploiement.
 *
 * On ignore les valeurs qui ne peuvent pas être des secrets (adresse locale,
 * valeur courte) pour ne pas bloquer sur des faux positifs.
 */
function envValues() {
  if (!existsSync('.env.local')) return [];
  try {
    const raw = readFileSync('.env.local', 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1];
      const value = m[2].replace(/^["']|["']$/g, '').trim();
      if (value.length < 12) continue;
      if (/localhost|127\.0\.0\.1|example\.(com|net)|ton-site/i.test(value)) continue;
      out.push({ key, value });
    }
    return out;
  } catch {
    return [];
  }
}

const liveValues = envValues();

for (const file of files) {
  // .env.example est volontairement commité avec des valeurs VIDES.
  if (file === '.env.example') continue;

  const isEnv = /(^|\/)\.env(\.|$)/.test(file);
  if (isEnv) {
    findings.push({
      file,
      line: 0,
      name: 'Fichier .env traqué',
      hint: 'Seul .env.example doit être commité. Ajoute .env* dans .gitignore et déstage-le (git rm --cached).',
    });
    continue;
  }

  if (!SCANNABLE.test(file)) continue;

  const content = readStaged(file);
  if (content === null) continue;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of PATTERNS) {
      if (p.special) continue;
      if (p.re.test(line)) {
        findings.push({ file, line: i + 1, name: p.name, hint: p.hint });
      }
    }
  }

  // Valeur d'une variable d'environnement recopiée dans le dépôt.
  for (const { key, value } of liveValues) {
    const idx = content.indexOf(value);
    if (idx === -1) continue;
    findings.push({
      file,
      line: content.slice(0, idx).split('\n').length,
      name: `Valeur de ${key} recopiée dans le fichier`,
      hint:
        'Netlify refuse le build quand la valeur d’une variable d’environnement ' +
        'apparaît dans le dépôt. Remplace-la par une valeur fictive ' +
        '(ex. 123456789012345678) ; le test n’a pas besoin de la vraie.',
    });
    break;
  }
}

if (findings.length > 0) {
  console.error('\n\x1b[31m\x1b[1m COMMIT BLOQUÉ — secret potentiel détecté\x1b[0m\n');
  for (const f of findings) {
    console.error(`  \x1b[33m${f.file}\x1b[0m${f.line ? `:${f.line}` : ''}`);
    console.error(`    ${f.name}`);
    console.error(`    \x1b[90m→ ${f.hint}\x1b[0m\n`);
  }
  console.error(
    '  Si c’est un faux positif, vérifie d’abord, puis : git commit --no-verify\n',
  );
  process.exit(1);
}

console.log('\x1b[32m[scan-secrets]\x1b[0m aucun secret détecté.');
