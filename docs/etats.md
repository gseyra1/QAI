# L'état de départ d'un parcours

Un scénario ne construit pas son contexte à coups de clics : il le **déclare**.

```yaml
given:
  state: client-connecte
  fixtures: [catalogue-standard]
```

Se connecter par le formulaire au début de chaque parcours serait lent, fragile,
et ferait tester la page de connexion cinquante fois au lieu du parcours visé.

## Vous fournissez la traduction

QAI ne sait rien de votre authentification ni de vos données de test. Vous
implémentez `StateProvider` — une méthode — et QAI installe le résultat dans le
navigateur avant la première étape.

```ts
export default {
  async prepare(request: StateRequest): Promise<PreparedState> {
    if (request.given.state === 'client-connecte') {
      const { token } = await creerSessionDeTest(request.baseUrl);
      return { cookies: [{ name: 'session', value: token }] };
    }
    return {};
  },
} satisfies StateProvider;
```

```bash
npm run qai -- run qa/ --base-url $URL --states ./qa/states.ts
```

Partez de [examples/states-exemple.ts](../examples/states-exemple.ts).

## Ce que vous pouvez rendre

| Champ | Effet sur le web | Équivalent mobile prévu |
|---|---|---|
| `cookies` | posés sur le contexte du navigateur | stockage de la webview |
| `storage` | écrits dans `localStorage`, avant et après navigation | préférences de l'application |
| `entry` | point d'entrée imposé | lien profond |

C'est pourquoi le contrat ne parle pas de « cookies » à son plus haut niveau
mais d'**état préparé** : le vocabulaire doit rester exprimable sur mobile.

## Deux règles

**Un état nommé inconnu doit lever une erreur**, pas rendre un état vide. Un
parcours qui croit être connecté et ne l'est pas produit un échec incompréhensible
six étapes plus loin.

**L'état est réinstallé pour chaque parcours.** Chaque scénario obtient un
navigateur neuf, donc rien ne fuit de l'un à l'autre — un test vérifie
explicitement ce point.

## Les fixtures

Le champ `given.fixtures` est transmis tel quel à votre `prepare` : à vous d'y
répondre par un appel à votre API d'amorçage. QAI ne gère pas vos données de
test, il se contente de vous dire lesquelles le scénario réclame.
