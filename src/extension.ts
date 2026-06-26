import * as vscode from 'vscode';
import { configurationSection, getConfiguration, getTemplate } from './core/configuration';
import { Logger } from './core/logger';
import { buildReferenceContext, selectionToLocation, type ReferenceLocation } from './core/references';
import { renderTemplate, validateTemplates } from './core/templates';
import { truncateMiddle } from './core/text';
import { TerminalTargetManager } from './targets/terminalTargets';

type CommandResource = vscode.Uri | { resourceUri?: vscode.Uri; uri?: vscode.Uri } | undefined;
type CommandResourceList = readonly CommandResource[] | undefined;

interface ReferenceSource {
	readonly uri: vscode.Uri;
	readonly location?: ReferenceLocation;
}

interface RenderOptions {
	readonly templateName?: string;
}

interface RenderedTemplatePick extends vscode.QuickPickItem {
	readonly rendered: string;
	readonly templateName: string;
}

interface TemplateNamePick extends vscode.QuickPickItem {
	readonly templateName: string;
}

let targetManager: TerminalTargetManager | undefined;
let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext): void {
	logger = new Logger();
	targetManager = new TerminalTargetManager(context, logger);

	context.subscriptions.push(
		logger,
		targetManager,
		registerCommand('copyReference', (resource?: CommandResource, selectedResources?: CommandResourceList) => copyReference(resource, selectedResources)),
		registerCommand('copyReferenceFromExplorer', () => copyReferenceFromExplorer()),
		registerCommand('copyReferenceAs', (resource?: CommandResource, selectedResources?: CommandResourceList) => copyReferenceAs(resource, selectedResources)),
		registerCommand('copyReference.chooseTemplate', (resource?: CommandResource, selectedResources?: CommandResourceList) => copyReferenceAs(resource, selectedResources)),
		registerCommand('insertReference', (resource?: CommandResource, selectedResources?: CommandResourceList) => insertReference(resource, selectedResources)),
		registerCommand('insertReferenceFromExplorer', () => insertReferenceFromExplorer()),
		registerCommand('insertReferenceTo', (resource?: CommandResource, selectedResources?: CommandResourceList) => insertReferenceTo(resource, selectedResources)),
		registerCommand('selectTarget', () => targetManager?.selectTarget()),
		registerCommand('nextTarget', () => targetManager?.nextTarget()),
		registerCommand('selectDefaultTemplate', () => selectDefaultTemplate()),
		registerCommand('showLogs', () => logger?.show()),
	);

	logger.info('At Mention Bridge activated');
}

export function deactivate(): void {}

function registerCommand(command: string, callback: (...args: any[]) => unknown): vscode.Disposable {
	return vscode.commands.registerCommand(`vscode-at-mention-bridge.${command}`, callback);
}

async function copyReference(resource?: CommandResource, selectedResources?: CommandResourceList, templateName?: string): Promise<void> {
	try {
		const rendered = await renderReferences(resource, selectedResources, { templateName });
		if (!rendered) {
			return;
		}

		await vscode.env.clipboard.writeText(rendered);
		if (getConfiguration().showCopyNotifications) {
			vscode.window.setStatusBarMessage('Copied @-mention reference', 2000);
		}
	} catch (error) {
		handleError('Unable to copy @-mention reference', error);
	}
}

async function copyReferenceAs(resource?: CommandResource, selectedResources?: CommandResourceList): Promise<void> {
	try {
		const selected = await pickRenderedTemplate(resource, selectedResources);
		if (!selected) {
			return;
		}

		await vscode.env.clipboard.writeText(selected.rendered);
		if (getConfiguration().showCopyNotifications) {
			vscode.window.setStatusBarMessage(`Copied ${selected.templateName} @-mention reference`, 2000);
		}
	} catch (error) {
		handleError('Unable to copy @-mention reference', error);
	}
}

async function copyReferenceFromExplorer(): Promise<void> {
	const uris = await getExplorerSelectedUris(false);
	if (uris.length === 0) {
		return;
	}
	await copyReference(undefined, uris);
}

async function insertReference(resource?: CommandResource, selectedResources?: CommandResourceList): Promise<void> {
	try {
		const rendered = await renderReferences(resource, selectedResources, {});
		if (!rendered) {
			return;
		}
		await targetManager?.insert(rendered);
	} catch (error) {
		handleError('Unable to insert @-mention reference', error);
	}
}

async function insertReferenceFromExplorer(): Promise<void> {
	const uris = await getExplorerSelectedUris(true);
	if (uris.length === 0) {
		return;
	}
	await insertReference(undefined, uris);
}

async function insertReferenceTo(resource?: CommandResource, selectedResources?: CommandResourceList): Promise<void> {
	await targetManager?.selectTarget();
	await insertReference(resource, selectedResources);
}

export async function renderReferences(resource: CommandResource, selectedResources: CommandResourceList, options: RenderOptions): Promise<string | undefined> {
	const templateName = options.templateName ?? getConfiguration().defaultTemplate;
	const template = getTemplate(templateName);
	if (!template) {
		vscode.window.showWarningMessage(`Template "${templateName}" is not configured.`);
		return undefined;
	}

	const sources = resolveReferenceSources(resource, selectedResources);
	if (sources.length === 0) {
		vscode.window.setStatusBarMessage('No editor or Explorer resource is focused for @-mention reference', 2500);
		return undefined;
	}

	return renderTemplateForSources(template, sources);
}

