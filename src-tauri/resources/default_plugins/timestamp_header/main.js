const { Plugin } = require('obsidian');

module.exports = class TimestampPlugin extends Plugin {
	async onload() {

		// --- 功能 1: 插入时间戳 H2标签 例如 ## 260321 0121 ---
		// 快捷键由 MindZJ 设置面板统一管理（默认 Alt+F）
		// 触发路径：App.tsx 的全局 keydown -> pluginStore.executeCommandById
		// 直接调用本插件的 editorCallback，不再走 `mindzj:plugin-command`
		// CustomEvent — 之前那条路径在多次 vault reload 后会堆出重复的
		// document 监听器，一次 Alt+F 会插入 4 份时间戳。
		this.addCommand({
			id: 'insert-custom-timestamp',
			name: 'Insert H2 Timestamp',
			editorCallback: (editor, view) => {
				const now = new Date();
				const datePart = now.getFullYear().toString().slice(-2) +
					(now.getMonth() + 1).toString().padStart(2, '0') +
					now.getDate().toString().padStart(2, '0');
				const timePart = now.getHours().toString().padStart(2, '0') +
					now.getMinutes().toString().padStart(2, '0');
				// `## YYMMDD HHmm` + 单个换行 — 让后续输入默认落在下一行。
				const timestamp = `## ${datePart} ${timePart}\n`;
				editor.replaceSelection(timestamp);
			}
		});

		// --- 功能 2: 插入 *** 分隔行符号 ---
		// 快捷键由 MindZJ 设置面板统一管理（默认 Alt+A）
		// 只插入 3 个 `*` — Markdown 的水平分隔线要求至少 3 个。
		this.addCommand({
			id: 'insert-triple-asterisk',
			name: 'Insert Triple Asterisk',
			editorCallback: (editor, view) => {
				editor.replaceSelection(`***`);
			}
		});
	}

	onunload() {
		// nothing to clean up — commands are removed automatically
		// when pluginCommandRegistry entries are cleared by the host.
	}
};
