<h1 align="center">
  <img src="Logo.png" alt="MindZJ logo" width="64" height="64" /><br>
  MindZJ — Sistema de notas offline open-source, nativo para IA y orientado al CLI
</h1>

<p align="center">
  <em>Una aplicación de notas local totalmente open source que toma lo mejor de <a href="https://obsidian.md">Obsidian</a> y va más allá en integración de IA, flujos por CLI y sandboxing de plugins.</em>
</p>

<p align="center">
  <a href="#características">Características</a> •
  <a href="#instalación">Instalación</a> •
  <a href="#inicio-rápido">Inicio rápido</a> •
  <a href="#atajos-de-teclado">Atajos</a> •
  <a href="#cli">CLI</a> •
  <a href="#desarrollo">Desarrollo</a> •
  <a href="#licencia">Licencia</a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/versión-0.1.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/licencia-AGPL--3.0-green" alt="License" />
  <img src="https://img.shields.io/badge/Tauri-2.0-purple" alt="Tauri" />
  <img src="https://img.shields.io/badge/Plataforma-Windows%20%26%20macOS%20%26%20Linux-orange" alt="Platform" />
</p>


<p align="center">
  <strong>🌐 Otros idiomas:</strong>
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

<p align="center">Si MindZJ te resulta útil, considera apoyar el proyecto</p>

---

## Vista previa

<p align="center">
  <img src="../docs/mindzj.gif" alt="Interfaz principal de MindZJ" width="800" />
  <br/>
  <em>Edición Markdown con vista previa en vivo, backlinks y paleta de comandos</em>
</p>


---

## Características

### Núcleo

- **Totalmente offline, local primero** — MindZJ es una app de notas completamente offline. Cada nota es un archivo `.md` guardado en tu Vault, en tu propio disco; todos los datos permanecen en local y nunca se suben a ningún servidor
- **Núcleo nativo para IA** — Ollama (offline), Claude y OpenAI están integrados directamente en el kernel Rust
- **CLI primero** — una interfaz de línea de comandos completa, lista para pipes, scripts y cadenas de herramientas IA
- **Ligero** — construido sobre Tauri 2.0 (~10 MB) en lugar de Electron (~150 MB)
- **Multiplataforma** — Windows, macOS, Linux, iOS y Android con una única base de código
- **Sandbox de plugins** — los plugins corren en WebWorkers con permisos declarativos, más seguro que Obsidian

### Edición

- **Tres modos** — vista previa en vivo, código fuente y lectura; intercambio instantáneo con `Ctrl+E`
- **Markdown completo** — encabezados, listas, tablas, bloques de código, matemáticas (KaTeX), callouts, Mermaid
- **Continuación inteligente de listas** — `Enter` extiende la lista, `Tab` / `Shift+Tab` para indentar
- **Pegado de imágenes** — las imágenes del portapapeles se guardan en el Vault y se referencian automáticamente
- **Guardado atómico** — escritura temporal → fsync → rename, sin pérdidas de datos ante cortes
- **Snapshots** — cada cambio genera un snapshot con timestamp; puedes deshacer cuando quieras

### Navegación

- **Enlaces wiki** — sintaxis `[[nota]]` con autocompletado y backlinks
- **Vista de esquema** — salta entre encabezados con un clic
- **Búsqueda de texto completo** — impulsada por `tantivy` en Rust, instantánea incluso en Vaults grandes
- **Paleta de comandos** — `Ctrl+P` para lanzar cualquier acción
- **Pestañas y divisiones** — clic derecho en una pestaña para dividir a la derecha, izquierda, arriba o abajo
- **Árbol de archivos** — arrastrar y soltar, orden personalizado, carpetas fijadas

### Mapas mentales

- **Formato nativo `.mindzj`** — editor de mapas mentales incluido como plugin integrado
- **Conexiones arcoíris, drag & drop, copiar / cortar / pegar** — todas las funciones del plugin MindZJ independiente también están aquí

### Internacionalización

- **6 idiomas de fábrica** — English, 简体中文, 日本語, Français, Deutsch, Español

### Personalización

- **Temas** — claro / oscuro / sistema, con variables CSS sobrescribibles por Vault
- **Atajos** — reasigna cada acción mediante un grabador visual en la configuración
- **Plugins** — instala plugins de la comunidad o escribe los tuyos con la API compatible con Obsidian

---

## Instalación

### Binarios precompilados

