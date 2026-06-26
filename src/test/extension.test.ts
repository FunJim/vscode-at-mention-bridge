import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { renderReferences } from '../extension';
import { AgentDefinition, detectAgentFromCommand } from '../core/agents';
import { builtInTemplates, configurationSection } from '../core/configuration';
import { buildReferenceContext, selectionToLocation } from '../core/references';
import { renderTemplate } from '../core/templates';
import { truncateMiddle } from '../core/text';
import { LogSink, Logger } from '../core/logger';
import { ProcessAgentMatch, ProcessScanner, ProcessScannerHost, ProcessRow } from '../targets/processScanner';
import { TerminalTargetManager, TerminalWindowApi } from '../targets/terminalTargets';

suite('At Mention Bridge', () => {
	test('renders built-in claudeStyle and codexStyle templates for selected lines', async () => {
		const uri = vscode.Uri.file(path.join(__dirname, '../../src/extension.ts'));
		const context = await buildReferenceContext(uri, { lineStart: 7, lineEnd: 24 });

		assert.strictEqual(renderTemplate(builtInTemplates.claudeStyle, context), '@src/extension.ts#7-24');
		assert.strictEqual(
			renderTemplate(builtInTemplates.codexStyle, context),
			`[extension.ts#7-24](${uri.fsPath.split(path.sep).join('/')}#7-24)`,
		);
	});

	test('renders directory references with trailing slash', async () => {
		const uri = vscode.Uri.file(path.join(__dirname, '../../src'));
		const context = await buildReferenceContext(uri);

		assert.strictEqual(context.relativePath, 'src/');
		assert.strictEqual(context.fileName, 'src/');
		assert.strictEqual(renderTemplate(builtInTemplates.claudeStyle, context), '@src/');
	});

	test('converts selections to inclusive one-indexed line ranges', () => {
		const singleLine = new vscode.Selection(23, 0, 23, 5);
		const multiLine = new vscode.Selection(23, 0, 25, 1);
		const wholeLineRange = new vscode.Selection(23, 0, 26, 0);

		assert.deepStrictEqual(selectionToLocation(singleLine), { lineStart: 24, lineEnd: 24 });
		assert.deepStrictEqual(selectionToLocation(multiLine), { lineStart: 24, lineEnd: 26 });
		assert.deepStrictEqual(selectionToLocation(wholeLineRange), { lineStart: 24, lineEnd: 26 });
	});

	test('detects supported agents from command lines', () => {
		assert.strictEqual(detectAgentFromCommand('/usr/local/bin/codex --approval never')?.id, 'codex');
		assert.strictEqual(detectAgentFromCommand('tmux new-session claude')?.id, 'claude');
		assert.strictEqual(detectAgentFromCommand('node ./script.js'), undefined);
	});

	test('truncates long rendered references in the middle', () => {
		assert.strictEqual(truncateMiddle('@short.ts#1', 32), '@short.ts#1');
		assert.strictEqual(truncateMiddle('@abcdefghijklmnopqrstuvwxyz#123', 16), '@abcdef...yz#123');
		assert.strictEqual(truncateMiddle('@abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz#123', 56).length, 56);
	});

	test('copy command writes the active editor reference to the clipboard', async () => {
		const extension = vscode.extensions.getExtension('funjim.vscode-at-mention-bridge');
		await extension?.activate();

		const uri = vscode.Uri.file(path.join(__dirname, '../../src/extension.ts'));
		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(0, 0, 0, 1);

		await vscode.commands.executeCommand('vscode-at-mention-bridge.copyReference');

		assert.strictEqual(await vscode.env.clipboard.readText(), '@src/extension.ts#1');
	});

	test('copy command keeps active selection when invoked with the active editor URI', async () => {
		const extension = vscode.extensions.getExtension('funjim.vscode-at-mention-bridge');
		await extension?.activate();

		const uri = vscode.Uri.file(path.join(__dirname, '../../src/targets/processScanner.ts'));
		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(0, 0, 2, 1);

		await vscode.commands.executeCommand('vscode-at-mention-bridge.copyReference', uri);

		assert.strictEqual(await vscode.env.clipboard.readText(), '@src/targets/processScanner.ts#1-3');
	});

	test('copy command renders all selected Explorer resources', async () => {
		const extension = vscode.extensions.getExtension('funjim.vscode-at-mention-bridge');
		await extension?.activate();

		const extensionUri = vscode.Uri.file(path.join(__dirname, '../../src/extension.ts'));
		const scannerUri = vscode.Uri.file(path.join(__dirname, '../../src/targets/processScanner.ts'));

		await vscode.commands.executeCommand('vscode-at-mention-bridge.copyReference', extensionUri, [extensionUri, scannerUri]);

		assert.strictEqual(await vscode.env.clipboard.readText(), '@src/extension.ts @src/targets/processScanner.ts');
	});

	test('default template renders references for insert and copy flows', async () => {
		const extension = vscode.extensions.getExtension('funjim.vscode-at-mention-bridge');
		await extension?.activate();

		const configuration = vscode.workspace.getConfiguration(configurationSection);
		await configuration.update('templates', { test: 'TEST:${fileName}${locationSuffix}' }, vscode.ConfigurationTarget.Workspace);
		await configuration.update('defaultTemplate', 'test', vscode.ConfigurationTarget.Workspace);

		try {
			const uri = vscode.Uri.file(path.join(__dirname, '../../src/extension.ts'));
			const rendered = await renderReferences(uri, undefined, {});

			assert.strictEqual(rendered, 'TEST:extension.ts');
		} finally {
			await configuration.update('defaultTemplate', undefined, vscode.ConfigurationTarget.Workspace);
			await configuration.update('templates', undefined, vscode.ConfigurationTarget.Workspace);
		}
	});

	test('removes a shell-integration target when the agent command ends', () => {
		const startEmitter = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
		const endEmitter = new vscode.EventEmitter<vscode.TerminalShellExecutionEndEvent>();
		const subscriptions: vscode.Disposable[] = [];
		const terminal = createTerminalStub('codex');
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			{
				terminals: [],
				onDidOpenTerminal: () => new vscode.Disposable(() => {}),
				onDidCloseTerminal: () => new vscode.Disposable(() => {}),
				onDidChangeActiveTerminal: () => new vscode.Disposable(() => {}),
				onDidStartTerminalShellExecution: startEmitter.event,
				onDidEndTerminalShellExecution: endEmitter.event,
				createStatusBarItem: () => createStatusBarItemStub(),
			},
		);

		startEmitter.fire(createShellExecutionEvent(terminal, 'codex'));
		assert.strictEqual(manager.getTargetsForTesting().length, 1);

		endEmitter.fire(createShellExecutionEvent(terminal, 'codex'));
		assert.strictEqual(manager.getTargetsForTesting().length, 0);

		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
		startEmitter.dispose();
		endEmitter.dispose();
	});

	test('deduplicates selectable targets for the same terminal and agent', async () => {
		const startEmitter = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
		const subscriptions: vscode.Disposable[] = [];
		const terminal = createTerminalStub('codex', () => {}, 123);
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			{
				terminals: [],
				onDidOpenTerminal: () => new vscode.Disposable(() => {}),
				onDidCloseTerminal: () => new vscode.Disposable(() => {}),
				onDidChangeActiveTerminal: () => new vscode.Disposable(() => {}),
				onDidStartTerminalShellExecution: startEmitter.event,
				onDidEndTerminalShellExecution: () => new vscode.Disposable(() => {}),
				createStatusBarItem: () => createStatusBarItemStub(),
			},
		);

		startEmitter.fire(createShellExecutionEvent(terminal, 'codex'));
		(manager as unknown as {
			addTarget: (terminal: vscode.Terminal, agent: AgentDefinition, source: 'process', pid: number) => void;
		}).addTarget(terminal, detectAgentFromCommand('codex')!, 'process', 456);

		assert.strictEqual(manager.getTargetsForTesting().length, 2);
		assert.deepStrictEqual(
			manager.getSelectableTargetsForTesting().map(target => ({ id: target.agent.id, source: target.source, pid: target.pid })),
			[{ id: 'codex', source: 'process', pid: 456 }],
		);

		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
		startEmitter.dispose();
	});

	test('discovers wrapped agents by rescanning after an unrecognized shell command starts', async () => {
		const startEmitter = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
		const subscriptions: vscode.Disposable[] = [];
		const terminal = createTerminalStub('wrapped-agent', () => {}, 123);
		const claude = detectAgentFromCommand('/path/to/claude.exe')!;
		const scanner = new FakeProcessScanner();
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			createTerminalApiStub({
				terminals: [terminal],
				activeTerminal: terminal,
				onDidStartTerminalShellExecution: startEmitter.event,
			}),
			scanner,
		);

		await flushPromises();
		assert.strictEqual(manager.getTargetsForTesting().length, 0);

		scanner.matches = [{
			agent: claude,
			pid: 456,
			commandLine: '/internal/wrapper/node_modules/@anthropic-ai/claude-code/bin/claude.exe --settings {}',
		}];
		startEmitter.fire(createShellExecutionEvent(terminal, 'company-wrapper-command'));
		await flushPromises();

		assert.deepStrictEqual(
			manager.getTargetsForTesting().map(target => ({ id: target.agent.id, source: target.source, pid: target.pid })),
			[{ id: 'claude', source: 'process', pid: 456 }],
		);
		assert.deepStrictEqual(scanner.scannedRootPids, [123, 123]);

		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
		startEmitter.dispose();
	});

	test('discovers tmux panes when the terminal process is the tmux client', async () => {
		const scanner = new ProcessScanner(new FakeProcessScannerHost({
			processes: [
				{
					pid: 2643880,
					ppid: 2032722,
					command: 'tmux: client',
					commandLine: '/usr/bin/tmux new-session -A -s workspace',
				},
				{
					pid: 1774212,
					ppid: 3397074,
					command: 'bash',
					commandLine: '-bash',
				},
				{
					pid: 2671044,
					ppid: 1774212,
					command: 'node-MainThread',
					commandLine: 'node /usr/local/bin/company-agent-wrapper',
				},
				{
					pid: 2671085,
					ppid: 2671044,
					command: 'claude.exe',
					commandLine: '/usr/local/lib/company-agent-wrapper/node_modules/@anthropic-ai/claude-code/bin/claude.exe --settings {}',
				},
			],
			tmuxClients: '/dev/pts/3\t/dev/pts/3\t2140053\tworkspace\t%53\t1\n/dev/pts/0\t/dev/pts/0\t2643880\tworkspace\t%53\t0\n',
			tmuxPanes: 'workspace\t@52\t1\t[tmux]\t%53\t1\t1774212\tnode\t_ Check running process PID\n',
		}));

		const matches = await scanner.findAgentProcesses(2643880);

		assert.deepStrictEqual(
			matches.map(match => ({ agent: match.agent.id, pid: match.pid, pane: match.tmuxPaneId, client: match.tmuxClient })),
			[{ agent: 'claude', pid: 2671085, pane: '%53', client: '/dev/pts/0' }],
		);
	});

	test('logs expected tmux probe failures at debug level', async () => {
		const logger = new TestLogger();
		const scanner = new ProcessScanner(new FakeProcessScannerHost({
			processes: [
				{
					pid: 100,
					ppid: 1,
					command: 'tmux: client',
					commandLine: '/usr/bin/tmux new-session -A -s workspace',
				},
			],
			tmuxClients: new Error('Command failed: tmux list-clients\nno server running on /tmp/tmux-501/default'),
		}), logger);

		const matches = await scanner.findAgentProcesses(100);

		assert.deepStrictEqual(matches, []);
		assert.deepStrictEqual(logger.warns, []);
		assert.deepStrictEqual(logger.debugs.map(entry => entry.message), [
			'tmux scan skipped because tmux is not ready for this terminal',
			'Process scan completed',
		]);
	});

	test('warns for unexpected tmux scan failures', async () => {
		const logger = new TestLogger();
		const scanner = new ProcessScanner(new FakeProcessScannerHost({
			processes: [
				{
					pid: 100,
					ppid: 1,
					command: 'tmux: client',
					commandLine: '/usr/bin/tmux new-session -A -s workspace',
				},
			],
			tmuxClients: new Error('permission denied'),
		}), logger);

		const matches = await scanner.findAgentProcesses(100);

		assert.deepStrictEqual(matches, []);
		assert.deepStrictEqual(logger.warns.map(entry => entry.message), ['Unable to scan tmux panes for agent processes']);
		assert.strictEqual(logger.warns[0].args[0] instanceof Error, true);
	});

	test('reveals the selected target terminal', async () => {
		const startEmitter = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
		const subscriptions: vscode.Disposable[] = [];
		const shownTerminals: string[] = [];
		const quickPickItems: vscode.QuickPickItem[] = [];
		const quickPickActiveItems: vscode.QuickPickItem[][] = [];
		const firstTerminal = createTerminalStub('codex', () => {}, undefined, () => shownTerminals.push('codex'));
		const secondTerminal = createTerminalStub('claude', () => {}, undefined, () => shownTerminals.push('claude'));
		const restoreQuickPick = stubCreateQuickPick({
			onShow: quickPick => {
				quickPickItems.push(...quickPick.items);
				quickPickActiveItems.push([...quickPick.activeItems]);
				quickPick.selectedItems = quickPick.items.filter(item => item.description === 'PID 200');
				quickPick.accept();
			},
		});
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			createTerminalApiStub({
				terminals: [firstTerminal, secondTerminal],
				activeTerminal: firstTerminal,
				onDidStartTerminalShellExecution: startEmitter.event,
			}),
		);

		try {
			startEmitter.fire(createShellExecutionEvent(firstTerminal, 'codex'));
			startEmitter.fire(createShellExecutionEvent(secondTerminal, 'claude'));
			(manager as unknown as {
				addTarget: (terminal: vscode.Terminal, agent: AgentDefinition, source: 'process', pid: number) => void;
			}).addTarget(firstTerminal, detectAgentFromCommand('codex')!, 'process', 200);
			(manager as unknown as {
				addTarget: (terminal: vscode.Terminal, agent: AgentDefinition, source: 'process', pid: number) => void;
			}).addTarget(secondTerminal, detectAgentFromCommand('claude')!, 'process', 100);

			await manager.selectTarget();

			assert.deepStrictEqual(shownTerminals, ['codex']);
			assert.deepStrictEqual(
				quickPickItems.map(item => ({ label: item.label, description: item.description, detail: item.detail })),
				[
					{ label: '$(terminal) Claude Code', description: 'PID 100', detail: 'Current target · Terminal: claude' },
					{ label: '$(terminal) OpenAI Codex CLI', description: 'PID 200', detail: 'Active terminal · Terminal: codex' },
				],
			);
			assert.deepStrictEqual(
				quickPickActiveItems.map(items => items.map(item => ({ label: item.label, description: item.description }))),
				[[{ label: '$(terminal) Claude Code', description: 'PID 100' }]],
			);
		} finally {
			restoreQuickPick();
			manager.dispose();
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			startEmitter.dispose();
		}
	});

	test('shows distinguishable active target status bar text and tooltip', async () => {
		const subscriptions: vscode.Disposable[] = [];
		const statusBarItem = createStatusBarItemStub();
		const terminal = createTerminalStub('claude', () => {}, 123);
		const claude = detectAgentFromCommand('claude')!;
		const scanner = new FakeProcessScanner([{
			agent: claude,
			pid: 456,
			commandLine: 'claude',
		}]);
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			createTerminalApiStub({
				terminals: [terminal],
				activeTerminal: terminal,
				createStatusBarItem: () => statusBarItem,
			}),
			scanner,
		);

		await flushPromises();

		assert.strictEqual(statusBarItem.text, '$(mention) Claude Code · PID 456');
		assert.strictEqual(
			statusBarItem.tooltip,
			[
				'At Mention Bridge target: Claude Code',
				'Terminal: claude',
				'PID: 456',
				'Click to select another target.',
			].join('\n'),
		);

		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
	});

	test('does not repeat info logs for unchanged rediscovered process targets', async () => {
		const subscriptions: vscode.Disposable[] = [];
		const terminal = createTerminalStub('wrapped-agent', () => {}, 123);
		const logger = new TestLogger();
		const scanner = new FakeProcessScanner([{
			agent: detectAgentFromCommand('claude')!,
			pid: 456,
			commandLine: 'claude',
		}]);
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			logger,
			createTerminalApiStub({
				terminals: [terminal],
				activeTerminal: terminal,
			}),
			scanner,
		);

		await flushPromises();
		await (manager as unknown as { inspectTerminal(terminal: vscode.Terminal): Promise<void> }).inspectTerminal(terminal);

		assert.deepStrictEqual(
			logger.infos.map(entry => entry.message),
			['Registered agent target from process scan'],
		);
		assert.deepStrictEqual(
			logger.debugs.filter(entry => entry.message === 'Agent target unchanged after process scan').map(entry => entry.args[0]),
			[{
				agentId: 'claude',
				agentLabel: 'Claude Code',
				terminalName: 'wrapped-agent',
				source: 'process',
				pid: 456,
			}],
		);

		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
	});

	test('reveals the next target terminal', async () => {
		const startEmitter = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
		const subscriptions: vscode.Disposable[] = [];
		const shownTerminals: string[] = [];
		const firstTerminal = createTerminalStub('codex', () => {}, undefined, () => shownTerminals.push('codex'));
		const secondTerminal = createTerminalStub('claude', () => {}, undefined, () => shownTerminals.push('claude'));
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			createTerminalApiStub({
				terminals: [firstTerminal, secondTerminal],
				activeTerminal: firstTerminal,
				onDidStartTerminalShellExecution: startEmitter.event,
			}),
		);

		startEmitter.fire(createShellExecutionEvent(firstTerminal, 'codex'));
		startEmitter.fire(createShellExecutionEvent(secondTerminal, 'claude'));

		await manager.nextTarget();

		assert.deepStrictEqual(shownTerminals, ['codex']);

		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
		startEmitter.dispose();
	});

	test('keeps tmux panes as separate selectable targets and only auto-activates the active pane', async () => {
		const subscriptions: vscode.Disposable[] = [];
		const terminal = createTerminalStub('tmux', () => {}, 123);
		const codex = detectAgentFromCommand('codex')!;
		const claude = detectAgentFromCommand('claude')!;
		const scanner = new FakeProcessScanner([
			{
				agent: codex,
				pid: 38625,
				commandLine: 'codex',
				tmuxPaneId: '%2',
				tmuxPanePid: 37311,
				tmuxSessionName: 'test-0',
				tmuxWindowIndex: '1',
				tmuxWindowName: 'claude',
				tmuxPaneIndex: '1',
				tmuxIsActivePane: false,
			},
			{
				agent: claude,
				pid: 49446,
				commandLine: 'claude',
				tmuxPaneId: '%4',
				tmuxPanePid: 48869,
				tmuxSessionName: 'test-0',
				tmuxWindowIndex: '1',
				tmuxWindowName: 'claude',
				tmuxPaneIndex: '2',
				tmuxIsActivePane: true,
			},
			{
				agent: claude,
				pid: 46465,
				commandLine: 'claude.exe',
				tmuxPaneId: '%3',
				tmuxPanePid: 45737,
				tmuxSessionName: 'test-0',
				tmuxWindowIndex: '2',
				tmuxWindowName: 'node',
				tmuxPaneIndex: '1',
				tmuxIsActivePane: false,
			},
		]);
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			createTerminalApiStub({
				terminals: [terminal],
				activeTerminal: terminal,
			}),
			scanner,
		);

		await flushPromises();

		assert.deepStrictEqual(
			manager.getSelectableTargetsForTesting().map(target => ({
				agent: target.agent.id,
				pid: target.pid,
				pane: target.tmuxPaneId,
				window: target.tmuxWindowIndex,
				isActivePane: target.tmuxIsActivePane,
			})),
			[
				{ agent: 'codex', pid: 38625, pane: '%2', window: '1', isActivePane: false },
				{ agent: 'claude', pid: 49446, pane: '%4', window: '1', isActivePane: true },
				{ agent: 'claude', pid: 46465, pane: '%3', window: '2', isActivePane: false },
			],
		);
		assert.strictEqual((manager as unknown as { activeTarget?: { tmuxPaneId?: string } }).activeTarget?.tmuxPaneId, '%4');

		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
	});

	test('hides generic shell targets after tmux pane targets are discovered', async () => {
		const startEmitter = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
		const subscriptions: vscode.Disposable[] = [];
		const terminal = createTerminalStub('tmux', () => {}, 123);
		const claude = detectAgentFromCommand('claude')!;
		const scanner = new FakeProcessScanner([{
			agent: claude,
			pid: 46465,
			commandLine: 'claude.exe',
			tmuxPaneId: '%3',
			tmuxPanePid: 45737,
			tmuxSessionName: 'test-0',
			tmuxWindowIndex: '2',
			tmuxWindowName: 'node',
			tmuxPaneIndex: '1',
			tmuxIsActivePane: true,
		}]);
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			createTerminalApiStub({
				terminals: [terminal],
				activeTerminal: terminal,
				onDidStartTerminalShellExecution: startEmitter.event,
			}),
			scanner,
		);

		startEmitter.fire(createShellExecutionEvent(terminal, 'claude'));
		await flushPromises();

		assert.deepStrictEqual(
			manager.getSelectableTargetsForTesting().map(target => ({ source: target.source, pid: target.pid, pane: target.tmuxPaneId })),
			[{ source: 'process', pid: 46465, pane: '%3' }],
		);

		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
		startEmitter.dispose();
	});

	test('next target warns when no targets have been discovered', async () => {
		const subscriptions: vscode.Disposable[] = [];
		const messages: string[] = [];
		const restoreWarning = stubShowWarningMessage(messages);
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			{
				terminals: [],
				onDidOpenTerminal: () => new vscode.Disposable(() => {}),
				onDidCloseTerminal: () => new vscode.Disposable(() => {}),
				onDidChangeActiveTerminal: () => new vscode.Disposable(() => {}),
				onDidStartTerminalShellExecution: () => new vscode.Disposable(() => {}),
				onDidEndTerminalShellExecution: () => new vscode.Disposable(() => {}),
				createStatusBarItem: () => createStatusBarItemStub(),
			},
		);

		try {
			await manager.nextTarget();

			assert.deepStrictEqual(messages, ['No agent terminals have been discovered yet.']);
		} finally {
			restoreWarning();
			manager.dispose();
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
		}
	});

	test('next target notifies when there is no other target', async () => {
		const startEmitter = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
		const subscriptions: vscode.Disposable[] = [];
		const messages: string[] = [];
		const restoreInformation = stubShowInformationMessage(messages);
		const terminal = createTerminalStub('codex');
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			{
				terminals: [],
				onDidOpenTerminal: () => new vscode.Disposable(() => {}),
				onDidCloseTerminal: () => new vscode.Disposable(() => {}),
				onDidChangeActiveTerminal: () => new vscode.Disposable(() => {}),
				onDidStartTerminalShellExecution: startEmitter.event,
				onDidEndTerminalShellExecution: () => new vscode.Disposable(() => {}),
				createStatusBarItem: () => createStatusBarItemStub(),
			},
		);

		try {
			startEmitter.fire(createShellExecutionEvent(terminal, 'codex'));
			await manager.nextTarget();

			assert.deepStrictEqual(messages, ['No other agent terminals have been discovered yet.']);
		} finally {
			restoreInformation();
			manager.dispose();
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			startEmitter.dispose();
		}
	});

	test('inserts references with a trailing space', async () => {
		const startEmitter = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
		const sentText: string[] = [];
		const subscriptions: vscode.Disposable[] = [];
		const terminal = createTerminalStub('codex', text => sentText.push(text));
		const manager = new TerminalTargetManager(
			createContextStub(subscriptions),
			new Logger(),
			{
				terminals: [],
				onDidOpenTerminal: () => new vscode.Disposable(() => {}),
				onDidCloseTerminal: () => new vscode.Disposable(() => {}),
				onDidChangeActiveTerminal: () => new vscode.Disposable(() => {}),
				onDidStartTerminalShellExecution: startEmitter.event,
				onDidEndTerminalShellExecution: () => new vscode.Disposable(() => {}),
				createStatusBarItem: () => createStatusBarItemStub(),
			},
		);

		startEmitter.fire(createShellExecutionEvent(terminal, 'codex'));

		assert.strictEqual(await manager.insert('@src/extension.ts'), true);
		assert.deepStrictEqual(sentText, ['@src/extension.ts ']);

		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
		startEmitter.dispose();
	});
});

