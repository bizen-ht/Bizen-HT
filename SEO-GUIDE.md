# Guide SEO Bizen HT — Actions hors-code

Le SEO « on-page » (technique) est fait dans le code (meta tags, Open Graph, sitemap, robots, données structurées).
Ce qui suit doit être fait **à la main** par toi — c'est ce qui crée les **backlinks** et fait connaître le site de Google et des IA.

> ⚠️ **Réalité importante** : Bizen HT est un service pour adultes. Google l'indexera mais le filtrera sous **SafeSearch**. La plupart des **IA** (ChatGPT, Gemini, Perplexity) **ne recommandent pas** activement ce type de contenu — c'est un plafond qu'on ne peut pas dépasser, peu importe le SEO. La stratégie réaliste = **trafic direct, réseaux sociaux, bouche-à-oreille et annuaires de niche**, pas Google generic.

---

## 1. À FAIRE LE JOUR DU LANCEMENT (priorité absolue)

- [ ] **Google Search Console** — https://search.google.com/search-console
  - Ajouter la propriété `bizenht.com`, vérifier via DNS ou balise HTML.
  - Soumettre `https://bizenht.com/sitemap.xml`.
  - « Inspection d'URL » → demander l'indexation de la page d'accueil et de la FAQ.
- [ ] **Bing Webmaster Tools** — https://www.bing.com/webmasters (importe direct depuis Search Console). Bing alimente aussi **ChatGPT/Copilot**.
- [ ] **Vérifier le partage** : coller `https://bizenht.com` dans :
  - Facebook Debugger : https://developers.facebook.com/tools/debug/
  - Cliquer « Scrape Again » pour forcer le rafraîchissement de l'aperçu Open Graph.

## 2. PRÉSENCE SOCIALE = backlinks + autorité

Crée et remplis ces profils (chacun = un backlink + une source de trafic). Mets `bizenht.com` dans la bio :

- [ ] **Instagram** (@bizenht) — le plus important pour ce public
- [ ] **Facebook Page**
- [ ] **TikTok** (contenu soft/teasing autorisé par leurs règles)
- [ ] **X / Twitter** (autorise le contenu adulte si marqué sensible)
- [ ] **WhatsApp Business** + lien de catalogue
- [ ] **Telegram** (canal — très utilisé pour ce type de service)
- [ ] **Linktree / Beacons** regroupant tous les liens → backlink dofollow

> Mets le **même logo, même description** partout (cohérence de marque = signal pour Google).

## 3. BACKLINKS — annuaires & listings

- [ ] Annuaires d'escort/companions par pays (cherche « escort directory Haiti / Caribbean »).
- [ ] Annuaires d'entreprises haïtiennes / Caraïbes.
- [ ] Forums et groupes Facebook/Telegram pertinents (poste le lien là où c'est autorisé).
- [ ] Échange de liens avec des **hôtels partenaires** (ils sont déjà cités sur le site → demande un lien retour).
- [ ] Si un blog/article parle de vie nocturne en Haïti → propose un lien.

> **Qualité > quantité.** 5 backlinks de sites réels valent mieux que 100 liens spam (qui pénalisent).

## 4. CONTENU = carburant SEO long terme

- [ ] Garder la **FAQ riche** (déjà optimisée avec données structurées FAQPage).
- [ ] Ajouter un petit **blog/articles** plus tard : « Top zòn rankont Pòtoprens », « Kijan rete diskrè », etc. Le contenu textuel = ce que Google ET les IA lisent.
- [ ] Garder les **avis clients** (siteReviews) visibles → signal de confiance + texte indexable.

## 5. SUIVI

- [ ] Vérifier Search Console 1×/semaine : impressions, clics, mots-clés, erreurs d'indexation.
- [ ] Google Analytics ou Plausible pour le trafic réel.

---

## Ce qui est DÉJÀ fait dans le code ✅

- `robots.txt` (autorise pages publiques, bloque admin/dashboard/profil)
- `sitemap.xml` (accueil + FAQ)
- `llms.txt` (description du site pour les IA)
- Titres SEO + meta descriptions (Kreyòl + Français)
- Open Graph + Twitter Cards (aperçus WhatsApp/Facebook) sur accueil, FAQ, profil
- Canonical URLs
- Données structurées JSON-LD : Organization, WebSite, Service (accueil) + FAQPage (FAQ)
- `noindex` sur les pages privées (Admin, Dashboard, profil Elu)

## Limite connue : aperçu de partage par Elu
Les aperçus WhatsApp/Facebook **par profil Elu** (photo + nom spécifiques) ne marchent PAS encore :
les robots de WhatsApp/FB **ne lisent pas le JavaScript**, donc ils voient l'aperçu générique Bizen HT.
Pour un aperçu personnalisé par Elu, il faudrait une **Netlify Edge Function** qui injecte les
balises Open Graph côté serveur selon le code de l'Elu. → tâche post-lancement.
