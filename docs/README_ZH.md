<h1 align="center">
  <img src="Logo.png" alt="MindZJ logo" width="64" height="64" /><br>
  MindZJ —— AI 原生、CLI 优先的开源离线笔记系统
</h1>

<p align="center">
  <em>一款完全开源的本地笔记软件，借鉴 <a href="https://obsidian.md">Obsidian</a> 的核心理念，在 AI 集成、CLI 操作和插件安全方面做出差异化突破。</em>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#安装方式">安装</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#快捷键">快捷键</a> •
  <a href="#cli-命令行">CLI</a> •
  <a href="#开发指南">开发</a> •
  <a href="#许可证">许可证</a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/版本-0.1.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/许可证-AGPL--3.0-green" alt="License" />
  <img src="https://img.shields.io/badge/Tauri-2.0-purple" alt="Tauri" />
  <img src="https://img.shields.io/badge/平台-Windows%20%26%20macOS%20%26%20Linux-orange" alt="Platform" />
</p>

<p align="center">
  <strong>🌐 其他语言：</strong>
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

<p align="center">如果 MindZJ 对你有帮助，欢迎支持本项目</p>

---

## 预览

<p align="center">
  <img src="../docs/mindzj.gif" alt="MindZJ 主界面" width="800" />
  <br/>
  <em>Markdown 实时预览、双向链接以及命令面板</em>
</p>

<p align="center">
  <img src="../docs/img01.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>MindZJ 主界面</em>
</p>

<p align="center">
  <img src="../docs/img02.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>数学公式</em>
</p>

<p align="center">
  <img src="../docs/img03.png" alt="MindZJ Demo" width="800" />
  <br/>
  <em>Markdown</em>
</p>

<p align="center">
  <img src="../docs/img04.png" alt="MindZJ Plugins" width="800" />
  <br/>
  <em>插件</em>
</p>

---

## 功能特性

### 核心

- **完全离线，本地优先** —— MindZJ 是一款彻底的离线笔记软件，所有笔记以纯 `.md` 文件存储在你本地磁盘的 Vault 中，全部数据都保存在本地，永远不会上传到任何服务器
- **AI 原生** —— 内核级 AI 集成，支持 Ollama（离线）、Claude、OpenAI
- **CLI 优先** —— 完整命令行接口，支持管道操作，便于脚本与 AI 工具链集成
- **轻量级** —— 基于 Tauri 2.0（安装包 ~10 MB），而非 Electron（~150 MB）
- **跨平台** —— 一套代码覆盖 Windows / macOS / Linux / iOS / Android
- **插件沙箱** —— 插件在 WebWorker 中隔离运行，权限声明制度，比 Obsidian 更安全

### 编辑

- **三种编辑模式** —— 实时预览、源码、阅读，按 `Ctrl+E` 即可切换
- **纯 Markdown** —— 标题、列表、表格、代码块、数学公式（KaTeX）、Callout、Mermaid 图表
- **智能列表续行** —— `Enter` 自动延续列表，`Tab` / `Shift+Tab` 缩进/取消缩进
- **剪贴板图片** —— 粘贴图片自动保存到 Vault 并插入引用
- **原子保存** —— 写临时文件 → fsync → rename，断电不丢数据
- **自动快照** —— 每次修改前自动备份，可随时回滚

### 导航

- **Wiki 链接** —— `[[笔记]]` 风格链接，支持自动补全和反向链接
- **大纲视图** —— 一键跳转到任意标题
- **全文搜索** —— Rust `tantivy` 引擎驱动，海量笔记依然秒级响应
- **命令面板** —— `Ctrl+P` 快速执行任意命令
- **标签页与分屏** —— 右键标签页可向左、右、上、下分屏
- **文件树** —— 拖放排序，自定义顺序，收藏文件夹

### 思维导图

- **原生 `.mindzj` 格式** —— 内置思维导图编辑器作为默认插件
- **彩虹连线、拖放、复制/剪切/粘贴** —— MindZJ 独立插件的全部功能在这里也都可用

### 国际化

- **开箱即用的 6 种语言** —— English、简体中文、日本語、Français、Deutsch、Español

### 自定义

- **主题** —— 浅色 / 深色 / 跟随系统，支持按 Vault 覆写 CSS 变量
- **快捷键** —— 在设置中可视化重绑每一个操作
- **插件** —— 可安装社区插件，也可基于 Obsidian 兼容的 API 自行开发

---

## 安装方式

### 预编译二进制