> _Próximamente — descarga el instalador más reciente desde [GitHub Releases](https://github.com/zjok/mindzj/releases)._

### Compilar desde el código fuente

```bash
git clone https://github.com/zjok/mindzj.git
cd mindzj
npm install
npm run tauri:build
```

El artefacto se genera en `src-tauri/target/release/bundle/`.

### Prerequisitos

- [Rust](https://rustup.rs/) ≥ 1.77
- [Node.js](https://nodejs.org/) ≥ 20 LTS
- [Prerequisitos de Tauri 2.0](https://v2.tauri.app/start/prerequisites/)

---

## Inicio rápido

1. Abre MindZJ y elige una carpeta como Vault
2. Pulsa `Ctrl+N` para crear una nota nueva, o arrastra archivos `.md` existentes al Vault
3. Empieza a escribir — Markdown se renderiza en vivo
4. Usa `[[wiki-link]]` para enlazar tus notas
5. `Ctrl+P` abre la paleta de comandos para encontrar cualquier acción
6. `Ctrl+E` alterna el modo — vista previa → fuente → lectura → vista previa
7. `Ctrl+,` abre la configuración para personalizarlo todo

---

## Atajos de teclado

Todos los atajos se pueden reasignar en **Configuración → Atajos**.

| Acción                  | Predeterminado          |
| ----------------------- | ----------------------- |
| Nota nueva              | `Ctrl + N`              |
| Guardar                 | `Ctrl + S`              |
| Paleta de comandos      | `Ctrl + P`              |
| Alternar modo           | `Ctrl + E`              |
| Alternar barra lateral  | `Ctrl + \``             |
| Configuración           | `Ctrl + ,`              |
| Búsqueda en el Vault    | `Ctrl + Shift + F`      |
| Búsqueda en la nota     | `Ctrl + F`              |
| Lista de tareas         | `Ctrl + L`              |
| Negrita                 | `Ctrl + B`              |
| Cursiva                 | `Ctrl + I`              |
| Código en línea         | `Ctrl + Shift + E`      |
| Título 1–6              | `Ctrl + 1` … `Ctrl + 6` |
| Zoom texto del editor   | `Ctrl + rueda`          |
| Zoom UI                 | `Ctrl + =` / `Ctrl + -` |
| Captura de pantalla     | `Alt + G`               |

---

## CLI

MindZJ incluye una CLI independiente `mindzj` que comparte el mismo kernel Rust que la aplicación de escritorio.

```bash
# Abrir un Vault
mindzj vault open ~/my-notes

# Crear, listar, buscar, leer notas
mindzj note create "Mi nueva nota"
mindzj note list
mindzj note search "palabra clave"
mindzj note read "Mi nueva nota" | grep "TODO"

# Integración con IA
mindzj config api-key create
mindzj ai ask "¿Cómo va mi proyecto?"
```

Toda operación disponible en la interfaz gráfica también se puede ejecutar por CLI — ideal para scripting, importaciones masivas y cadenas de herramientas IA.

---

## Arquitectura

1. **Kernel / UI totalmente separados** — toda operación de archivo pasa por el kernel Rust
2. **Escritura atómica** — `archivo temporal → fsync → rename`, resiste cortes de luz
3. **Protección contra path traversal** — cada ruta se valida contra la raíz del Vault
4. **Snapshots automáticos** — cada edición se respalda; siempre puedes volver atrás
5. **Sandbox de plugins** — los plugins se ejecutan en WebWorkers con un manifiesto de permisos explícito

```
mindzj/
├── src-tauri/            # Backend Rust (kernel + comandos Tauri)
│   └── src/
│       ├── kernel/       # Núcleo: vault, links, search, snapshots
│       └── api/          # Handlers de comandos Tauri
├── src/                  # Frontend SolidJS
│   ├── components/       # Componentes de UI
│   ├── stores/           # Estado reactivo
│   └── plugin-api/       # Tipos de la API de plugins
├── cli/                  # CLI Rust independiente
└── docs/                 # Documentación
```

### Stack tecnológico

| Capa                 | Tecnología                       |
| -------------------- | -------------------------------- |
| Escritorio / móvil   | Tauri 2.0 (Rust + WebView)       |
| Frontend             | SolidJS + TypeScript             |
| Editor               | CodeMirror 6                     |
| Estilos              | UnoCSS + variables CSS           |
| Búsqueda             | tantivy (búsqueda Rust)          |
| CLI                  | Rust (clap)                      |

---

## Desarrollo

```bash
# Instalar dependencias
npm install

# Iniciar la app Tauri completa (backend Rust + frontend Vite + HMR)
npm run tauri:dev

# Solo el frontend
npm run dev

# Comprobación de tipos
npm run typecheck

# Build de producción
npm run tauri:build
```

---

## Apoyo

Si MindZJ te resulta útil, considera apoyar el proyecto:

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

## Licencia

Este proyecto se distribuye bajo la [GNU Affero General Public License v3.0](../LICENSE) (AGPL-3.0-or-later).

---

<p align="center">
  Hecho con ❤️ por <strong>SuperJohn</strong> · 2026.04
</p>
