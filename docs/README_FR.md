<h1 align="center">
  <img src="Logo.png" alt="MindZJ logo" width="64" height="64" /><br>
  MindZJ — Système de notes hors-ligne open-source, natif IA et pensé pour le CLI
</h1>

<p align="center">
  <em>Une application de prise de notes locale entièrement open-source, qui s’inspire de <a href="https://obsidian.md">Obsidian</a> et pousse plus loin l’intégration IA, les workflows CLI et le sandboxing des plugins.</em>
</p>

<p align="center">
  <a href="#fonctionnalités">Fonctionnalités</a> •
  <a href="#installation">Installation</a> •
  <a href="#démarrage-rapide">Démarrage rapide</a> •
  <a href="#raccourcis-clavier">Raccourcis</a> •
  <a href="#cli">CLI</a> •
  <a href="#développement">Développement</a> •
  <a href="#licence">Licence</a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/licence-AGPL--3.0-green" alt="License" />
  <img src="https://img.shields.io/badge/Tauri-2.0-purple" alt="Tauri" />
  <img src="https://img.shields.io/badge/Plateforme-Windows%20%26%20macOS%20%26%20Linux-orange" alt="Platform" />
</p>

<p align="center">
  <strong>🌐 Autres langues :</strong>
  <a href="../README.md">English</a> |
  <a href="README_ZH.md">中文</a> |
  <a href="README_JA.md">日本語</a> |
  <a href="README_FR.md">Français</a> |
  <a href="README_DE.md">Deutsch</a> |
  <a href="README_ES.md">Español</a>
</p>

---

<p align="center">
  <a href="https://www.buymeacoffee.com/superjohn">
    <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee" />
  </a>
  &nbsp;
  <a href="https://ko-fi.com/superjohn">
    <img src="https://img.shields.io/badge/Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi" />
  </a>
  &nbsp;
  <a href="https://paypal.me/TanCat997">
    <img src="https://img.shields.io/badge/PayPal-0070ba?style=for-the-badge&logo=paypal&logoColor=white" alt="PayPal" />
  </a>
</p>

<p align="center">Si MindZJ vous est utile, pensez à soutenir le projet</p>

---

## Aperçu

<p align="center">
  <img src="../docs/mindzj.gif" alt="Interface principale de MindZJ" width="800" />
  <br/>
  <em>Édition Markdown avec prévisualisation en direct, backlinks et palette de commandes</em>
</p>

<p align="center">
  <img src="../docs/img01.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>Interface principale de MindZJ</em>
</p>

<p align="center">
  <img src="../docs/img02.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>Formules mathématiques</em>
</p>

<p align="center">
  <img src="../docs/img03.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>Bases du Markdown dans MindZJ</em>
</p>

<p align="center">
  <img src="../docs/img04.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>Plugins MindZJ</em>
</p>

---

## Fonctionnalités

### Cœur

- **Entièrement hors ligne, local d’abord** — MindZJ est une application de notes entièrement hors ligne. Chaque note est un fichier `.md` stocké dans votre Vault, sur votre propre disque ; toutes les données restent en local et ne sont jamais envoyées sur un serveur
- **IA native** — Ollama (hors ligne), Claude et OpenAI sont intégrés directement dans le noyau Rust
- **CLI d’abord** — une interface en ligne de commande complète, pensée pour les pipes, les scripts et les chaînes d’outils IA
- **Léger** — basé sur Tauri 2.0 (~10 Mo) plutôt qu’Electron (~150 Mo)
- **Multiplateforme** — Windows, macOS, Linux, iOS et Android depuis une seule base de code
- **Sandbox de plugins** — les plugins tournent dans des WebWorkers avec des permissions déclaratives, plus sûr qu’Obsidian

### Édition

- **Trois modes** — aperçu en direct, source et lecture, basculés instantanément avec `Ctrl+E`
- **Markdown intégral** — titres, listes, tables, blocs de code, maths (KaTeX), callouts, diagrammes Mermaid
- **Continuation intelligente des listes** — `Enter` prolonge la liste, `Tab` / `Shift+Tab` pour indenter
- **Collage d’images** — les images du presse-papiers sont sauvegardées dans le Vault et insérées automatiquement
- **Sauvegarde atomique** — écriture temporaire → fsync → rename, aucune perte de données en cas de coupure
- **Instantanés** — chaque modification génère un snapshot horodaté, retour arrière à tout moment

### Navigation

- **Liens wiki** — syntaxe `[[note]]` avec autocomplétion et backlinks
- **Plan** — sautez d’un titre à l’autre en un clic
- **Recherche plein texte** — propulsée par le moteur Rust `tantivy`, instantanée même sur de gros Vaults
- **Palette de commandes** — `Ctrl+P` pour exécuter n’importe quelle action
- **Onglets et fractionnement** — clic droit sur un onglet pour fractionner à droite, à gauche, en haut ou en bas
- **Arborescence** — glisser-déposer, ordre personnalisé, dossiers épinglés

### Cartes mentales

- **Format natif `.mindzj`** — éditeur de cartes mentales intégré en tant que plugin par défaut
- **Connexions arc-en-ciel, glisser-déposer, copier / couper / coller** — toutes les fonctions du plugin MindZJ indépendant sont disponibles ici

### Internationalisation

- **6 langues livrées d’origine** — English, 简体中文, 日本語, Français, Deutsch, Español

### Personnalisation

- **Thèmes** — clair / sombre / système, avec des variables CSS surchargeable par Vault
- **Raccourcis** — réassignez chaque action via un enregistreur visuel dans les paramètres
- **Plugins** — installez des plugins communautaires ou écrivez les vôtres grâce à l’API compatible Obsidian

---

