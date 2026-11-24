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
