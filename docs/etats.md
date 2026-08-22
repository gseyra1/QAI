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
| `cookies[].secure` · `.sameSite` | attributs du cookie posé | portés par la webview |
| `storage` | écrits dans `localStorage`, avant et après navigation | préférences de l'application |
| `entry` | point d'entrée imposé | lien profond |

C'est pourquoi le contrat ne parle pas de « cookies » à son plus haut niveau
mais d'**état préparé** : le vocabulaire doit rester exprimable sur mobile.

## Sessions inter-site

Si l'application testée et son API ne partagent pas le même site — un front sur
`localhost:3000` contre une API déployée, le cas courant en développement — la
session ne s'installe qu'avec les deux attributs :

```ts
return {
  cookies: [{
    name: 'session', value: token,
    domain: '.exemple.com', path: '/',
    secure: true, sameSite: 'None',
  }],
};
```

Omettre `sameSite` fait retomber le cookie sur « Lax » côté navigateur, qui
refuse alors de l'envoyer sur les requêtes vers l'API. Rien ne le signale : le
parcours démarre anonyme et échoue plusieurs étapes plus loin, sur une
assertion qui n'a rien à voir. Un cookie « SameSite=None » doit aussi être
« Secure », c'est une exigence du navigateur.

Les deux champs sont **omis** de l'appel quand vous ne les renseignez pas : le
navigateur applique alors ses propres défauts.

## Deux règles

**Un état nommé inconnu doit lever une erreur**, pas rendre un état vide. Un
parcours qui croit être connecté et ne l'est pas produit un échec incompréhensible
six étapes plus loin.

**L'état est réinstallé pour chaque parcours.** Chaque scénario obtient un
navigateur neuf, donc rien ne fuit de l'un à l'autre — un test vérifie
explicitement ce point.

## Les secrets : `{{env.NOM}}`

Passer par un état préparé évite la plupart des connexions par formulaire. Mais
quand c'est le formulaire lui-même qu'on veut prouver, il faut bien saisir un
mot de passe — et le fichier de résolution vit dans git.

Une valeur d'action peut donc référencer l'environnement :

```json
{ "kind": "fill", "target": { … }, "value": "{{env.QAI_PASS}}" }
```

Le fichier ne contient que le **template**. La valeur est lue dans
`process.env` au moment d'agir, au rejeu comme à la génération, et n'est jamais
réécrite dans un fichier. Une variable absente arrête l'étape en la nommant —
remplir un champ mot de passe avec du vide échouerait plus loin, sur un message
qui ne dirait rien de la cause.

Ce qui vient de `env.` est traité comme un secret : les rapports d'échec le
remplacent par `***`, y compris quand le message vient du driver. Un rapport de
test finit dans les journaux d'une CI.

À la génération, formulez l'intention en nommant la variable — « se connecter
avec QAI_USER et QAI_PASS » — et le modèle émettra le template plutôt qu'une
valeur inventée.

Le même mécanisme rend `{{capture}}` utilisable dans une saisie : recopier dans
un champ ce qu'une étape précédente a lu à l'écran.

## Les fixtures

Le champ `given.fixtures` est transmis tel quel à votre `prepare` : à vous d'y
répondre par un appel à votre API d'amorçage. QAI ne gère pas vos données de
test, il se contente de vous dire lesquelles le scénario réclame.
