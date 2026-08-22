# QAI — Plan d'évolution v0.2+ (spec d'implémentation)

> Document de travail destiné à une session d'implémentation (Claude Opus 5).
> Il est auto-suffisant : tout le contexte nécessaire est ici ou dans le code.
> Issu d'un audit complet du code le 2026-08-22.

## État d'avancement (branche `QAIV2`)

**Livrés** — phase 1 complète, plus la couche d'observation de la phase 2 :

| Lot | Items | État |
|---|---|---|
| A | 1.8 version, 1.9 API, 1.1 URL, 1.2 env, 1.3 tags, 1.4 JUnit | ✅ |
| B | 1.7 suggestions, 1.10 select par libellé, 1.5 dialogues, 1.6 upload | ✅ |
| C | 2.1 observation réseau/console, 2.2 garde-fous | ✅ |

**Restant** — reprendre à l'ordre d'exécution ci-dessous :

| Lot | Items | Note |
|---|---|---|
| D | 2.4 bouchonnage `given.network`, puis 2.3 action `api` | risque moyen |
| E | 3.4 checks étendus, 3.7 anti-flake, 3.6 settle v2 | risque moyen |
| F | 3.1 rôles, 3.2 shadow DOM, 3.3 iframes | **bump v2 + passe de vérification** |
| G | 3.5 émulation, 3.8 retries/shard | faible |
| H | 4.1 → 4.8 | faible |
| I | 4.9 i18n, 4.10 workspaces | structurel |

Deux points de contexte pour la suite :

- `RESOLUTION_VERSION` (`src/resolution/types.ts`) est la constante unique à
  passer à 2 au lot F. Le chargeur lit déjà « absent = 1 » et refuse une
  version future avec un message qui dit quoi faire.
- `CheckContext` (`src/engine/assert.ts`) porte déjà `observations` : l'action
  `api` du lot D s'y range sans changer la signature de `evaluateCheck`.

---

## 0. Règles du jeu — À LIRE AVANT TOUT CHANGEMENT

### 0.1 Ce que QAI est