function resolveReferenceSources(resource: CommandResource, selectedResources: CommandResourceList): ReferenceSource[] {
	const selectedUris = dedupeUris((selectedResources ?? []).flatMap(resourceItem => {
		const uri = getUriFromCommandResource(resourceItem);
		return uri ? [uri] : [];
	}));
	if (selectedUris.length > 0) {
		return selectedUris.map(uri => ({ uri }));
	}

	const commandUri = getUriFromCommandResource(resource);
	const activeEditor = vscode.window.activeTextEditor;
	if (commandUri) {
		return [{
			uri: commandUri,
			location: activeEditor?.document.uri.toString() === commandUri.toString()
				? selectionToLocation(activeEditor.selection)
				: undefined,
		}];
	}

	if (activeEditor && activeEditor.document.uri.scheme === 'file') {
		return [{
			uri: activeEditor.document.uri,
			location: selectionToLocation(activeEditor.selection),
		}];
	}

	return [];
}

function getUriFromCommandResource(resource: CommandResource): vscode.Uri | undefined {
	if (!resource) {
		return undefined;
	}
	if (resource instanceof vscode.Uri) {
		return resource;
	}
	return resource.resourceUri ?? resource.uri;
}

async function getExplorerSelectedUris(restoreClipboard: boolean): Promise<vscode.Uri[]> {
	const previousClipboard = restoreClipboard ? await vscode.env.clipboard.readText() : undefined;
	try {
		await vscode.commands.executeCommand('copyFilePath');
		const copied = await vscode.env.clipboard.readText();
		return copied
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean)
			.map(selectedPath => vscode.Uri.file(selectedPath));
	} catch (error) {
		logger?.warn('Unable to resolve Explorer selection', error);
		return [];
	} finally {
		if (restoreClipboard && previousClipboard !== undefined) {
			await vscode.env.clipboard.writeText(previousClipboard);
		}
	}
}

async function pickRenderedTemplate(resource: CommandResource, selectedResources: CommandResourceList): Promise<RenderedTemplatePick | undefined> {
	const configuration = getConfiguration();
	const invalid = validateTemplates(configuration.templates);
	if (invalid.length > 0) {
		vscode.window.showWarningMessage(`Ignoring invalid template entries: ${invalid.join(', ')}`);
	}

	const sources = resolveReferenceSources(resource, selectedResources);
	if (sources.length === 0) {
		vscode.window.setStatusBarMessage('No editor or Explorer resource is focused for @-mention reference', 2500);
		return undefined;
	}

	const failedTemplates: string[] = [];
	const items: RenderedTemplatePick[] = [];
	for (const [templateName, template] of Object.entries(configuration.templates).sort(([first], [second]) => first.localeCompare(second))) {
		try {
			const rendered = await renderTemplateForSources(template, sources);
			items.push({
				label: truncateMiddle(rendered, 56),
				description: templateName === configuration.defaultTemplate ? `${templateName} (default)` : templateName,
				rendered,
				templateName,
			});
		} catch (error) {
			failedTemplates.push(templateName);
			logger?.warn(`Unable to render template "${templateName}"`, error);
		}
	}

	if (failedTemplates.length > 0) {
		vscode.window.showWarningMessage(`Could not render template entries: ${failedTemplates.join(', ')}`);
	}
	if (items.length === 0) {
		vscode.window.showWarningMessage('No @-mention reference templates are available.');
		return undefined;
	}

	return vscode.window.showQuickPick(items, {
		placeHolder: 'Choose the rendered @-mention reference to copy',
		matchOnDescription: true,
	});
}

async function selectDefaultTemplate(): Promise<void> {
	try {
		const configuration = getConfiguration();
		const invalid = validateTemplates(configuration.templates);
		if (invalid.length > 0) {
			vscode.window.showWarningMessage(`Ignoring invalid template entries: ${invalid.join(', ')}`);
		}

		const items: TemplateNamePick[] = Object.entries(configuration.templates)
			.filter(([name, template]) => name.trim() && typeof template === 'string' && template.trim())
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([templateName, template]) => ({
				label: templateName,
				description: templateName === configuration.defaultTemplate ? 'Current default' : undefined,
				detail: truncateMiddle(template, 96),
				templateName,
			}));

		if (items.length === 0) {
			vscode.window.showWarningMessage('No @-mention reference templates are available.');
			return;
		}

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select the default @-mention reference template',
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!selected) {
			return;
		}

		await updateDefaultTemplate(selected.templateName);
		vscode.window.setStatusBarMessage(`Default @-mention template: ${selected.templateName}`, 2000);
	} catch (error) {
		handleError('Unable to select default @-mention template', error);
	}
}

async function updateDefaultTemplate(templateName: string): Promise<void> {
	const resource = vscode.window.activeTextEditor?.document.uri;
	const configuration = vscode.workspace.getConfiguration(configurationSection, resource);
	const inspection = configuration.inspect<string>('defaultTemplate');
	const target = inspection?.workspaceFolderValue !== undefined
		? vscode.ConfigurationTarget.WorkspaceFolder
		: inspection?.workspaceValue !== undefined
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;

	await configuration.update('defaultTemplate', templateName, target);
}

async function renderTemplateForSources(template: string, sources: readonly ReferenceSource[]): Promise<string> {
	const references: string[] = [];
	for (const source of sources) {
		const context = await buildReferenceContext(source.uri, source.location);
		references.push(renderTemplate(template, context));
	}
	return references.join(' ');
}

function dedupeUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
	const seen = new Set<string>();
	return uris.filter(uri => {
		const key = uri.toString();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function handleError(message: string, error: unknown): void {
	logger?.error(message, error);
	const detail = error instanceof Error ? error.message : String(error);
	vscode.window.showErrorMessage(`${message}: ${detail}`);
}
