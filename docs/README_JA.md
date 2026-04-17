<h1 align="center">
  <img src="Logo.png" alt="MindZJ logo" width="64" height="64" /><br>
  MindZJ — AI ネイティブ・CLI ファーストなオープンソースのオフラインノートシステム
</h1>

<p align="center">
  <em><a href="https://obsidian.md">Obsidian</a> の良さを受け継ぎつつ、AI 連携・CLI ワークフロー・プラグインサンドボックスをさらに一歩進めた、完全オープンソースのローカルノートアプリです。</em>
</p>

<p align="center">
  <a href="#機能">機能</a> •
  <a href="#インストール">インストール</a> •
  <a href="#クイックスタート">クイックスタート</a> •
  <a href="#キーボードショートカット">ショートカット</a> •
  <a href="#cli">CLI</a> •
  <a href="#開発">開発</a> •
  <a href="#ライセンス">ライセンス</a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/license-AGPL--3.0-green" alt="License" />
  <img src="https://img.shields.io/badge/Tauri-2.0-purple" alt="Tauri" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%26%20macOS%20%26%20Linux-orange" alt="Platform" />
</p>

<p align="center">
  <strong>🌐 他の言語:</strong>
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

<p align="center">MindZJ が役に立つと感じたら、ぜひサポートをご検討ください</p>

---

## プレビュー

<p align="center">
  <img src="../docs/mindzj.gif" alt="MindZJ メイン画面" width="800" />
  <br/>
  <em>Markdown のライブプレビュー、バックリンク、コマンドパレット</em>
</p>

<p align="center">
  <img src="../docs/img01.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>MindZJ メイン画面</em>
</p>

<p align="center">
  <img src="../docs/img02.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>数式</em>
</p>

<p align="center">
  <img src="../docs/img03.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>MindZJ Markdown の基礎</em>
</p>

<p align="center">
  <img src="../docs/img04.png" alt="MindZJMap Demo" width="800" />
  <br/>
  <em>MindZJ プラグイン</em>
</p>

---

## 機能

### コア

- **完全オフライン・ローカルファースト** — MindZJ は完全オフラインで動くノートアプリです。すべてのノートは `.md` ファイルとして自分のディスク上の Vault に保存され、すべてのデータはローカルに留まり、どのサーバーにもアップロードされません
- **AI ネイティブ** — Ollama（オフライン）/ Claude / OpenAI を Rust カーネルに直接統合
- **CLI ファースト** — パイプ処理もスクリプトも AI ツールチェーンとの連携もこなせる完全な CLI
- **軽量** — Electron（~150 MB）ではなく Tauri 2.0（インストーラ ~10 MB）
- **クロスプラットフォーム** — 単一のコードベースで Windows / macOS / Linux / iOS / Android に対応
- **プラグインサンドボックス** — プラグインは WebWorker で隔離され、権限宣言方式で Obsidian よりも安全

### 編集

- **3 つの編集モード** — ライブプレビュー、ソース、リーディング。`Ctrl+E` で瞬時に切替
- **フル Markdown** — 見出し、リスト、表、コードブロック、数式 (KaTeX)、Callout、Mermaid
- **スマートなリスト継続** — `Enter` でリスト継続、`Tab` / `Shift+Tab` でインデント
- **クリップボード画像の貼り付け** — 画像は自動で Vault に保存されて参照が挿入されます
- **アトミック保存** — 一時ファイル書き込み → fsync → rename。電源断でもデータを失いません
- **スナップショット** — 編集ごとにタイムスタンプ付きスナップショットを保存、いつでもロールバック可能

### ナビゲーション

- **Wiki リンク** — `[[note]]` スタイルで補完・バックリンクもサポート
- **アウトラインビュー** — 見出しをクリックで瞬時にジャンプ
- **全文検索** — Rust の `tantivy` エンジンにより巨大な Vault でも高速
- **コマンドパレット** — `Ctrl+P` で任意のコマンドを検索・実行
- **タブ & 分割** — タブを右クリックで右 / 左 / 上 / 下に分割
- **ファイルツリー** — ドラッグ & ドロップ、カスタムソート、ピン留め

### マインドマップ

- **ネイティブ `.mindzj` 形式** — 専用のマインドマップエディタを組み込みプラグインとして同梱
- **レインボー接続、ドラッグ & ドロップ、コピー / カット / ペースト** — 単体の MindZJ プラグインの機能すべてが使えます

### 多言語対応

- **標準で 6 言語** — English、简体中文、日本語、Français、Deutsch、Español

### カスタマイズ

- **テーマ** — ライト / ダーク / システム追従、Vault ごとに CSS 変数を上書き可能
- **ショートカット** — 設定画面のビジュアルレコーダーですべてのキーを再割り当て
- **プラグイン** — コミュニティプラグインの導入も、Obsidian 互換 API での自作も OK

---

## インストール

### ビルド済みバイナリ

