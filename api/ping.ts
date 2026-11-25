/**
 * GET /api/ping — test ultra-minimal.
 *
 * Aucun import, aucun type externe, aucune dépendance : si cette route échoue,
 * le problème est dans la configuration du déploiement, pas dans le code.
 */
export default function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    node: process.version,
    moduleKind: typeof module !== 'undefined' ? 'cjs' : 'esm',
    hasDefault: true,
  });
}
