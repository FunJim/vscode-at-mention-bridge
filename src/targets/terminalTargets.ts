import * as vscode from 'vscode';
import { AgentDefinition, detectAgentFromCommand } from '../core/agents';
import { getConfiguration } from '../core/configuration';
import { Logger } from '../core/logger';
import { ProcessAgentMatch, ProcessScanner, sendTextToTmuxPane } from './processScanner';

export interface TargetRecord {
	readonly key: string;
	readonly terminal: vscode.Terminal;
	readonly agent: AgentDefinition;
	readonly pid?: number;
	readonly tmuxPaneId?: string;
	readonly source: 'shellExecution' | 'process';
}

export interface TerminalWindowApi {
	readonly terminals: readonly vscode.Terminal[];
	readonly activeTerminal?: vscode.Terminal;
	onDidOpenTerminal(listener: (terminal: vscode.Terminal) => unknown): vscode.Disposable;
	onDidCloseTerminal(listener: (terminal: vscode.Terminal) => unknown): vscode.Disposable;
	onDidChangeActiveTerminal(listener: (terminal: vscode.Terminal | undefined) => unknown): vscode.Disposable;
	onDidStartTerminalShellExecution(listener: (event: vscode.TerminalShellExecutionStartEvent) => unknown): vscode.Disposable;
	onDidEndTerminalShellExecution(listener: (event: vscode.TerminalShellExecutionEndEvent) => unknown): vscode.Disposable;
	createStatusBarItem(id: string, alignment?: vscode.StatusBarAlignment, priority?: number): vscode.StatusBarItem;
}

interface ProcessScannerApi {
	findAgentProcesses(rootPid: number): Promise<ProcessAgentMatch[]>;
	processExists(pid: number): Promise<boolean>;
	findExistingPids(pids: readonly number[]): Promise<Set<number>>;
}