> _近日公開 — [GitHub Releases](https://github.com/zjok/mindzj/releases) から最新インストーラを入手できます。_

### ソースからビルド

```bash
git clone https://github.com/zjok/mindzj.git
cd mindzj
npm install
npm run tauri:build
```

成果物は `src-tauri/target/release/bundle/` に生成されます。

### 前提条件

- [Rust](https://rustup.rs/) ≥ 1.77
- [Node.js](https://nodejs.org/) ≥ 20 LTS
- [Tauri 2.0 prerequisites](https://v2.tauri.app/start/prerequisites/)

---

## クイックスタート

1. MindZJ を起動し、Vault にしたいフォルダを選びます
2. `Ctrl+N` で新しいノートを作成するか、既存の `.md` ファイルを Vault に入れます
3. 入力を始めるだけ — Markdown がリアルタイムで描画されます
4. `[[wiki-link]]` でノート同士をリンク
5. `Ctrl+P` でコマンドパレットを開き、どんな操作も検索で実行
6. `Ctrl+E` で表示モード切替 — ライブプレビュー → ソース → リーディング → ライブプレビュー
7. `Ctrl+,` で設定画面を開き、自分好みにカスタマイズ

---

## キーボードショートカット

すべてのショートカットは **設定 → ホットキー** で再割り当て可能です。

| 操作               | デフォルト              |
| ------------------ | ----------------------- |
| 新しいノート       | `Ctrl + N`              |
| 保存               | `Ctrl + S`              |
| コマンドパレット   | `Ctrl + P`              |
| 表示モード切替     | `Ctrl + E`              |
| サイドバー切替     | `Ctrl + \``             |
| 設定               | `Ctrl + ,`              |
| Vault 内検索       | `Ctrl + Shift + F`      |
| ノート内検索       | `Ctrl + F`              |
| タスクリスト       | `Ctrl + L`              |
| 太字               | `Ctrl + B`              |
| イタリック         | `Ctrl + I`              |
| インラインコード   | `Ctrl + Shift + E`      |
| 見出し 1–6         | `Ctrl + 1` … `Ctrl + 6` |
| エディタ文字ズーム | `Ctrl + ホイール`       |
| UI ズーム          | `Ctrl + =` / `Ctrl + -` |
| スクリーンショット | `Alt + G`               |

---

## CLI

MindZJ にはデスクトップアプリと同じ Rust カーネルを使う単体 CLI `mindzj` が付属します。

```bash
# Vault を開く
mindzj vault open ~/my-notes

# ノートの作成 / 一覧 / 検索 / 読み取り
mindzj note create "新しいノート"
mindzj note list
mindzj note search "キーワード"
mindzj note read "新しいノート" | grep "TODO"

# AI 連携
mindzj config api-key create
mindzj ai ask "このプロジェクトの進捗は？"
```

GUI でできるカーネル操作はすべて CLI からも実行できます — スクリプトや一括インポート、AI ツールチェーン連携に最適です。

---

## アーキテクチャ

1. **カーネルと UI の完全分離** — ファイル操作はすべて Rust カーネル経由
2. **アトミック書き込み** — `一時ファイル → fsync → rename` で電源断にも耐える
3. **パストラバーサル対策** — すべてのパスを Vault ルートに対して検証
4. **自動スナップショット** — 編集ごとにバックアップ
5. **プラグインサンドボックス** — WebWorker で分離、明示的な権限宣言

```
mindzj/
├── src-tauri/            # Rust バックエンド（カーネル + Tauri コマンド）
│   └── src/
│       ├── kernel/       # コア: vault, links, search, snapshots
│       └── api/          # Tauri コマンドハンドラ
├── src/                  # SolidJS フロントエンド
│   ├── components/       # UI コンポーネント
│   ├── stores/           # リアクティブ状態
│   └── plugin-api/       # プラグイン API 型定義
├── cli/                  # 単体 Rust CLI
└── docs/                 # ドキュメント
```

### 技術スタック

| レイヤー                | 技術                       |
| ----------------------- | -------------------------- |
| デスクトップ / モバイル | Tauri 2.0 (Rust + WebView) |
| フロントエンド          | SolidJS + TypeScript       |
| エディタ                | CodeMirror 6               |
| スタイリング            | UnoCSS + CSS 変数          |
| 検索                    | tantivy (Rust 全文検索)    |
| CLI                     | Rust (clap)                |

---

## 開発

```bash
# 依存関係のインストール
npm install

# Tauri 開発アプリ（Rust バックエンド + Vite フロントエンド + HMR）
npm run tauri:dev

# フロントエンドのみ
npm run dev

# 型チェック
npm run typecheck

# プロダクションビルド
npm run tauri:build
```

---

## サポート

MindZJ が役に立つと感じたら、プロジェクトへのサポートをご検討ください:

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

## ライセンス

本プロジェクトは [GNU Affero General Public License v3.0](../LICENSE) (AGPL-3.0-or-later) のもとで提供されます。

---

<p align="center">
  Made with ❤️ by <strong>SuperJohn</strong> · 2026.04
</p>
