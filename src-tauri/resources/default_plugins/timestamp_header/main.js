const { Plugin, PluginSettingTab, Setting } = require('obsidian');

const DEFAULT_SETTINGS = {
	format: '## yymmdd hhmm',
};

function pad(value) {
	return String(value).padStart(2, '0');
}

function formatTimestamp(format, date = new Date()) {
	const values = {
		yyyy: String(date.getFullYear()),
		yy: String(date.getFullYear()).slice(-2),
		month: pad(date.getMonth() + 1),
		dd: pad(date.getDate()),
		hh: pad(date.getHours()),
		minute: pad(date.getMinutes()),
		ss: pad(date.getSeconds()),
	};

	return String(format || DEFAULT_SETTINGS.format).replace(/yyyy|yy|MM|mm|dd|hh|ss/g, (token, offset, source) => {
		if (token === 'MM') return values.month;
		if (token === 'mm') {
			const beforeTwo = source.slice(Math.max(0, offset - 2), offset).toLowerCase();
			const beforeThree = source.slice(Math.max(0, offset - 3), offset).toLowerCase();
			return beforeTwo === 'hh' || beforeThree === 'hh:' ? values.minute : values.month;
		}
		return values[token] || token;
	});
}

module.exports = class TimestampPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		this.addCommand({
			id: 'insert-custom-timestamp',
			name: 'Insert Timestamp',
			editorCallback: (editor) => {
				const timestamp = formatTimestamp(this.settings.format);
				editor.replaceSelection(timestamp.endsWith('\n') ? timestamp : `${timestamp}\n`);
			},
		});

		this.addCommand({
			id: 'insert-triple-asterisk',
			name: 'Insert Triple Asterisk',
			editorCallback: (editor) => {
				editor.replaceSelection('***');
			},
		});

		this.addSettingTab(new TimestampHeaderSettingTab(this.app, this));
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
};

class TimestampHeaderSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Timestamp format')
			.setDesc('Examples: ## yymmdd hhmm, ### yyyy-mm-dd hh:mm:ss. Tokens: yyyy, yy, mm, MM, dd, hh, ss. In date parts, mm is month; after hh, mm is minutes. MM is always month.')
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_SETTINGS.format)
					.setValue(this.plugin.settings.format || DEFAULT_SETTINGS.format)
					.onChange(async (value) => {
						this.plugin.settings.format = value.trim() || DEFAULT_SETTINGS.format;
						await this.plugin.saveSettings();
					});
				text.inputEl.style.width = '260px';
			});
	}
}
