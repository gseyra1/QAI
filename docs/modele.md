# Brancher son propre modèle

QAI ne dépend d'aucun SDK de fournisseur et n'impose aucun modèle. Le client
implémente une interface à une méthode et l'injecte ; rien au-dessus ne sait
quel modèle tourne.

## L'interface

```ts
export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

Trois décisions rendent les fournisseurs réellement interchangeables.

**La sortie est structurée, jamais de la prose.** Chaque requête porte un
`responseSchema` et QAI attend un objet conforme. Il ne parse aucun texte libre.
N'importe quel modèle capable de sortie contrainte convient, sans une ligne de
code à changer — et le jour où le modèle répond à côté, l'échec est une erreur
de validation nette, pas un comportement erratique en aval.

**Le décompte de jetons est obligatoire.** `ModelResponse.usage` n'est pas
optionnel : la maîtrise des coûts est une contrainte de survie du produit (voir
la mesure locale), donc un fournisseur incapable de compter ses jetons ne
peut pas être branché. C'est ce qui permet d'imposer un plafond.

**Les images sont un type de contenu parmi d'autres.** Un fournisseur purement
textuel suffit pour tout le web, où l'arbre d'accessibilité porte l'information.
La vision ne devient nécessaire que pour le repli mobile.

Pas de diffusion en flux : QAI a besoin d'un objet complet, pas de jetons au fil
de l'eau.

## Exemple

```ts
import type { ModelProvider, ModelRequest, ModelResponse } from 'qai/model';

export class MonFournisseur implements ModelProvider {
  readonly name = 'mon-modele';

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const reponse = await appelerMonModele({
      system: request.system,
      messages: request.messages,
      schema: request.responseSchema,
      maxTokens: request.maxOutputTokens ?? 1024,
    });

    return {
      output: reponse.objet,
      usage: {
        inputTokens: reponse.jetonsEntree,
        outputTokens: reponse.jetonsSortie,
        cachedInputTokens: reponse.jetonsEnCache,
      },
    };
  }
}
```

## Poser un plafond

`BudgetedProvider` enveloppe n'importe quel fournisseur et coupe au premier des
trois plafonds atteint :

```ts
import { BudgetedProvider } from 'qai/model';

const provider = new BudgetedProvider(
  new MonFournisseur(),
  { inputPerMTok: 3, outputPerMTok: 15 },   // le tarif de votre modèle
  { maxCost: 2, maxCalls: 30 },             // par scénario
);
```

Le contrôle a lieu **avant** chaque appel, sur la dépense déjà constatée. Le
coût d'un appel n'étant connu qu'après coup, le plafond peut être dépassé d'un
appel au plus — refuser d'agir tant qu'on ne sait pas prédire le coût bloquerait
le produit. `provider.spend` expose le cumul à tout moment, et le rapport de
scénario le reprend.

## Choisir un modèle

Aucune recommandation imposée. L'écart de tarif entre modèles est réel, mais
**il pèse moins que la taille de l'arbre transmis** — c'est là que se joue la
facture. Mesurez la vôtre avec `npm run measure -- --url <votre-app>`.
