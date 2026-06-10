# 🔒 Bizen HT — Déploiement de la sécurité

Ce guide explique **comment activer les protections** contre les fuites de données et les injections. Les fichiers `firestore.rules` et `storage.rules` sont dans le projet, mais **ils ne s'appliquent QUE quand tu les colles dans la console Firebase.** Tant que ce n'est pas fait, ta base peut être en « mode test » (ouverte à tous).

---

## ÉTAPE 1 — Vérifier l'état actuel (2 min)

1. Va sur https://console.firebase.google.com → projet **bizen-ht**.
2. Menu de gauche : **Firestore Database** → onglet **Règles** (Rules).
3. Regarde ce qui est écrit. Si tu vois quelque chose comme :
   ```
   allow read, write: if true;
   ```
   ou
   ```
   allow read, write: if request.time < timestamp.date(2025, ...);
   ```
   👉 **C'est CRITIQUE** : n'importe qui sur Internet peut lire/écrire toute ta base. Passe vite à l'étape 2.

---

## ÉTAPE 2 — Déployer les règles Firestore (5 min)

1. Console Firebase → **Firestore Database** → onglet **Règles**.
2. **Efface tout** le contenu de l'éditeur.
3. Ouvre le fichier `firestore.rules` (dans ce projet), **copie tout**, colle dans l'éditeur.
4. Clique **Publier** (Publish).
5. ✅ Attends le message de confirmation.

---

## ÉTAPE 3 — Déployer les règles Storage (3 min)

1. Console Firebase → **Storage** → onglet **Règles**.
2. **Efface tout**, copie le contenu de `storage.rules`, colle, **Publier**.
3. ✅ Cela empêche quelqu'un de téléverser/écraser les photos d'un autre, ou d'uploader des fichiers non-image.

---

## ÉTAPE 4 — Tester que le site marche encore (10 min)

Après publication, teste ces parcours avec un **compte de test** (pas l'admin) :

- [ ] Créer un compte → ça marche, l'e-mail de vérification arrive.
- [ ] Se connecter → le Dashboard s'affiche.
- [ ] Voir le catalogue d'Elu et les notes ⭐ → s'affichent.
- [ ] Faire une réservation → enregistrée.
- [ ] Ouvrir le chat d'une réservation → messages OK.
- [ ] Laisser un avis sur le site → message « en attente d'approbation ».
- [ ] Se connecter en **admin** (bizenht@gmail.com) → le panneau `/Vye` charge users, paiements, réservations.

Si un parcours casse, **dis-le-moi** avec le message d'erreur (touche F12 → onglet Console dans le navigateur) et je corrige.

---

## Ce que ces règles protègent

| Donnée | Avant | Après |
|---|---|---|
| E-mails / téléphones des users | lisibles par soi seul | ✅ inchangé (déjà privé) |
| **Réservations** (qui a réservé quel Elu) | tout utilisateur connecté | ✅ client + Elu concernés + admin |
| **Paiements** (références, montants) | tout utilisateur connecté | ✅ propriétaire + admin |
| Messages privés du chat | participants | ✅ inchangé (déjà privé) |
| **Avis du site** | — | ✅ public voit seulement les approuvés |
| **Médias** (photos/vidéos) | upload non contrôlé | ✅ propriétaire seul, images/vidéos, max 60 Mo |
| Collections oubliées | potentiellement ouvertes | ✅ fermées par défaut |

---

## ⚠️ Point restant (à durcir après le lancement)

Aujourd'hui, le statut **Premium** est activé côté navigateur après le paiement. Un utilisateur techniquement avancé pourrait se l'auto-attribuer. La vraie protection est de l'activer **côté serveur** via le webhook MonCash/Bazik (voir la tâche « Sécuriser le webhook »). Ce n'est pas une fuite de données — c'est un risque de contournement de paiement. On le traite juste après.

---

## MonCash / Bazik — tes données de paiement

- ✅ Les clés secrètes (`BAZIK_USER_ID`, `BAZIK_SECRET`, `BAZIK_WEBHOOK_SECRET`) sont dans les **variables d'environnement Netlify**, pas dans le code public. C'est correct.
- Vérifie dans **Netlify → Site settings → Environment variables** qu'elles y sont bien et ne sont jamais collées dans un fichier `.html` ou `.js` versionné.