export class TerminalTargetManager implements vscode.Disposable {
	private readonly targets = new Map<string, TargetRecord>();
	private readonly terminalIds = new WeakMap<vscode.Terminal, number>();
	private readonly inspectingTerminals = new WeakSet<vscode.Terminal>();
	private readonly refreshInterval: ReturnType<typeof setInterval>;
	private activeKey: string | undefined;
	private persistedActiveKey: string | undefined;
	private nextTerminalId = 1;
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger,
		private readonly terminalApi: TerminalWindowApi = vscode.window,
		private readonly scanner: ProcessScannerApi = new ProcessScanner(),
	) {
		this.statusBarItem = this.terminalApi.createStatusBarItem('target', vscode.StatusBarAlignment.Right, 90);
		this.statusBarItem.command = 'vscode-at-mention-bridge.selectTarget';
		this.statusBarItem.name = 'At Mention Bridge Target';
		this.refreshInterval = setInterval(() => {
			void this.refreshProcessTargets();
		}, 2000);

		this.disposables.push(
			new vscode.Disposable(() => clearInterval(this.refreshInterval)),
			this.statusBarItem,
			this.terminalApi.onDidOpenTerminal(terminal => this.inspectTerminal(terminal)),
			this.terminalApi.onDidCloseTerminal(terminal => this.removeTerminal(terminal)),
			this.terminalApi.onDidChangeActiveTerminal(terminal => this.onActiveTerminalChanged(terminal)),
			this.terminalApi.onDidStartTerminalShellExecution(event => this.onShellExecution(event)),
			this.terminalApi.onDidEndTerminalShellExecution(event => this.onShellExecutionEnded(event)),
		);

		for (const terminal of this.terminalApi.terminals) {
			void this.inspectTerminal(terminal);
		}

		this.restoreActiveKey();
		this.updateStatusBar();
	}

	private get activeTarget(): TargetRecord | undefined {
		const activeTarget = this.activeKey ? this.targets.get(this.activeKey) : undefined;
		if (!activeTarget) {
			return undefined;
		}
		return this.selectableTargets().find(target => this.sameSelectableTarget(target, activeTarget));
	}

	async selectTarget(): Promise<void> {
		const targets = this.selectableTargets();
		if (targets.length === 0) {
			vscode.window.showWarningMessage('No agent terminals have been discovered yet.');
			return;
		}

		const activeTarget = this.activeTarget;
		const items = targets.map(target => ({
			label: target.agent.label,
			description: target.terminal.name,
			detail: target.key === activeTarget?.key ? 'Current target' : undefined,
			target,
		}));
		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select the terminal that should receive inserted @-mention references',
		});

		if (!selected) {
			return;
		}

		await this.activateTarget(selected.target);
	}

	async nextTarget(): Promise<void> {
		const targets = this.selectableTargets();
		if (targets.length === 0) {
			vscode.window.showWarningMessage('No agent terminals have been discovered yet.');
			return;
		}
		if (targets.length === 1) {
			vscode.window.showInformationMessage('No other agent terminals have been discovered yet.');
			return;
		}

		const activeTarget = this.activeTarget;
		const currentIndex = targets.findIndex(target => target.key === activeTarget?.key);
		const next = targets[(currentIndex + 1) % targets.length];
		await this.activateTarget(next);
	}

	async insert(text: string): Promise<boolean> {
		let target = this.activeTarget;
		if (!target && getConfiguration().autoLinkActiveAgentTerminal && this.terminalApi.activeTerminal) {
			await this.inspectTerminal(this.terminalApi.activeTerminal);
			target = this.activeTarget;
		}

		if (!target) {
			const choice = await vscode.window.showWarningMessage(
				'Select an agent terminal before inserting a reference.',
				'Select Target',
			);
			if (choice === 'Select Target') {
				await this.selectTarget();
			}
			target = this.activeTarget;
		}

		if (!target) {
			return false;
		}

		if (!await this.isTargetActive(target)) {
			await this.removeTarget(target.key);
			vscode.window.showWarningMessage(`${target.agent.label} is no longer running in "${target.terminal.name}". Select an active agent terminal.`);
			return false;
		}

		const textToInsert = `${text} `;
		target.terminal.show(false);
		if (target.tmuxPaneId) {
			await sendTextToTmuxPane(target.tmuxPaneId, textToInsert);
		} else {
			target.terminal.sendText(textToInsert, false);
		}
		this.logger.info('Inserted reference into terminal', target.agent.id, target.terminal.name);
		return true;
	}

	getTargetsForTesting(): readonly TargetRecord[] {
		return [...this.targets.values()];
	}

	getSelectableTargetsForTesting(): readonly TargetRecord[] {
		return this.selectableTargets();
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private onActiveTerminalChanged(terminal: vscode.Terminal | undefined): void {
		if (!terminal || !getConfiguration().autoLinkActiveAgentTerminal) {
			return;
		}

		const target = this.selectableTargets().find(candidate => candidate.terminal === terminal);
		if (target) {
			this.activeKey = target.key;
			this.persistActiveKey();
			this.updateStatusBar();
			return;
		}

		void this.inspectTerminal(terminal);
	}

	private onShellExecution(event: vscode.TerminalShellExecutionStartEvent): void {
		const agent = detectAgentFromCommand(event.execution.commandLine.value);
		if (!agent) {
			void this.inspectTerminal(event.terminal);
			return;
		}

		this.addTarget(event.terminal, agent, 'shellExecution');
		if (getConfiguration().autoLinkActiveAgentTerminal || !this.activeKey) {
			this.activeKey = this.keyFor(event.terminal, agent.id);
			this.persistActiveKey();
		}
		this.updateStatusBar();
	}

	private onShellExecutionEnded(event: vscode.TerminalShellExecutionEndEvent): void {
		const agent = detectAgentFromCommand(event.execution.commandLine.value);
		if (!agent) {
			return;
		}

		for (const target of [...this.targets.values()]) {
			if (target.terminal === event.terminal && target.agent.id === agent.id) {
				void this.removeTarget(target.key);
			}
		}
	}

	private async inspectTerminal(terminal: vscode.Terminal): Promise<void> {
		if (this.inspectingTerminals.has(terminal)) {
			return;
		}
		this.inspectingTerminals.add(terminal);
		try {
			const processId = await terminal.processId;
			if (!processId) {
				return;
			}
			const matches = await this.scanner.findAgentProcesses(processId);
			for (const match of matches) {
				this.addTarget(terminal, match.agent, 'process', match.pid, match.tmuxPaneId);
				if (!this.activeKey || this.shouldAutoActivateTerminal(terminal)) {
					this.activeKey = this.keyFor(terminal, match.agent.id, match.tmuxPaneId, match.pid);
					void this.persistActiveKey();
				}
			}
			this.updateStatusBar();
		} catch (error) {
			this.logger.warn('Unable to inspect terminal process tree', error);
		} finally {
			this.inspectingTerminals.delete(terminal);
		}
	}

	private addTarget(terminal: vscode.Terminal, agent: AgentDefinition, source: TargetRecord['source'], pid?: number, tmuxPaneId?: string): void {
		const key = this.keyFor(terminal, agent.id, tmuxPaneId, pid);
		const currentActiveTarget = this.activeKey ? this.targets.get(this.activeKey) : undefined;
		const target = { key, terminal, agent, pid, tmuxPaneId, source };
		this.targets.set(key, target);
		if (!this.activeKey && key === this.persistedActiveKey) {
			this.activeKey = key;
		} else if (currentActiveTarget && this.sameSelectableTarget(currentActiveTarget, target) && this.isPreferredTarget(target, currentActiveTarget)) {
			this.activeKey = key;
			void this.persistActiveKey();
		}
		this.logger.info('Discovered agent terminal', agent.id, terminal.name);
	}

	private async isTargetActive(target: TargetRecord): Promise<boolean> {
		if (target.pid) {
			return this.scanner.processExists(target.pid);
		}
		return true;
	}

	private async removeTarget(key: string): Promise<void> {
		this.targets.delete(key);
		if (this.activeKey === key) {
			this.activeKey = this.selectableTargets()[0]?.key;
			await this.persistActiveKey();
		}
		this.updateStatusBar();
	}

	private async activateTarget(target: TargetRecord): Promise<void> {
		this.activeKey = target.key;
		await this.persistActiveKey();
		this.updateStatusBar();
		target.terminal.show(false);
	}

	private async pruneInactiveProcessTargets(): Promise<void> {
		const processTargets = [...this.targets.values()].filter(target => target.source === 'process' && target.pid);
		if (processTargets.length === 0) {
			return;
		}

		const livePids = await this.scanner.findExistingPids(processTargets.map(target => target.pid!));
		let changed = false;
		for (const target of processTargets) {
			if (target.pid && !livePids.has(target.pid)) {
				this.targets.delete(target.key);
				changed = true;
			}
		}

		if (!changed) {
			return;
		}

		if (this.activeKey && !this.targets.has(this.activeKey)) {
			this.activeKey = this.selectableTargets()[0]?.key;
			await this.persistActiveKey();
		}
		this.updateStatusBar();
	}

	private async refreshProcessTargets(): Promise<void> {
		if (getConfiguration().autoLinkActiveAgentTerminal) {
			for (const terminal of this.terminalsToInspect()) {
				await this.inspectTerminal(terminal);
			}
		}
		await this.pruneInactiveProcessTargets();
	}

	private terminalsToInspect(): vscode.Terminal[] {
		const terminals = new Set(this.terminalApi.terminals);
		if (this.terminalApi.activeTerminal) {
			terminals.add(this.terminalApi.activeTerminal);
		}
		return [...terminals];
	}

	private shouldAutoActivateTerminal(terminal: vscode.Terminal): boolean {
		return getConfiguration().autoLinkActiveAgentTerminal && this.terminalApi.activeTerminal === terminal;
	}

	private removeTerminal(terminal: vscode.Terminal): void {
		for (const [key, target] of this.targets) {
			if (target.terminal === terminal) {
				this.targets.delete(key);
			}
		}
		if (this.activeKey && !this.targets.has(this.activeKey)) {
			this.activeKey = this.selectableTargets()[0]?.key;
			void this.persistActiveKey();
		}
		this.updateStatusBar();
	}

	private selectableTargets(): TargetRecord[] {
		const targets = new Map<string, TargetRecord>();
		for (const target of this.targets.values()) {
			const key = this.selectableKeyFor(target);
			const existing = targets.get(key);
			if (!existing || this.isPreferredTarget(target, existing)) {
				targets.set(key, target);
			}
		}
		return [...targets.values()];
	}

	private selectableKeyFor(target: TargetRecord): string {
		return `${this.idForTerminal(target.terminal)}:${target.agent.id}`;
	}

	private sameSelectableTarget(first: TargetRecord, second: TargetRecord): boolean {
		return first.terminal === second.terminal && first.agent.id === second.agent.id;
	}

	private isPreferredTarget(candidate: TargetRecord, current: TargetRecord): boolean {
		const priorityDelta = this.targetPriority(candidate) - this.targetPriority(current);
		if (priorityDelta !== 0) {
			return priorityDelta > 0;
		}
		return candidate.key === this.activeKey && current.key !== this.activeKey;
	}

	private targetPriority(target: TargetRecord): number {
		if (target.tmuxPaneId) {
			return 4;
		}
		if (target.source === 'process') {
			return 3;
		}
		if (target.source === 'shellExecution') {
			return 2;
		}
		return 1;
	}

	private keyFor(terminal: vscode.Terminal, agentId: string, tmuxPaneId?: string, pid?: number): string {
		return `${this.idForTerminal(terminal)}:${agentId}:${tmuxPaneId ?? pid ?? 'terminal'}`;
	}

	private idForTerminal(terminal: vscode.Terminal): number {
		const existing = this.terminalIds.get(terminal);
		if (existing) {
			return existing;
		}
		const next = this.nextTerminalId++;
		this.terminalIds.set(terminal, next);
		return next;
	}

	private restoreActiveKey(): void {
		this.persistedActiveKey = this.context.workspaceState.get<string>('activeTargetKey');
		if (this.persistedActiveKey && this.targets.has(this.persistedActiveKey)) {
			this.activeKey = this.persistedActiveKey;
		}
	}

	private async persistActiveKey(): Promise<void> {
		await this.context.workspaceState.update('activeTargetKey', this.activeKey);
	}

	private updateStatusBar(): void {
		const target = this.activeTarget;
		if (target) {
			this.statusBarItem.text = `$(mention) ${target.agent.label}`;
			this.statusBarItem.tooltip = `At Mention Bridge target: ${target.agent.label} in "${target.terminal.name}"`;
		} else {
			this.statusBarItem.text = '$(mention) No Agent';
			this.statusBarItem.tooltip = 'At Mention Bridge: select an agent terminal';
		}
		this.statusBarItem.show();
	}
}
