import * as vscode from 'vscode';

export const extensionId = 'vscode-at-mention-bridge';
export const configurationSection = 'atMentionBridge';

export const builtInTemplates: Record<string, string> = {
	claudeStyle: '@${relativePath}${locationSuffix}',
	codexStyle: '[${fileName}${locationSuffix}](${absolutePath}${locationSuffix})',
};

export interface ExtensionConfiguration {
	readonly defaultTemplate: string;
	readonly templates: Record<string, string>;
	readonly autoLinkActiveAgentTerminal: boolean;
	readonly showCopyNotifications: boolean;
}

export function getConfiguration(): ExtensionConfiguration {
	const configuration = vscode.workspace.getConfiguration(configurationSection);
	const templates = {
		...builtInTemplates,
		...configuration.get<Record<string, string>>('templates', {}),
	};
	const configuredDefaultTemplate = configuration.get('defaultTemplate', 'claudeStyle');
	return {
		defaultTemplate: templates[configuredDefaultTemplate] ? configuredDefaultTemplate : 'claudeStyle',
		templates,
		autoLinkActiveAgentTerminal: configuration.get('autoLinkActiveAgentTerminal', true),
		showCopyNotifications: configuration.get('showCopyNotifications', true),
	};
}

export function getTemplate(templateName: string): string | undefined {
	return getConfiguration().templates[templateName];
}