function createTerminalStub(
	name: string,
	onSendText: (text: string) => void = () => {},
	processId: number | undefined = undefined,
	onShow: () => void = () => {},
): vscode.Terminal {
	return {
		name,
		processId: Promise.resolve(processId),
		sendText: onSendText,
		show: onShow,
	} as unknown as vscode.Terminal;
}

function createShellExecutionEvent(terminal: vscode.Terminal, commandLine: string): vscode.TerminalShellExecutionStartEvent & vscode.TerminalShellExecutionEndEvent {
	return {
		terminal,
		execution: {
			commandLine: {
				value: commandLine,
			},
		},
	} as vscode.TerminalShellExecutionStartEvent & vscode.TerminalShellExecutionEndEvent;
}

function createTerminalApiStub(overrides: Partial<TerminalWindowApi> = {}): TerminalWindowApi {
	return {
		terminals: [],
		activeTerminal: undefined,
		onDidOpenTerminal: () => new vscode.Disposable(() => {}),
		onDidCloseTerminal: () => new vscode.Disposable(() => {}),
		onDidChangeActiveTerminal: () => new vscode.Disposable(() => {}),
		onDidStartTerminalShellExecution: () => new vscode.Disposable(() => {}),
		onDidEndTerminalShellExecution: () => new vscode.Disposable(() => {}),
		createStatusBarItem: () => createStatusBarItemStub(),
		...overrides,
	};
}