> _即将上线 —— 可在 [GitHub Releases](https://github.com/zjok/mindzj/releases) 下载最新安装包。_

### 从源码构建

```bash
git clone https://github.com/zjok/mindzj.git
cd mindzj
npm install
npm run tauri:build
```

构建产物位于 `src-tauri/target/release/bundle/`。

### 前置要求

- [Rust](https://rustup.rs/) ≥ 1.77
- [Node.js](https://nodejs.org/) ≥ 20 LTS
- [Tauri 2.0 prerequisites](https://v2.tauri.app/start/prerequisites/)

---

## 快速开始

1. 启动 MindZJ，选择一个目录作为你的 Vault
2. 按 `Ctrl+N` 创建新笔记，或把现有的 `.md` 文件拖进 Vault
3. 直接开始打字 —— Markdown 会实时渲染
4. 使用 `[[wiki-link]]` 在笔记之间建立连接
5. `Ctrl+P` 打开命令面板，直接搜索任意操作
6. `Ctrl+E` 切换视图模式 —— 实时预览 → 源码 → 阅读 → 实时预览
7. `Ctrl+,` 打开设置，按需自定义一切

---

## 快捷键

所有快捷键均可在 **设置 → 快捷键** 中重新绑定。

| 操作           | 默认快捷键              |
| -------------- | ----------------------- |
| 新建笔记       | `Ctrl + N`              |
| 保存           | `Ctrl + S`              |
| 命令面板       | `Ctrl + P`              |
| 切换视图模式   | `Ctrl + E`              |
| 切换侧边栏     | `Ctrl + \``             |
| 设置           | `Ctrl + ,`              |
| 全局搜索       | `Ctrl + Shift + F`      |
| 当前笔记内搜索 | `Ctrl + F`              |
| 任务列表       | `Ctrl + L`              |
| 加粗           | `Ctrl + B`              |
| 斜体           | `Ctrl + I`              |
| 行内代码       | `Ctrl + Shift + E`      |
| 标题 1–6       | `Ctrl + 1` … `Ctrl + 6` |
| 编辑器文字缩放 | `Ctrl + 鼠标滚轮`       |
| 界面缩放       | `Ctrl + =` / `Ctrl + -` |
| 截图           | `Alt + G`               |

---

## CLI 命令行

MindZJ 附带独立的 `mindzj` 命令行工具，与桌面应用共用同一个 Rust 内核。

```bash
# 打开 Vault
mindzj vault open ~/my-notes

# 创建、列出、搜索、读取笔记
mindzj note create "新笔记"
mindzj note list
mindzj note search "关键词"
mindzj note read "新笔记" | grep "TODO"

# AI 集成
mindzj config api-key create
mindzj ai ask "这个项目的进度如何？"
```

所有可以通过 GUI 执行的操作都可以在 CLI 中完成 —— 非常适合脚本化、批量导入和 AI 工具链。

---

## 架构原则

1. **内核与 UI 完全分离** —— 所有文件操作经过 Rust 内核，前端不直接访问文件系统
2. **原子写入** —— 每次保存都是 `写临时文件 → fsync → rename`，断电安全
3. **路径遍历防护** —— 所有路径都会校验是否在 Vault 根目录内
4. **自动快照** —— 每次修改前自动备份，可随时回滚
5. **插件沙箱** —— 插件在 WebWorker 中隔离运行，通过权限清单显式授权

```
mindzj/
├── src-tauri/            # Rust 后端（内核 + Tauri 命令）
│   └── src/
│       ├── kernel/       # 核心：vault、links、search、snapshots
│       └── api/          # Tauri 命令处理器
├── src/                  # SolidJS 前端
│   ├── components/       # UI 组件
│   ├── stores/           # 响应式状态
│   └── plugin-api/       # 插件 API 类型
├── cli/                  # 独立 Rust CLI
└── docs/                 # 文档
```

### 技术栈

| 层级          | 技术                        |
| ------------- | --------------------------- |
| 桌面/移动框架 | Tauri 2.0（Rust + WebView） |
| 前端          | SolidJS + TypeScript        |
| 编辑器        | CodeMirror 6                |
| 样式          | UnoCSS + CSS 变量           |
| 搜索          | tantivy（Rust 全文搜索）    |
| CLI           | Rust（clap）                |

---

## 开发指南

```bash
# 安装依赖
npm install

# 启动完整 Tauri 开发应用（Rust 后端 + Vite 前端 + HMR）
npm run tauri:dev

# 仅前端（不启动原生壳）
npm run dev

# 类型检查
npm run typecheck

# 生产构建
npm run tauri:build
```

---

## 支持项目

如果 MindZJ 对你有帮助，欢迎支持本项目：

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

## 许可证

本项目基于 [GNU Affero 通用公共许可证 v3.0](../LICENSE)（AGPL-3.0-or-later）发布。

---

<p align="center">
  由 <strong>SuperJohn</strong> 用 ❤️ 开发 · 2026.04
</p>
