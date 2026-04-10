const { Plugin } = require('obsidian');

module.exports = class TimestampPlugin extends Plugin {
	async onload() {

		// --- 功能 1: 插入时间戳 H2标签 例如 260321 0121 ---
		// 快捷键由 MindZJ 设置面板统一管理（默认 Alt+F）
		this.addCommand({
			id: 'insert-custom-timestamp',
			name: 'Insert H2 Timestamp',
			// 不再硬编码 hotkeys — 由 App.tsx 通过 mindzj:plugin-command 事件触发
			editorCallback: (editor, view) => {
				const now = new Date();
				const datePart = now.getFullYear().toString().slice(-2) +
					(now.getMonth() + 1).toString().padStart(2, '0') +
					now.getDate().toString().padStart(2, '0');
				const timePart = now.getHours().toString().padStart(2, '0') +
					now.getMinutes().toString().padStart(2, '0');
				const timestamp = `## ${datePart} ${timePart}`;
				editor.replaceSelection(timestamp);
			}
		});

		// --- 功能 2: 插入 *** 分隔行符号 ---
		// 快捷键由 MindZJ 设置面板统一管理（默认 Alt+A）
		this.addCommand({
			id: 'insert-triple-asterisk',
			name: 'Insert Triple Asterisk',
			// 不再硬编码 hotkeys — 由 App.tsx 通过 mindzj:plugin-command 事件触发
			editorCallback: (editor, view) => {
				const content = `***\n`;
				editor.replaceSelection(content);
			}
		});

		// Listen for command dispatches from MindZJ's hotkey system
		this._pluginCommandHandler = (e) => {
			const commandId = e.detail?.command;
			if (!commandId) return;
			// Check if it's one of our commands
			if (commandId === 'insert-custom-timestamp' || commandId === 'insert-triple-asterisk') {
				// Execute the command through the app's command system
				if (this.app && this.app.commands) {
					this.app.commands.executeCommandById('timestamp-header:' + commandId);
				}
			}
		};
		document.addEventListener('mindzj:plugin-command', this._pluginCommandHandler);
	}

	onunload() {
		if (this._pluginCommandHandler) {
			document.removeEventListener('mindzj:plugin-command', this._pluginCommandHandler);
		}
	}
};