function createContextStub(subscriptions: vscode.Disposable[]): vscode.ExtensionContext {
	const state = new Map<string, unknown>();
	return {
		subscriptions,
		workspaceState: {
			get: <T>(key: string) => state.get(key) as T | undefined,
			update: async (key: string, value: unknown) => {
				state.set(key, value);
			},
		},
	} as unknown as vscode.ExtensionContext;
}

function createStatusBarItemStub(): vscode.StatusBarItem & { text?: string; tooltip?: string | vscode.MarkdownString } {
	return {
		show: () => {},
		dispose: () => {},
	} as vscode.StatusBarItem & { text?: string; tooltip?: string | vscode.MarkdownString };
}

function flushPromises(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

class FakeProcessScanner {
	readonly scannedRootPids: number[] = [];

	constructor(public matches: ProcessAgentMatch[] = []) {}

	async findAgentProcesses(rootPid: number): Promise<ProcessAgentMatch[]> {
		this.scannedRootPids.push(rootPid);
		return this.matches;
	}

	async processExists(pid: number): Promise<boolean> {
		return this.matches.some(match => match.pid === pid);
	}

	async findExistingPids(pids: readonly number[]): Promise<Set<number>> {
		const wanted = new Set(pids);
		return new Set(this.matches.flatMap(match => match.pid && wanted.has(match.pid) ? [match.pid] : []));
	}
}

class FakeProcessScannerHost implements ProcessScannerHost {
	constructor(private readonly options: {
		readonly processes: ProcessRow[];
		readonly tmuxClients?: string | Error;
		readonly tmuxPanes?: string | Error;
	}) {}

	async listProcesses(): Promise<ProcessRow[]> {
		return this.options.processes;
	}

	async listTmuxClients(): Promise<string> {
		if (this.options.tmuxClients instanceof Error) {
			throw this.options.tmuxClients;
		}
		return this.options.tmuxClients ?? '';
	}

	async listTmuxPanes(): Promise<string> {
		if (this.options.tmuxPanes instanceof Error) {
			throw this.options.tmuxPanes;
		}
		return this.options.tmuxPanes ?? '';
	}
}

class TestLogger implements LogSink {
	readonly debugs: { message: string; args: unknown[] }[] = [];
	readonly infos: { message: string; args: unknown[] }[] = [];
	readonly warns: { message: string; args: unknown[] }[] = [];
	readonly errors: { message: string; error?: unknown }[] = [];

	debug(message: string, ...args: unknown[]): void {
		this.debugs.push({ message, args });
	}

	info(message: string, ...args: unknown[]): void {
		this.infos.push({ message, args });
	}

	warn(message: string, ...args: unknown[]): void {
		this.warns.push({ message, args });
	}

	error(message: string, error?: unknown): void {
		this.errors.push({ message, error });
	}
}

function stubShowWarningMessage(messages: string[]): () => void {
	const original = vscode.window.showWarningMessage;
	(vscode.window as unknown as {
		showWarningMessage: (message: string) => Thenable<undefined>;
	}).showWarningMessage = (message: string) => {
		messages.push(message);
		return Promise.resolve(undefined);
	};
	return () => {
		(vscode.window as unknown as { showWarningMessage: typeof original }).showWarningMessage = original;
	};
}

function stubShowInformationMessage(messages: string[]): () => void {
	const original = vscode.window.showInformationMessage;
	(vscode.window as unknown as {
		showInformationMessage: (message: string) => Thenable<undefined>;
	}).showInformationMessage = (message: string) => {
		messages.push(message);
		return Promise.resolve(undefined);
	};
	return () => {
		(vscode.window as unknown as { showInformationMessage: typeof original }).showInformationMessage = original;
	};
}

function stubCreateQuickPick(options: { onShow: (quickPick: TestQuickPick<vscode.QuickPickItem>) => void }): () => void {
	const original = vscode.window.createQuickPick;
	(vscode.window as unknown as {
		createQuickPick: <T extends vscode.QuickPickItem>() => vscode.QuickPick<T>;
	}).createQuickPick = <T extends vscode.QuickPickItem>() => new TestQuickPick<T>(quickPick => {
		options.onShow(quickPick as unknown as TestQuickPick<vscode.QuickPickItem>);
	}) as unknown as vscode.QuickPick<T>;
	return () => {
		(vscode.window as unknown as { createQuickPick: typeof original }).createQuickPick = original;
	};
}

class TestQuickPick<T extends vscode.QuickPickItem> implements Partial<vscode.QuickPick<T>> {
	value = '';
	placeholder: string | undefined;
	prompt: string | undefined;
	buttons: readonly vscode.QuickInputButton[] = [];
	items: readonly T[] = [];
	canSelectMany = false;
	matchOnDescription = false;
	matchOnDetail = false;
	keepScrollPosition: boolean | undefined;
	activeItems: readonly T[] = [];
	selectedItems: readonly T[] = [];
	title: string | undefined;
	step: number | undefined;
	totalSteps: number | undefined;
	enabled = true;
	busy = false;
	ignoreFocusOut = false;
	onDidChangeValue = new vscode.EventEmitter<string>().event;
	private readonly acceptEmitter = new vscode.EventEmitter<void>();
	readonly onDidAccept = this.acceptEmitter.event;
	onDidTriggerButton = new vscode.EventEmitter<vscode.QuickInputButton>().event;
	onDidTriggerItemButton = new vscode.EventEmitter<vscode.QuickPickItemButtonEvent<T>>().event;
	onDidChangeActive = new vscode.EventEmitter<readonly T[]>().event;
	onDidChangeSelection = new vscode.EventEmitter<readonly T[]>().event;
	onDidHide = new vscode.EventEmitter<void>().event;

	constructor(private readonly onShow: (quickPick: TestQuickPick<T>) => void) {}

	show(): void {
		this.onShow(this);
	}

	hide(): void {}

	dispose(): void {}

	accept(): void {
		this.acceptEmitter.fire();
	}
}