## Installation

### Binaires pré-compilés

> _Bientôt disponibles — téléchargez le dernier installeur sur [GitHub Releases](https://github.com/zjok/mindzj/releases)._

### Compilation depuis les sources

```bash
git clone https://github.com/zjok/mindzj.git
cd mindzj
npm install
npm run tauri:build
```

L’installeur se trouvera dans `src-tauri/target/release/bundle/`.

### Prérequis

- [Rust](https://rustup.rs/) ≥ 1.77
- [Node.js](https://nodejs.org/) ≥ 20 LTS
- [Prérequis Tauri 2.0](https://v2.tauri.app/start/prerequisites/)

---

## Démarrage rapide

1. Lancez MindZJ et choisissez un dossier comme Vault
2. Appuyez sur `Ctrl+N` pour créer une note, ou déposez des fichiers `.md` existants dans le dossier
3. Commencez à taper — le Markdown s’affiche en direct
4. Utilisez `[[wiki-link]]` pour relier vos notes
5. Ouvrez la palette de commandes avec `Ctrl+P` pour trouver n’importe quelle action
6. Basculez le mode d’affichage avec `Ctrl+E` — aperçu → source → lecture → aperçu
7. Ouvrez les paramètres avec `Ctrl+,` pour tout personnaliser

---

## Raccourcis clavier

Tous les raccourcis sont modifiables dans **Paramètres → Raccourcis**.

| Action                  | Défaut                  |
| ----------------------- | ----------------------- |
| Nouvelle note           | `Ctrl + N`              |
| Enregistrer             | `Ctrl + S`              |
| Palette de commandes    | `Ctrl + P`              |
| Basculer le mode        | `Ctrl + E`              |
| Basculer la barre       | `Ctrl + \``             |
| Paramètres              | `Ctrl + ,`              |
| Recherche dans le Vault | `Ctrl + Shift + F`      |
| Recherche dans la note  | `Ctrl + F`              |
| Liste de tâches         | `Ctrl + L`              |
| Gras                    | `Ctrl + B`              |
| Italique                | `Ctrl + I`              |
| Code en ligne           | `Ctrl + Shift + E`      |
| Titre 1–6               | `Ctrl + 1` … `Ctrl + 6` |
| Zoom texte éditeur      | `Ctrl + molette`        |
| Zoom UI                 | `Ctrl + =` / `Ctrl + -` |
| Capture d’écran         | `Alt + G`               |

---

## CLI

MindZJ est fourni avec un outil CLI `mindzj` indépendant qui partage le même noyau Rust que l’application desktop.

```bash
# Ouvrir un Vault
mindzj vault open ~/my-notes

# Créer, lister, rechercher, lire des notes
mindzj note create "Ma nouvelle note"
mindzj note list
mindzj note search "mot-clé"
mindzj note read "Ma nouvelle note" | grep "TODO"

# Intégration IA
mindzj config api-key create
mindzj ai ask "Où en est mon projet ?"
```

Toutes les opérations disponibles dans l’interface graphique le sont aussi en CLI — idéal pour les scripts, les imports en masse et les chaînes d’outils IA.

---

## Architecture

1. **Séparation noyau / UI** — toutes les opérations sur les fichiers passent par le noyau Rust
2. **Écriture atomique** — `fichier temporaire → fsync → rename` pour survivre aux coupures
3. **Protection contre le path traversal** — chaque chemin est validé par rapport à la racine du Vault
4. **Snapshots automatiques** — chaque édition est sauvegardée, vous pouvez toujours revenir en arrière
5. **Sandbox de plugins** — les plugins s’exécutent dans des WebWorkers avec un manifeste de permissions explicite

```
mindzj/
├── src-tauri/            # Backend Rust (noyau + commandes Tauri)
│   └── src/
│       ├── kernel/       # Cœur : vault, links, search, snapshots
│       └── api/          # Handlers de commandes Tauri
├── src/                  # Frontend SolidJS
│   ├── components/       # Composants UI
│   ├── stores/           # État réactif
│   └── plugin-api/       # Types de l’API plugin
├── cli/                  # CLI Rust indépendant
└── docs/                 # Documentation
```

### Pile technique

| Couche           | Technologie                     |
| ---------------- | ------------------------------- |
| Desktop / mobile | Tauri 2.0 (Rust + WebView)      |
| Frontend         | SolidJS + TypeScript            |
| Éditeur          | CodeMirror 6                    |
| Styling          | UnoCSS + variables CSS          |
| Recherche        | tantivy (recherche plein texte) |
| CLI              | Rust (clap)                     |

---

## Développement

```bash
# Installer les dépendances
npm install

# Application Tauri complète (backend Rust + frontend Vite + HMR)
npm run tauri:dev

# Uniquement le frontend
npm run dev

# Vérification des types
npm run typecheck

# Build de production
npm run tauri:build
```

---

## Soutenir le projet

Si MindZJ vous est utile, pensez à soutenir le projet :

<p align="center">
  <a href="https://www.buymeacoffee.com/superjohn">
    <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee" />
  </a>
  &nbsp;
  <a href="https://ko-fi.com/superjohn">
    <img src="https://img.shields.io/badge/Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi" />
  </a>
  &nbsp;
  <a href="https://paypal.me/TanCat997">
    <img src="https://img.shields.io/badge/PayPal-0070ba?style=for-the-badge&logo=paypal&logoColor=white" alt="PayPal" />
  </a>
</p>

---

## Licence

Ce projet est distribué sous la [GNU Affero General Public License v3.0](../LICENSE) (AGPL-3.0-or-later).

---

<p align="center">
  Fait avec ❤️ par <strong>SuperJohn</strong> · 2026.04
</p>
