/**
 * Diagnostic des événements Discord.
 *
 * Appelle directement l'API Discord avec les variables locales : ça valide le
 * jeton du bot, l'identifiant du serveur et les permissions — sans passer par
 * l'application ni par une session.
 *
 * Usage : node scripts/test-discord-events.mjs
 */
import fs from 'node:fs';
import { createServer } from 'vite';

const envFile = '.env.local';
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const token = process.env.DISCORD_BOT_TOKEN;
const guild = process.env.DISCORD_GUILD_ID;

console.log('\n=== CONFIGURATION ===');
console.log(`  DISCORD_BOT_TOKEN : ${token ? `présent (${token.length} car.)` : 'MANQUANT'}`);
console.log(`  DISCORD_GUILD_ID  : ${guild ?? 'MANQUANT'}`);

if (!token || !guild) {
  console.error('\n  Renseigne les deux variables dans .env.local, puis relance.');
  process.exit(1);
}

if (!/^\d{17,20}$/.test(guild)) {
  console.error(
    `\n  DISCORD_GUILD_ID ne ressemble pas à un identifiant Discord ` +
      `(attendu : 17 à 20 chiffres, reçu : "${guild}").`,
  );
  process.exit(1);
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const mod = await vite.ssrLoadModule('/lib/discord-bot.ts');

  // ── Diagnostic étape par étape ──
  console.log('\n=== IDENTITE DU BOT ===');
  const meRes = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!meRes.ok) {
    console.error(`  ✗ Jeton refusé (HTTP ${meRes.status}). Régénère-le (Reset Token).`);
    process.exit(1);
  }
  const bot = await meRes.json();
  console.log(`  ✓ ${bot.username}#${bot.discriminator ?? '0'}  (id ${bot.id})`);

  console.log('\n=== ACCES AU SERVEUR ===');
  const guildRes = await fetch(`https://discord.com/api/v10/guilds/${guild}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (guildRes.status === 403) {
    console.error('  ✗ 403 : le bot N EST PAS sur ce serveur (ou pas encore autorisé).');
    console.error('    → Réinvite-le avec le scope bot sur CE serveur.');
    process.exit(1);
  }
  if (guildRes.status === 404) {
    console.error('  ✗ 404 : le bot n’est pas membre de ce serveur.');
    console.error('    Le jeton est valide, mais le bot n’a pas rejoint ce serveur.');

    // On récupère l'identifiant d'application pour construire le bon lien.
    try {
      const appRes = await fetch('https://discord.com/api/v10/oauth2/applications/@me', {
        headers: { Authorization: `Bot ${token}` },
      });
      if (appRes.ok) {
        const app = await appRes.json();
        const invite =
          `https://discord.com/oauth2/authorize?client_id=${app.id}` +
          `&scope=bot%20applications.commands&permissions=8589934592`;
        console.error('\n    Lien d’invitation à ouvrir (choisis CE serveur) :\n');
        console.error(`    ${invite}\n`);
      }
    } catch {
      /* pas bloquant */
    }

    // Double vérification : sur quels serveurs le bot est-il présent ?
    const gRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (gRes.ok) {
      const guilds = await gRes.json();
      if (Array.isArray(guilds) && guilds.length > 0) {
        console.log('    Serveurs où le bot est actuellement :');
        for (const gg of guilds) console.log(`      • ${gg.name}  (id ${gg.id})`);
        console.log('\n    Compare ces identifiants avec DISCORD_GUILD_ID.');
      } else {
        console.log('    Le bot n’est présent sur AUCUN serveur.');
      }
    }
    process.exit(1);
  }
  if (!guildRes.ok) {
    console.error(`  ✗ HTTP ${guildRes.status}`);
    process.exit(1);
  }
  const g = await guildRes.json();
  console.log(`  ✓ Le bot est membre de « ${g.name} »`);

  console.log('\n=== EVENEMENTS ===');
  const events = await mod.getScheduledEvents();

  console.log(`  ${events.length} événement(s) récupéré(s)\n`);

  if (events.length === 0) {
    console.log('  Le serveur n’a aucun événement programmé (c’est un résultat valide).');
    console.log('  Crée-en un sur Discord : clic droit sur un salon vocal → Créer un événement.');
  } else {
    const fmt = new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'full',
      timeStyle: 'short',
    });
    const statusLabel = { 1: 'programmé', 2: 'en cours', 3: 'terminé', 4: 'annulé' };

    for (const e of events) {
      console.log(`  • ${e.name}`);
      console.log(`      début   : ${fmt.format(new Date(e.scheduled_start_time))}`);
      console.log(`      statut  : ${statusLabel[e.status] ?? e.status}`);
      console.log(`      type    : ${e.entity_type} (${e.entity_metadata?.location ?? 'sans lieu'})`);
      console.log(`      intéressés : ${e.user_count ?? 0}`);
      console.log(`      image   : ${e.image ? 'oui' : 'non'}`);
    }
  }

  console.log('\n  ✓ Configuration Discord valide.');
} catch (err) {
  console.error('\n  ✗ ÉCHEC');
  console.error(`    ${err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
