# Restauration Bizen HT — comment remonter à partir des backups R2

Les backups sont sur **Cloudflare R2**, bucket `bizen-backups`, produits chaque
nuit par `.github/workflows/backup.yml`. Structure :

```
bizen-backups/
├── firestore/<DATE>/        ← export natif Firestore (dossier complet)
├── auth/auth-users-<DATE>.json
└── storage/                 ← miroir des médias (photos, stories…)
```

> ⚠️ En cas de suspension du compte Google/Firebase, tu remontes sur un
> **NOUVEAU projet Firebase** (ou chez un autre fournisseur). Les 3 briques se
> restaurent séparément.

---

## 0. Récupérer un backup depuis R2

```bash
# Configure rclone avec le remote r2 (mêmes clés que dans le workflow), puis :
rclone copy r2:bizen-backups/firestore/<DATE> ./restore/firestore
rclone copy r2:bizen-backups/auth ./restore/auth
rclone copy r2:bizen-backups/storage ./restore/storage
```

## 1. Restaurer Firestore

L'export est au **format natif**, donc il se réimporte directement. Il faut
d'abord le remettre dans un bucket GCS du projet cible, puis :

```bash
rclone copy ./restore/firestore gcs:<NOUVEAU_BUCKET>/firestore-restore
gcloud firestore import gs://<NOUVEAU_BUCKET>/firestore-restore \
  --project <NOUVEAU_PROJET>
```

## 2. Restaurer les comptes (Auth) — inclut les mots de passe

Le fichier garde les `passwordHash`/`salt` (scrypt Firebase) → les utilisateurs
se reconnectent avec leur mot de passe habituel.

```bash
firebase auth:import ./restore/auth/auth-users-<DATE>.json \
  --hash-algo=SCRYPT \
  --project <NOUVEAU_PROJET>
```

> Les paramètres scrypt (`signerKey`, `saltSeparator`, `rounds`, `memCost`) se
> lisent dans **Firebase Console → Authentication → ⋮ → Paramètres de hachage
> du mot de passe** du projet d'origine. **Note-les dès maintenant et garde-les
> hors ligne** : sans eux, les hash ne sont pas réutilisables. Si le projet
> d'origine est déjà perdu, les comptes doivent repasser par « mot de passe
> oublié ».

## 3. Restaurer les médias (Storage)

```bash
rclone sync ./restore/storage gcs:<NOUVEAU_BUCKET_STORAGE>
```

Puis mets à jour `storageBucket` dans `index.html` / `social.html` et la
variable `FIREBASE_SERVICE_ACCOUNT` (Netlify) avec le nouveau projet.

---

## À faire une fois, aujourd'hui (pré-catastrophe)

- [ ] Noter les **paramètres de hachage scrypt** du projet `bizen-ht` (étape 2) et les stocker hors ligne.
- [ ] Créer les 2 buckets (GCS `bizen-ht-backups`, R2 `bizen-backups`) + rétention 30 j sur R2.
- [ ] Ajouter les 5 secrets GitHub (voir en-tête de `backup.yml`).
- [ ] Lancer un backup manuel (Actions → Backup Bizen HT → Run workflow) et **tester une restauration** sur un projet Firebase jetable — un backup non testé n'est pas un backup.
