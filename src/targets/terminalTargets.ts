import * as vscode from 'vscode';
import { AGENTS, AgentDefinition, detectAgentFromCommand, detectAgentFromTerminalName, findAgentById } from '../core/agents';
import { getConfiguration } from '../core/configuration';
import { Logger } from '../core/logger';
import { ProcessScanner, sendTextToTmuxPane } from './processScanner';

export interface TargetRecord {
	readonly key: string;
	readonly terminal: vscode.Terminal;
	readonly agent: AgentDefinition;
	readonly pid?: number;
	readonly tmuxPaneId?: string;
	readonly source: 'manual' | 'shellExecution' | 'process';
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

export class TerminalTargetManager implements vscode.Disposable {
	private readonly targets = new Map<string, TargetRecord>();
	private readonly scanner = new ProcessScanner();
	private readonly terminalIds = new WeakMap<vscode.Terminal, number>();
	private readonly pruneInterval: ReturnType<typeof setInterval>;
	private activeKey: string | undefined;
	private persistedActiveKey: string | undefined;
	private nextTerminalId = 1;
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger,
		private readonly terminalApi: TerminalWindowApi = vscode.window,
	) {
		this.statusBarItem = this.terminalApi.createStatusBarItem('target', vscode.StatusBarAlignment.Right, 90);
		this.statusBarItem.command = 'vscode-at-mention-bridge.selectTarget';
		this.statusBarItem.name = 'At Mention Bridge Target';
		this.pruneInterval = setInterval(() => {
			void this.pruneInactiveProcessTargets();
		}, 3000);

		this.disposables.push(
			new vscode.Disposable(() => clearInterval(this.pruneInterval)),
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

	async linkActiveTerminal(agentId?: string): Promise<void> {
		const terminal = this.terminalApi.activeTerminal;
		if (!terminal) {
			vscode.window.showWarningMessage('Open or focus an integrated terminal before linking an agent.');
			return;
		}

		const agent = agentId ? findAgentById(agentId) : await this.pickAgentForTerminal(terminal);
		if (!agent) {
			return;
		}

		const processTarget = await this.addProcessTargetForAgent(terminal, agent);
		if (processTarget) {
			this.activeKey = processTarget.key;
		} else {
			this.addTarget(terminal, agent, 'manual');
			this.activeKey = this.keyFor(terminal, agent.id);
		}
		await this.persistActiveKey();
		this.updateStatusBar();
		vscode.window.showInformationMessage(`At Mention Bridge linked ${agent.label} in "${terminal.name}".`);
	}

	async selectTarget(): Promise<void> {
		const targets = this.selectableTargets();
		if (targets.length === 0) {
			const choice = await vscode.window.showWarningMessage(
				'No agent terminals have been discovered yet.',
				'Link Active Terminal',
			);
			if (choice === 'Link Active Terminal') {
				await this.linkActiveTerminal();
			}
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

		this.activeKey = selected.target.key;
		await this.persistActiveKey();
		this.updateStatusBar();
	}

	async nextTarget(): Promise<void> {
		const targets = this.selectableTargets();
		if (targets.length === 0) {
			await this.selectTarget();
			return;
		}

		const activeTarget = this.activeTarget;
		const currentIndex = targets.findIndex(target => target.key === activeTarget?.key);
		const next = targets[(currentIndex + 1) % targets.length];
		this.activeKey = next.key;
		await this.persistActiveKey();
		this.updateStatusBar();
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
				'Link Active Terminal',
			);
			if (choice === 'Select Target') {
				await this.selectTarget();
			} else if (choice === 'Link Active Terminal') {
				await this.linkActiveTerminal();
			}
			target = this.activeTarget;
		}

		if (!target) {
			return false;
		}

		if (!await this.isTargetActive(target)) {
			await this.removeTarget(target.key);
			vscode.window.showWarningMessage(`${target.agent.label} is no longer running in "${target.terminal.name}". Select or link an active agent terminal.`);
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

	private async pickAgentForTerminal(terminal: vscode.Terminal): Promise<AgentDefinition | undefined> {
		const detected = detectAgentFromTerminalName(terminal.name);
		const items = AGENTS.map(agent => ({
			label: agent.label,
			description: agent.id,
			picked: agent.id === detected?.id,
			agent,
		}));
		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: `Which agent is running in "${terminal.name}"?`,
		});
		return selected?.agent;
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
			if (target.terminal === event.terminal && target.agent.id === agent.id && target.source !== 'manual') {
				void this.removeTarget(target.key);
			}
		}
	}

	private async inspectTerminal(terminal: vscode.Terminal): Promise<void> {
		try {
			const processId = await terminal.processId;
			if (!processId) {
				return;
			}
			const matches = await this.scanner.findAgentProcesses(processId);
			for (const match of matches) {
				this.addTarget(terminal, match.agent, 'process', match.pid, match.tmuxPaneId);
				if (!this.activeKey) {
					this.activeKey = this.keyFor(terminal, match.agent.id, match.tmuxPaneId, match.pid);
					void this.persistActiveKey();
				}
			}
			this.updateStatusBar();
		} catch (error) {
			this.logger.warn('Unable to inspect terminal process tree', error);
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

	private async addProcessTargetForAgent(terminal: vscode.Terminal, agent: AgentDefinition): Promise<TargetRecord | undefined> {
		const processId = await terminal.processId;
		if (!processId) {
			return undefined;
		}

		const match = (await this.scanner.findAgentProcesses(processId)).find(candidate => candidate.agent.id === agent.id);
		if (!match) {
			return undefined;
		}

		this.addTarget(terminal, match.agent, 'process', match.pid, match.tmuxPaneId);
		return this.targets.get(this.keyFor(terminal, match.agent.id, match.tmuxPaneId, match.pid));
	}

	private async isTargetActive(target: TargetRecord): Promise<boolean> {
		if (target.source === 'manual') {
			return Boolean(await this.addProcessTargetForAgent(target.terminal, target.agent));
		}
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