Framework E2E « intent-based » auto-réparant. Deux fichiers par parcours :
`<id>.qai.yaml` (intention humaine, zéro sélecteur) + `.qai/resolutions/<id>.web.json`
(cache machine : actions/assertions/captures, ancrées sur les ids d'étape).
Trois étages : **replay** (0 appel modèle), **heal** (1 appel/cible cassée),
**resolve** (~1,5 appel/étape). Toute proposition du modèle est vérifiée contre
l'application réelle avant acceptation.

### 0.2 Invariants — ne JAMAIS casser

1. **Le réparateur ne touche jamais aux assertions.** Deux barrières : le moteur
   ne l'appelle que sur un échec de résolution de cible (`src/engine/run.ts`),
   et `healProposalSchema` n'expose ni assertion ni action (`src/generate/schema.ts`).
   Toute évolution du heal doit préserver les deux.
2. **Ambigu = refus.** Plusieurs correspondances sans `nth` → on n'agit pas.
   Jamais de « premier match ».
3. **Les assertions sont évaluées par le moteur** sur un `UISnapshot`
   (`src/engine/assert.ts` + `src/engine/match.ts`), jamais par un driver.
   C'est la garantie de portabilité mobile.
4. **Le replay ne fait aucun appel modèle.** Aucune fonctionnalité ne doit
   introduire d'appel modèle dans le chemin de rejeu nominal.
5. **`usage` obligatoire** dans `ModelResponse` ; tout nouvel appel modèle passe
   par le provider (donc par `BudgetedProvider` si un plafond est posé).
6. **Les réparations sont réécrites dans le fichier de résolution** (diff de
   revue), jamais appliquées silencieusement.

### 0.3 Règles de compatibilité (les suites existantes doivent survivre)

La suite de référence réelle est `../tc_tilmischool_ui/qa/` (53 scénarios,
16 résolutions). Règles :

- **R1 — Unions additives.** `Action` et `Check` ne changent que par ajout de
  nouveaux `kind`/`check`. Ne jamais renommer/supprimer un discriminant existant.
- **R2 — Défauts gelés.** Viewport `1280×800`, chromium, `assertTimeout 5000`,
  `workers 4`, format des chemins de résolution `<dossier>/.qai/resolutions/<id>.web.json` :
  inchangés par défaut.
- **R3 — `version` de résolution : absent = 1.** Le loader accepte les fichiers
  sans champ `version` (les 16 existants). On n'écrit `version` que sur les
  nouvelles sauvegardes. Bump à 2 uniquement en Phase 3 (changements d'observation).
- **R4 — Nouveaux comportements opt-in.** Watchdogs réseau/console, animations
  désactivées, vision : off par défaut à la première release.
- **R5 — `tilmiqai` reste `tilmiqai`.** Nom npm, bin `qai`, exports de types,
  format `qai.config.json` : stables.
- **R6 — Rituel de vérification** après chaque phase :
  ```bash
  npm run typecheck
  npm test                       # node --test, 100 tests existants
  npm run demo                   # fixture shop sur :8899 (autre terminal)
  npm run qai -- run examples/ --base-url http://127.0.0.1:8899/
  ```
  Et idéalement un run de la suite tilmischool contre un build connu bon.

### 0.4 Conventions de code

- Code, commentaires, messages d'erreur, prompts : **en français**, style du code
  existant (commentaires qui expliquent le *pourquoi*/la contrainte, pas le quoi).
  L'anglais n'arrive qu'à l'item 4.9 (i18n), pas avant.
- Tests : `node:test` (`*.test.ts` à côté du module), mêmes patterns que
  l'existant (`src/engine/fixtures.ts` fournit `node()` pour construire des arbres).
- TypeScript strict, `type: module`, Node ≥ 22, imports avec extension `.ts`.
- Commits : messages descriptifs **en français**, un par sujet,
  **sans** trailer `Co-Authored-By: Claude`.
- Chaque item ci-dessous = un commit (ou une petite série) indépendant,
  typecheck + tests verts à chaque étape.

### 0.5 Carte du code (état actuel)

| Module | Rôle |
|---|---|
| `src/scenario/` | parse/validation YAML (`types.ts`, `load.ts`) |
| `src/resolution/` | types du cache, load/save/apply des heals |
| `src/driver/types.ts` | contrat plateforme-neutre (`Driver`, `Action`, `Locator`, `UINode`, `Capabilities`…) |
| `src/driver/web/` | `PlaywrightWebDriver`, `locator.ts` (QAI→Playwright), `observe-script.ts` (collecteur injecté) |
| `src/engine/` | `run.ts` (rejeu+heal), `suite.ts` (parallélisme), `assert.ts` (checks+interpolation), `match.ts` (locator→arbre), `consistency.ts` |
| `src/generate/` | boucle resolve (`generate.ts`), prompts, schémas JSON de sortie, `render.ts` (arbre→texte) |
| `src/heal/` | `ModelHealer` |
| `src/model/` | contrat provider + `BudgetedProvider` |
| `src/report/` | text, markdown, artifacts (screenshots) |
| `src/cli.ts` | commandes `run`/`check`/`resolve` |

---

## PHASE 1 — Débloquants rapides (petits, additifs, sans risque)

### 1.1 Assertions d'URL : `urlContains` / `urlEquals`

**Pourquoi.** « l'utilisateur est redirigé vers la connexion » est inexprimable
aujourd'hui. `UISnapshot.location` existe mais n'atteint jamais `evaluateCheck`.
Requis par `auth-routes-protegees.qai.yaml` (tilmischool).

**Design.**
- `src/resolution/types.ts` : ajouter à `Check`
  `{ check: 'urlContains'; value: string }` et `{ check: 'urlEquals'; value: string }`
  — **sans `target`** (l'URL n'est pas un nœud).
- `src/engine/assert.ts` : `evaluateCheck` reçoit un paramètre `location: string`
  en plus (ou un objet contexte `{ root, location, bag }` — préférer l'objet,
  extensible en Phase 2 pour le réseau). Interpolation `{{...}}` valable sur `value`.
- `src/engine/run.ts` : passer `snapshot.location` à l'évaluation (la boucle de
  réévaluation ré-observe déjà toutes les 250 ms → l'URL suit).
- `src/generate/generate.ts` (`verifyChecks`) : même plumbing.
- `src/generate/schema.ts` : la forme actuelle des assertions exige `target` ;
  passer à un `oneOf` : branche « check ciblé » (target requis) / branche
  « check d'URL » (pas de target). Attention : garder le schéma non-récursif et
  compatible sortie contrainte.
- `src/engine/consistency.ts` : aucun changement (les clés restent le texte).
- Docs : `docs/scenario-format.md` + `docs/engine.md`.

**Compat.** Additif (R1). **Tests.** assert.test.ts : équals/contains, interpolation,
casse trailing slash non normalisée (documenter : comparaison brute).

### 1.2 Interpolation d'environnement `{{env.NOM}}`

**Pourquoi.** `{{nom}}` ne résout que les captures. Impossible d'écrire « saisir
le mot de passe » sans que le secret atterrisse en clair dans la résolution
versionnée. Bloque les scénarios de connexion sur n'importe quelle base de code.

**Design.**
- `src/engine/assert.ts` (`interpolate`) : motif `{{env.([A-Z0-9_]+)}}` résolu
  depuis `process.env` **au moment du rejeu/de la génération**. Variable absente
  → `InterpolationError` avec le nom (« variable d'environnement QAI_PASS non
  définie »), jamais chaîne vide silencieuse.
- La valeur ne doit **jamais** être réécrite dans un fichier : les résolutions
  stockent le template, l'interpolation est à l'exécution. Vérifier que
  `fill.value` passe bien par l'interpolation au rejeu — **aujourd'hui non** :
  `performActions` n'interpole pas les `value` des actions. L'ajouter :
  interpoler `fill.value` / `select.option` (bag + env) juste avant `driver.act`.
  C'est aussi ce qui rend `{{capture}}` utilisable dans un fill (bonus).
- Rapports/erreurs : masquer la valeur (`***`) si elle provient de `env.`.
- Génération : le prompt (`src/generate/prompt.ts`) documente que pour une valeur
  secrète fournie par l'intention (« utiliser l'identifiant de QAI_USER »), le
  modèle doit émettre le template `{{env.QAI_USER}}`, pas une valeur inventée.

**Compat.** Additif — aucun fichier existant ne contient `{{env.` (aurait levé
une erreur de capture manquante). **Tests.** interpolation env présente/absente,
masquage dans les messages, fill interpolé au rejeu.

### 1.3 Filtrage par tags : `--tags`

**Pourquoi.** `Scenario.tags` existe, le CLI ne sait pas filtrer. Impossible de
lancer « juste les critical-path » en smoke.

**Design.** `src/cli.ts` : option `--tags a,b` (string, séparateur virgule) +
clé config `tags`. Après chargement des scénarios, ne garder que ceux dont
`tags` intersecte. Appliquer à `run` **et** `check` **et** `resolve`.
0 scénario après filtre → message + exit 1 (cohérent avec « aucun scénario trouvé »).

**Compat.** Additif. **Tests.** config.test.ts pour la clé ; un test CLI léger si
un harnais existe, sinon extraire la fonction de filtre pure et la tester.

### 1.4 Reporter JUnit XML : `--format junit`

**Pourquoi.** Standard universel d'ingestion CI (GitLab/Jenkins/Azure).
text/json/markdown ne suffisent pas.

**Design.** `src/report/junit.ts` : `formatJUnit(report: SuiteReport): string`.
Mapping : suite JUnit = scénario ; testcase = étape ; `failed` → `<failure>` avec
raison + assertions ; `skipped` → `<skipped/>` ; `healed` → passe + `<system-out>`
contenant les notes de réparation (et si `--strict`, générer `<failure>` sur les
healed — cohérent avec le code de sortie). Échapper le XML. Durées en secondes.
Brancher dans `src/cli.ts` (le `--out` existant fait le reste).

**Compat.** Additif. **Tests.** snapshot sur un `SuiteReport` fabriqué
(même style que markdown.test.ts).

### 1.5 Boîtes de dialogue natives : action `expectDialog`

**Pourquoi.** Playwright **rejette automatiquement** `confirm()`/`alert()` :
tout parcours « supprimer → confirmer » casse silencieusement aujourd'hui.

**Design.**
- `src/driver/types.ts` : `Action` +=
  `{ kind: 'expectDialog'; response: 'accept' | 'dismiss'; promptText?: string }`.
  Sémantique : **arme** une politique one-shot pour LE prochain dialogue natif ;
  se place dans la liste d'actions juste avant le clic déclencheur.
  `Capabilities` += `dialogs: boolean` (web: true).
- `PlaywrightWebDriver` : file d'attente de politiques ; `page.on('dialog')`
  consomme la tête (accept/dismiss, `promptText` pour les prompts), sinon
  comportement par défaut. Politique non consommée en fin d'étape → warning.
- `src/engine/run.ts` (`supports`) : vérifier `capabilities.dialogs`.
- `src/generate/schema.ts` + prompt : exposer l'action au modèle avec une ligne
  de règle (« un clic qui déclenche une confirmation native doit être précédé
  de expectDialog »).

**Compat.** Additif. **Tests.** page fixture avec `confirm()` dans
PlaywrightWebDriver.test.ts : accept, dismiss, prompt avec texte.

### 1.6 Téléversement : action `upload`

**Pourquoi.** Import/avatar/document intestables aujourd'hui.

**Design.**
- `Action` += `{ kind: 'upload'; target: ResolvedTarget; files: string[] }`
  (chemins **relatifs au fichier scénario** ; les résoudre au chargement côté
  moteur/CLI, pas dans le driver). Ajouter `'upload'` à `WITH_TARGET`
  (`src/resolution/types.ts`) pour que le heal sache le réparer.
- Web : `locator.setInputFiles(files)`. Cible = l'`input[type=file]` (souvent
  masqué → la résolution passera par le fallback si l'input n'a pas de nom ;
  c'est acceptable et documenté).
- Schéma + prompt + docs. Fixture : ajouter un input file au shop de démo.

**Compat.** Additif. **Tests.** e2e sur la fixture (upload puis assertion sur le
nom de fichier affiché).

### 1.7 Suggestions de quasi-correspondance à l'échec

**Pourquoi.** Transformer « cible introuvable » en fix humain de 10 s sans
brûler un appel de heal. Améliore massivement l'usage sans `--provider`.

**Design.**
- Nouveau `src/engine/nearest.ts` : fonction pure
  `nearest(tree: UINode, target: Locator, n = 3): { role, name, score }[]`.
  Similarité simple et déterministe : normalisation (minuscules, espaces),
  distance de Levenshtein normalisée + bonus si le rôle correspond.
  Seuil (< 0,45 p.ex.) pour ne rien proposer d'absurde.
- `src/engine/run.ts` : sur `no-match` (avant heal, et dans le message d'échec
  final), observer est déjà fait pour le heal ; sinon observer une fois.
  Message : `cible introuvable — plus proches : button "Sauvegarder", button "Annuler"`.
- Réutiliser dans `verifyActions` (`src/generate/generate.ts`) pour enrichir le
  retour au modèle (améliore la convergence du resolve).

**Compat.** Message enrichi seulement. **Tests.** nearest.test.ts pur (fixtures
`node()`), cas accents/casse.

### 1.8 Champ `version` dans les résolutions

**Pourquoi.** Toute évolution du format (1.1, 2.x, 3.x) casserait les fichiers
en silence. Prépare la Phase 3.

**Design.**
- `src/resolution/types.ts` : `Resolution.version?: number`.
- `src/resolution/load.ts` : absent → 1 ; > version supportée → erreur claire
  (« résolution v3, ce QAI lit v2 : régénérer ou mettre à jour QAI »).
- `src/resolution/save.ts` : écrit `version: 1` (bump à 2 en Phase 3 seulement).
- Publier `schema/resolution.schema.json` (le schéma scénario existe déjà dans
  `schema/scenario.schema.json` — l'étendre au fil des phases).

**Compat.** R3 stricte : les 16 fichiers tilmischool sans version doivent charger.
**Tests.** load sans version, avec version 1, avec version future.

### 1.9 API programmatique exportée

**Pourquoi.** `src/index.ts` n'exporte que des types (+ budget). Impossible
d'embarquer QAI dans vitest/jest ou un harnais maison — nécessaire pour
« n'importe quelle base de code ».

**Design.** Exporter (valeurs) : `runScenario`, `runSuite`, `generateResolution`,
`checkConsistency`, `formatIssue`, `ModelHealer`, `PlaywrightWebDriver`,
`parseScenario`, `loadScenario`, `loadResolution`, `saveResolution`, `applyHeals`,
`artifactWriter`, `formatSuite`, `formatMarkdown`, `loadConfig`.
Attention build : `dist/index.js` embarquera le moteur — garder
`--external:playwright` (déjà le cas). Documenter un exemple « embed » dans le
README (10 lignes).

**Compat.** Additif. **Tests.** cli.pack.test.ts vérifie déjà le paquet — ajouter
un smoke import des nouveaux exports.

### 1.10 `select` par libellé (avec repli)

**Pourquoi.** `selectOption(string)` matche par **value** ; un outil d'intention
doit viser le libellé visible.

**Design.** `PlaywrightWebDriver.act` cas `select` : tenter
`selectOption({ label: option })` d'abord, puis repli `selectOption(option)`
(value) si aucune option ne matche — via lecture des options
(`locator.evaluate`) pour décider **sans** consommer deux timeouts.
Ordre libellé→value car les nouvelles résolutions viendront du modèle qui voit
les libellés ; les anciennes résolutions par value passent par le repli (R1 ok).

**Compat.** Comportement conservé pour value ; vérifier sur la suite tilmischool
(aucun `select` dans les 16 résolutions actuelles → risque nul).
**Tests.** fixture avec `<select>` value≠label : les deux formes passent.

---

## PHASE 2 — La couche réseau / endpoints

> Objectif : prouver que l'UI parle vraiment aux endpoints, diagnostiquer les
> échecs, et rendre testables les états d'erreur/vide/lenteur. Modélé sur
> `cy.intercept` (Cypress) et `page.route`/HAR (Playwright), mais exprimé dans
> le vocabulaire plateforme-neutre de QAI.

### 2.1 Observation passive : réseau + console

**Design.**
- `src/driver/types.ts` :
  ```ts
  interface NetworkEntry { method: string; url: string; status: number | null; // null = échec réseau
                           durationMs: number; at: string }
  interface ConsoleEntry { level: 'error' | 'warning'; text: string; at: string }
  interface Capabilities { …; network: boolean }
  interface Driver { …; drainObservations?(): { network: NetworkEntry[]; console: ConsoleEntry[] } }
  ```
  Méthode optionnelle + capability : les drivers mobiles pourront dire non.
- `PlaywrightWebDriver` : brancher `page.on('response')`, `page.on('requestfailed')`,
  `page.on('console')` (niveaux error/warning), `page.on('pageerror')` (→ console
  error). Buffers bornés (p.ex. 200 entrées, FIFO). `drainObservations()` vide
  et rend. Filtrer le bruit connu (data:, favicon) derrière une liste par défaut.
- `src/engine/run.ts` : après chaque étape, drainer ; stocker par étape.
  `StepReport` += `network?: NetworkEntry[]` et `consoleErrors?: string[]`
  **uniquement en cas d'échec ou de watchdog déclenché** (taille des rapports).
- Reporters : sur une étape échouée, afficher les N dernières requêtes en échec
  + erreurs console à côté du screenshot (text + markdown).

**Compat.** Purement additif tant que rien n'échoue en plus (voir 2.2).
**Tests.** fixture shop : une route qui 500 + un `console.error` scriptés ;
vérifier la collecte et la présence dans le rapport d'échec.

### 2.2 Watchdogs : `noConsoleErrors` / `noFailedRequests`

**Design.**
- Deux niveaux :
  1. **Check d'étape** (opt-in par assertion) : `Check` +=
     `{ check: 'noFailedRequests'; allow?: string[] }` et
     `{ check: 'noConsoleErrors'; allow?: string[] }` (motifs `contains`).
     Évalués sur les observations de L'ÉTAPE (le contexte passé à
     `evaluateCheck` — cf. 1.1 — gagne `network`/`console`).
  2. **Watchdog de suite** (config) : `qai.config.json` +=
     `"watchdogs": { "consoleErrors": "off" | "warn" | "fail", "requestFailures": … , "allow": ["…"] }`.
     Défaut **`off`** (R4). `warn` = warning d'étape (le champ `warnings` existe),
     `fail` = échec d'étape avec la liste.
- Important : ces checks n'entrent PAS dans la boucle de réévaluation 250 ms
  (une erreur console ne « guérit » pas) — évaluer une fois, après settle.

**Compat.** R4 : défaut off ; les suites existantes ne bougent pas. Documenter
la montée en deux temps (warn → fail).
**Tests.** les trois modes + allowlist.

### 2.3 Action `api` (appel direct d'endpoint)

**Pourquoi.** Vérité serveur : « après Enregistrer, GET /students/{{id}} rend le
nouveau nom ». Aussi utile en préparation légère de données.

**Design.**
- `Action` += `{ kind: 'api'; method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  url: string; body?: string; headers?: Record<string,string>;
  capture?: Record<string, string> }` où `capture` mappe nom → chemin pointé
  simple dans le JSON de réponse (`"prenom"` / `"data.0.id"`) + pseudo-chemins
  `$status`. URL relative à `baseUrl`, interpolation `{{...}}` (bag + env)
  sur url/body/headers.
- Exécution **par le driver** (pas fetch Node) : sur le web,
  `page.request.fetch()` — l'`APIRequestContext` du contexte partage les cookies
  → la session du parcours s'applique (indispensable : tc_session etc.).
  Contrat : `Driver.api?(request): Promise<{ status: number; body: string }>`
  + `capabilities.api: boolean`. Le moteur parse le JSON et remplit le bag ;
  échec de capture = même politique que les captures d'écran (`captureErrors`).
- Les assertions d'étape peuvent alors porter sur `{{capture}}` via les checks
  existants, ou vérifier `$status` capturé avec `numberEquals`.
- Génération : NE PAS exposer `api` au modèle dans un premier temps (action
  d'auteur avancé, écrite à la main dans la résolution) — le schéma du resolve
  reste inchangé ; le rejeu, la consistance et le heal la supportent.
  (`api` n'a pas de `target` → hors périmètre heal, comme `navigate`.)

**Compat.** Additif. **Tests.** fixture shop : endpoint JSON ; scénario e2e
« cliquer ajouter au panier → api GET /api/cart → capture count → assertion ».

### 2.4 Bouchonnage déclaratif : `given.network`

**Pourquoi.** Tester les états d'erreur/vide/lent — inaccessibles avec un
backend sain. C'est ce qui permet de « tester chaque fonctionnalité de l'UI »
(bannières 500, squelettes, listes vides).

**Design.**
- `src/scenario/types.ts` : `Given` +=
  ```ts
  network?: Array<{
    match: { url: string; method?: string };      // url = contains
    respond?: { status: number; body?: string; contentType?: string; delayMs?: number };
    abort?: true;                                  // respond XOR abort
  }>
  ```
  Déclaré dans le YAML (revu en revue de code, comme tout le scénario).
- Contrat : `Driver.stubNetwork?(rules): Promise<void>` + capability. Web :
  `context.route()` par règle (contains → `**/*` + filtre par URL dans le
  handler), `route.fulfill`/`route.abort`, delay via `setTimeout`.
- Ordre d'installation : `launch` → `applyState` → `stubNetwork` → première étape.
  Le `resolve` (génération) doit installer les mêmes règles — sinon le modèle
  résout contre un écran que le rejeu ne reverra jamais.
- `qai check` : rien à faire (scénario seul).
- Docs : nouvel encart dans `docs/etats.md` + exemple `examples/erreur-serveur.qai.yaml`
  sur la fixture.

**Compat.** Additif (clé optionnelle). **Tests.** e2e fixture : stub 500 sur
l'API du panier → assertion sur le message d'erreur UI ; stub delayMs → assertion
sur l'état de chargement.

---

## PHASE 3 — Observation complète & axes d'environnement

> ⚠️ Cette phase modifie l'arbre observé → **bump `version: 2`** des résolutions
> (le loader lit 1 et 2) + note de release « lancer une passe de vérification
> des suites existantes après mise à jour ».

### 3.1 Vocabulaire de rôles élargi

**Design.** Ajouter à `Role` (`src/driver/types.ts`) : `status` (toasts),
`tooltip`, `spinbutton` (input number), `tree`, `treeitem`, `grid`, `region`,
`toolbar`. Mettre à jour, de façon cohérente, les 5 endroits :
1. `EXPLICIT` + `implicitRole` (`observe-script.ts`) — `input[type=number]` →
   `spinbutton` ; `role=status`/`output` → `status` ;
2. `NAME_FROM_CONTENT` : + `status`, `tooltip`, `treeitem` ;
3. `ARIA` map (`driver/web/locator.ts`) : tous ont un équivalent ARIA direct ;
4. `ROLES` (`generate/schema.ts`) ;
5. `docs/driver.md` (tableau de correspondance, y compris mobile prévu).

**Compat.** Risque réel : un élément aujourd'hui classé `group`/`text` peut
changer de rôle → un locator existant peut devenir orphelin ou ambigu.
D'où le bump v2 + passe de vérification (R6). Ne PAS retirer de rôle existant.

### 3.2 Shadow DOM dans l'observation

**Design.** `collectTree` : si `el.shadowRoot` existe (mode open), descendre
dans `shadowRoot.children` comme des enfants normaux (aplatis, pas de nœud
« shadow »). Playwright perce déjà le shadow à la résolution — ce changement
aligne ce que le modèle VOIT sur ce que le vérificateur TROUVE (l'écart actuel
rend les web components irrésolvables, cf. commentaire accname du fichier).

**Compat.** Arbre enrichi → mêmes précautions que 3.1 (v2).
**Tests.** observe-script sur un DOM avec custom element + shadow root
(le test tourne déjà sur DOM factice — vérifier que l'environnement de test
supporte attachShadow, sinon test Playwright).

### 3.3 Iframes

**L'item le plus lourd — le découper.**
- **Observation** : depuis le script de page, seuls les frames same-origin sont
  lisibles (`contentDocument`). Stratégie : le DRIVER orchestre —
  `page.frames()`, exécute le collecteur dans chaque frame, greffe chaque
  sous-arbre sous le nœud iframe correspondant de l'arbre principal
  (correspondance par URL du frame). Cross-origin : nœud `iframe` avec nom
  (title/aria-label) mais sans enfants + note dans le rendu.
- **Ciblage** : `Locator` += `frame?: string` (fragment d'URL du frame).
  `buildLocator` : si `frame` présent → `page.frameLocator(...)` comme scope.
  Schéma resolve : exposer `frame` avec description.
- **Portabilité** : documenter dans `docs/driver.md` que `frame` est ignoré
  (ou erreur de planification) sur mobile — il vit dans la résolution web,
  ce qui est le bon endroit pour un détail plateforme (même logique que
  `PlatformFallback`).

**Compat.** v2 ; `frame` optionnel. **Tests.** fixture avec iframe same-origin
(formulaire dedans) : observe le voit, resolve/act le ciblent.

### 3.4 `stateIs` étendu + nouveaux checks

**Design.**
- `stateIs` : `value` accepte aussi `'expanded' | 'focused'` (les deux existent
  déjà dans `NodeState`). `STATE_LABEL` (assert.ts) + schéma.
- Nouveaux checks : `countEquals`, `countAtMost` (états vides !),
  `numberAtLeast`, `numberGreaterThan`, `valueEquals` (compare `node.value`
  strictement, pour les champs de formulaire).
- Captures : `extract` += `'url'` → valeur = `location` courante (le `from`
  devient optionnel pour ce kind ; adapter `CaptureSpec` et le schéma).

**Compat.** Additif (R1). **Tests.** table de vérité dans assert.test.ts.

### 3.5 Axes d'émulation par scénario

**Design.**
- `Scenario` += `emulate?: { viewport?: 'desktop'|'tablet'|'mobile'|{width,height};
  colorScheme?: 'light'|'dark'; locale?: string; timezone?: string;
  reducedMotion?: boolean }`. Presets : desktop 1280×800 (défaut actuel — gelé),
  tablet 820×1180, mobile 390×844.
- `LaunchTarget` porte déjà `viewport` ; l'étendre avec les autres options,
  le driver web les passe à `newContext`.
- **Résolutions par variante** : si `emulate.viewport` ≠ défaut, le chemin
  devient `<id>.web-mobile.json` etc. (la mise en page change → le cache doit
  changer). `resolutionPathFor` (cli.ts) encode la variante. Un scénario sans
  `emulate` garde `<id>.web.json` (R2).
- CLI : `--browser chromium|firefox|webkit` (défaut chromium, R2) — les
  résolutions étant sans sélecteur, elles rejouent telles quelles sur les
  trois moteurs ; le README doit le vendre.

**Compat.** Tout optionnel, défauts gelés. **Tests.** e2e viewport mobile sur la
fixture (menu burger vs barre).

### 3.6 `settle()` v2

**Design.** Remplacer le cœur `waitForLoadState('networkidle')` (documenté
« discouraged » par Playwright ; le commentaire SSE du code actuel décrit déjà
la faille) par :
1. compteur de requêtes en vol injecté dans l'init script existant (patch de
   `fetch` + `XMLHttpRequest`), en excluant les connexions longues (SSE/WS) ;
2. attendre vol = 0 **puis** fenêtre de silence DOM de ~150 ms via
   MutationObserver, le tout plafonné par `timeoutMs` ;
3. conserver le double `requestAnimationFrame` final.
Garder l'ancien comportement en repli si l'injection a échoué (page about:blank…).

**Compat.** Changement de timing pur — les résolutions ne changent pas. Passer
la suite fixture + tilmischool ; attendu : MOINS de flakes (l'`assertTimeout`
20000 de tilmischool doit pouvoir redescendre).
**Tests.** fixture avec fetch retardé + mutation tardive : settle attend ;
SSE simulé : settle n'attend pas indéfiniment.

### 3.7 Anti-flake : animations, horloge, scroll

**Design.**
- Config `disableAnimations?: boolean` (défaut **false**, R4) : émulation
  `reducedMotion: 'reduce'` + init-script CSS
  `*, *::before, *::after { animation: none !important; transition: none !important; }`.
- `--slow-mo <ms>` CLI (debug avec `--headed`).
- Auto-scroll sur `not-visible` : dans `performActions` (`run.ts`), quand
  `resolve` rend `not-visible`, tenter `scrollTo` sur la cible + re-resolve
  AVANT settle/heal (docs/driver.md le prescrit déjà, le moteur ne le fait pas).

**Compat.** Opt-in / amélioration pure. **Tests.** cible sous la ligne de
flottaison dans la fixture : passe sans heal.

### 3.8 Robustesse d'exécution : retries, shard, timeout d'étape

**Design.**
- `--retries <n>` (défaut 0, R2) : re-lancer un scénario ÉCHOUÉ avec un driver
  neuf ; s'il passe → statut **`flaky`** (nouveau `ScenarioStatus`, visible
  partout comme `healed` — jamais un vert silencieux ; `--strict` le fait
  échouer aussi). `SuiteReport.status` : flaky ne rend pas la suite failed.
- `--shard i/n` : découpage déterministe de la liste triée des items.
- `stepTimeoutMs` (config, défaut 30000 = timeout Playwright actuel) : borne
  `performActions` + évaluation par étape (via AbortSignal/course de promesses).

**Compat.** Défauts = comportement actuel. **Tests.** suite.test.ts : flaky,
shard (partition stable), timeout.

---

## PHASE 4 — Produit & IA

### 4.1 Canal de refus du réparateur

**Pourquoi.** `healProposalSchema` FORCE une cible : quand l'élément a réellement
disparu (vraie régression), le modèle doit proposer quelque chose, la
vérification rejette, les tentatives brûlent, et le rapport dit « réparation
impossible » au lieu de « l'élément n'existe plus ».

**Design.** `src/generate/schema.ts` : le schéma devient un `oneOf` —
`{ target, note }` (inchangé) OU `{ verdict: 'gone', note }`. `ModelHealer` :
sur `gone`, rendre `{ healed: false, reason: "le modèle confirme la disparition — " + note }`
SANS retry. `HEAL_SYSTEM_PROMPT` : remplacer « mieux vaut échouer » par
l'instruction d'utiliser `verdict: gone`. Le moteur formate ce cas distinctement
(c'est un signal de régression, plus fort qu'un échec technique).
**Invariant 1 intact** : toujours ni assertion ni action dans le schéma.

**Tests.** ModelHealer.test.ts avec provider scripté rendant `gone`.

### 4.2 Repli vision du réparateur

**Pourquoi.** Déjà conçu, jamais branché : `ModelContent` supporte l'image,
`rect` est obligatoire « pour le futur repli vision », et `run.ts` capture DÉJÀ
le screenshot pour la requête de heal — `ModelHealer` l'ignore.

**Design.** Option `heal.vision: boolean` (config, défaut **false**, R4).
Si actif : à partir de la **2e** tentative (la 1re reste texte-seule = moins
chère), joindre `request.snapshot.screenshot` en `ModelContent` image.
Prompt : une ligne (« une capture d'écran est jointe ; l'arbre fait foi pour les
noms, l'image pour la disposition »). Budget : inchangé (le provider compte).

**Tests.** provider scripté vérifiant la présence du bloc image en tentative 2.

### 4.3 Économie de jetons du heal : sous-arbre d'abord

**Design.** Tentative 1 : `renderTree` du **conteneur** de la cible perdue
(remonter au premier ancêtre nommé dans l'arbre autour du dernier locator
connu — utiliser `within` du locator s'il existe, sinon la région englobante) ;
plein arbre seulement à partir de la tentative 2. Mesurer avec
`scripts/measure-tree.ts` avant/après et noter les chiffres dans le commit.

### 4.4 Reporter HTML autonome

**Design.** `src/report/html.ts` → `--format html` : un seul fichier
auto-suffisant (CSS inline, screenshots en base64 data:) : liste des scénarios
avec statuts trois-états (+flaky), par étape : intention, durée, échecs
d'assertion, warnings, notes de heal, screenshot d'échec, dernières entrées
réseau/console (Phase 2), arbre observé à l'échec (details/summary).
Pas de JS externe (CSP-friendly). C'est le pendant local du commentaire de PR.

### 4.5 `qai init`

**Design.** Nouvelle commande : génère `qai.config.json`, `qa/exemple.qai.yaml`
(sur la home de l'app), `qa/provider.ts` (squelette commenté copié
d'`examples/provider-exemple.ts`), `qa/states.ts` (squelette), et ajoute
`.qai/artifacts/` au `.gitignore` s'il existe. Refuse d'écraser des fichiers
existants. Un écran de sortie qui donne les 3 commandes suivantes.

### 4.6 `qai coverage`

**Design.** Nouvelle commande : crawl borné (même domaine, profondeur/nb pages
configurables) avec le driver + `observe({ interactiveOnly: true })` ;
inventaire des écrans (URL normalisée) et des nœuds interactifs (rôle+nom).
Croisement avec les résolutions chargées : quels écrans/éléments aucun parcours
ne touche. Sortie text + json. Zéro appel modèle. Auth via `--states` + un état
nommé (réutilise l'infra existante).

### 4.7 `qai explore`

**Design.** Sur les écrans non couverts (sortie de 4.6), boucle modèle
« propose 1–3 parcours plausibles pour cet écran » → écrit des **brouillons**
`qa/drafts/<id>.qai.yaml` (jamais directement dans `qa/`) avec un en-tête
`# BROUILLON généré — à relire`. Budget obligatoire (`--max-cost` requis pour
cette commande). L'humain relit, déplace, puis `qai resolve`.

### 4.8 Providers : routage & cache

**Design.** Dans `examples/` (pas dans le cœur) :
- `provider-router.ts` : ModelProvider qui délègue à un provider « rapide » et
  bascule sur un « fort » quand l'appelant re-tente (détectable : la
  conversation contient un message de rejet) — interface inchangée.
- Mettre à jour `provider-claude.ts` pour poser `cache_control` sur le bloc
  système (le `system` de QAI est stable par design — le commentaire de
  `model/types.ts` l'annonce) et remonter `cachedInputTokens`.

### 4.9 i18n des messages (anglais par défaut)

**Le plus gros chantier cosmétique — le faire en dernier de phase.**
Extraire TOUS les textes runtime (erreurs, rapports, prompts système, marques
d'état de `render.ts`) dans un catalogue (`src/i18n/fr.ts`, `en.ts` ; fonction
`t()` sans dépendance). Défaut **en** pour le produit npm, `--lang fr` / config.
⚠️ Ne JAMAIS toucher au contenu des scénarios/résolutions des utilisateurs
(clés d'assertion = texte exact de l'utilisateur, peu importe la langue).
Les prompts anglais nécessitent une passe de test du resolve sur la fixture.

### 4.10 Éclatement en workspaces (dernier)

**Quand :** au démarrage du driver mobile, pas avant.
```
packages/
  qai-core/        # engine, scenario, resolution, match, assert, consistency,
                   # model (contrat+budget), state — ZÉRO dépendance playwright
  qai-driver-web/  # PlaywrightWebDriver + observe-script + locator (dep playwright)
  qai-cli/         # cli, config, reporters, artifacts — publié sous « tilmiqai » (R5)
  qai-action/      # action GitHub
```
`tilmiqai` ré-exporte core+driver-web+cli (compat totale : bin `qai`, types).
Vérifier `cli.pack.test.ts` après.

---

## Hors périmètre QAI (dépôts voisins — à faire à part)

1. **Déplacer** `scripts/probe-tilmischool.ts` → `tc_tilmischool_ui/qa/tools/`
   (un produit générique ne doit nommer aucune app cliente) ; supprimer les
   captures tilmischool de `QAI/.qai/artifacts/`.
2. `tc_tilmischool_ui/qa/README.md` : corriger la section cookies — le type
   `Cookie` supporte `secure`/`sameSite` désormais (states.ts les utilise déjà) ;
   les parcours peuvent migrer vers `given: { state: direction-connectee }`.
3. 37 des 53 scénarios tilmischool n'ont pas de résolution → les résoudre
   (provider branché, ou à la main via la sonde). `{{env.*}}` (item 1.2)
   débloque les scénarios de login ; `urlContains` (1.1) débloque
   `auth-routes-protegees`.

---

## Ordre d'exécution recommandé

| Lot | Items | Risque | Sortie visible |
|---|---|---|---|
| A | 1.8, 1.9, 1.1, 1.2, 1.3, 1.4 | nul | version+API+URL+env+tags+JUnit |
| B | 1.7, 1.10, 1.5, 1.6 | faible | messages « plus proches », dialogues, upload |
| C | 2.1, 2.2 | faible (opt-in) | réseau/console dans les rapports + watchdogs |
| D | 2.4 puis 2.3 | moyen | états d'erreur testables, action api |
| E | 3.4, 3.7, 3.6 | moyen | checks étendus, anti-flake, settle v2 |
| F | 3.1, 3.2 (v2), puis 3.3 | élevé — passe de vérif obligatoire | arbre complet |
| G | 3.5, 3.8 | faible | émulation, retries/shard |
| H | 4.1→4.8 dans l'ordre | faible | heal meilleur marché et plus juste, HTML, init, coverage/explore |
| I | 4.9, 4.10 | structurel | i18n, monorepo |

Chaque lot se termine par le rituel R6. Un item = un commit français descriptif.
