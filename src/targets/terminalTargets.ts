import * as vscode from 'vscode';
import { AgentDefinition, detectAgentFromCommand } from '../core/agents';
import { getConfiguration } from '../core/configuration';
import { Logger } from '../core/logger';
import { ProcessAgentMatch, ProcessScanner, revealTmuxPane, sendTextToTmuxPane, TmuxPaneTarget } from './processScanner';

export interface TargetRecord {
	readonly key: string;
	readonly terminal: vscode.Terminal;
	readonly agent: AgentDefinition;
	readonly pid?: number;
	readonly tmuxPaneId?: string;
	readonly tmuxPanePid?: number;
	readonly tmuxClient?: string;
	readonly tmuxSessionName?: string;
	readonly tmuxWindowId?: string;
	readonly tmuxWindowIndex?: string;
	readonly tmuxWindowName?: string;
	readonly tmuxPaneIndex?: string;
	readonly tmuxIsActivePane?: boolean;
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

interface TargetQuickPickItem extends vscode.QuickPickItem {
	readonly target: TargetRecord;
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
			label: `$(terminal) ${target.agent.label}`,
			description: this.targetDescription(target),
			detail: this.targetDetail(target, target.key === activeTarget?.key),
			target,
		}));
		const selected = await this.showTargetQuickPick(items, activeTarget);

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
		await this.revealTarget(target);
		if (target.tmuxPaneId) {
			await sendTextToTmuxPane(this.tmuxPaneTarget(target), textToInsert);
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

		const target = this.preferredTargetForActiveTerminal(terminal);
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
			this.removeSupersededShellTargets(terminal, matches);
			for (const match of matches) {
				this.addTarget(terminal, match.agent, 'process', match.pid, match);
				if (!this.activeKey || this.shouldAutoActivateMatch(terminal, match)) {
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

	private addTarget(
		terminal: vscode.Terminal,
		agent: AgentDefinition,
		source: TargetRecord['source'],
		pid?: number,
		match?: Pick<ProcessAgentMatch, 'tmuxPaneId' | 'tmuxPanePid' | 'tmuxClient' | 'tmuxSessionName' | 'tmuxWindowId' | 'tmuxWindowIndex' | 'tmuxWindowName' | 'tmuxPaneIndex' | 'tmuxIsActivePane'>,
	): void {
		const key = this.keyFor(terminal, agent.id, match?.tmuxPaneId, pid);
		const currentActiveTarget = this.activeKey ? this.targets.get(this.activeKey) : undefined;
		const target = {
			key,
			terminal,
			agent,
			pid,
			tmuxPaneId: match?.tmuxPaneId,
			tmuxPanePid: match?.tmuxPanePid,
			tmuxClient: match?.tmuxClient,
			tmuxSessionName: match?.tmuxSessionName,
			tmuxWindowId: match?.tmuxWindowId,
			tmuxWindowIndex: match?.tmuxWindowIndex,
			tmuxWindowName: match?.tmuxWindowName,
			tmuxPaneIndex: match?.tmuxPaneIndex,
			tmuxIsActivePane: match?.tmuxIsActivePane,
			source,
		};
		this.targets.set(key, target);
		if (!this.activeKey && key === this.persistedActiveKey) {
			this.activeKey = key;
		} else if (currentActiveTarget && this.sameSelectableTarget(currentActiveTarget, target) && this.isPreferredTarget(target, currentActiveTarget)) {
			this.activeKey = key;
			void this.persistActiveKey();
		}
		this.logger.info('Discovered agent terminal', agent.id, terminal.name);
	}

	private removeSupersededShellTargets(terminal: vscode.Terminal, matches: readonly ProcessAgentMatch[]): void {
		const tmuxAgentIds = new Set(matches.filter(match => match.tmuxPaneId).map(match => match.agent.id));
		if (tmuxAgentIds.size === 0) {
			return;
		}

		for (const [key, target] of this.targets) {
			if (target.terminal === terminal && target.source === 'shellExecution' && !target.tmuxPaneId && tmuxAgentIds.has(target.agent.id)) {
				this.targets.delete(key);
			}
		}
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
		await this.revealTarget(target);
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

	private shouldAutoActivateMatch(terminal: vscode.Terminal, match: ProcessAgentMatch): boolean {
		if (!this.shouldAutoActivateTerminal(terminal)) {
			return false;
		}
		if (match.tmuxPaneId) {
			return match.tmuxIsActivePane === true;
		}
		return true;
	}

	private preferredTargetForActiveTerminal(terminal: vscode.Terminal): TargetRecord | undefined {
		const targets = this.selectableTargets().filter(candidate => candidate.terminal === terminal);
		return targets.find(target => target.tmuxIsActivePane) ?? targets[0];
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
			if (this.isSupersededShellTarget(target)) {
				continue;
			}
			const key = this.selectableKeyFor(target);
			const existing = targets.get(key);
			if (!existing || this.isPreferredTarget(target, existing)) {
				targets.set(key, target);
			}
		}
		return [...targets.values()].sort((first, second) => this.compareTargets(first, second));
	}

	private isSupersededShellTarget(target: TargetRecord): boolean {
		if (target.source !== 'shellExecution' || target.tmuxPaneId) {
			return false;
		}
		for (const candidate of this.targets.values()) {
			if (candidate.terminal === target.terminal && candidate.agent.id === target.agent.id && candidate.tmuxPaneId) {
				return true;
			}
		}
		return false;
	}

	private showTargetQuickPick(items: readonly TargetQuickPickItem[], activeTarget: TargetRecord | undefined): Promise<TargetQuickPickItem | undefined> {
		return new Promise(resolve => {
			const quickPick = vscode.window.createQuickPick<TargetQuickPickItem>();
			let didResolve = false;
			const disposables: vscode.Disposable[] = [];
			const finish = (selected: TargetQuickPickItem | undefined) => {
				if (didResolve) {
					return;
				}
				didResolve = true;
				for (const disposable of disposables) {
					disposable.dispose();
				}
				quickPick.dispose();
				resolve(selected);
			};

			quickPick.placeholder = 'Select the terminal target for inserted @-mention references';
			quickPick.matchOnDescription = true;
			quickPick.matchOnDetail = true;
			quickPick.items = items;

			const currentItem = activeTarget ? items.find(item => item.target.key === activeTarget.key) : undefined;
			if (currentItem) {
				quickPick.activeItems = [currentItem];
			}

			disposables.push(
				quickPick.onDidAccept(() => finish(quickPick.selectedItems[0] ?? quickPick.activeItems[0])),
				quickPick.onDidHide(() => finish(undefined)),
			);
			quickPick.show();
		});
	}

	private compareTargets(first: TargetRecord, second: TargetRecord): number {
		if (first.tmuxPaneId && second.tmuxPaneId) {
			return this.compareTmuxTargets(first, second);
		}

		const firstPid = first.pid ?? Number.POSITIVE_INFINITY;
		const secondPid = second.pid ?? Number.POSITIVE_INFINITY;
		if (firstPid !== secondPid) {
			return firstPid - secondPid;
		}

		return this.targetSortLabel(first).localeCompare(this.targetSortLabel(second));
	}

	private compareTmuxTargets(first: TargetRecord, second: TargetRecord): number {
		const sessionDelta = (first.tmuxSessionName ?? '').localeCompare(second.tmuxSessionName ?? '');
		if (sessionDelta !== 0) {
			return sessionDelta;
		}

		const windowDelta = compareTmuxIndex(first.tmuxWindowIndex, second.tmuxWindowIndex);
		if (windowDelta !== 0) {
			return windowDelta;
		}

		const paneDelta = compareTmuxIndex(first.tmuxPaneIndex, second.tmuxPaneIndex);
		if (paneDelta !== 0) {
			return paneDelta;
		}

		return this.targetSortLabel(first).localeCompare(this.targetSortLabel(second));
	}

	private targetSortLabel(target: TargetRecord): string {
		return [
			target.agent.label,
			target.terminal.name,
			target.tmuxPaneId ?? '',
			target.key,
		].join('\u0000');
	}

	private selectableKeyFor(target: TargetRecord): string {
		return `${this.idForTerminal(target.terminal)}:${target.agent.id}:${target.tmuxPaneId ?? 'terminal'}`;
	}

	private sameSelectableTarget(first: TargetRecord, second: TargetRecord): boolean {
		return first.terminal === second.terminal
			&& first.agent.id === second.agent.id
			&& first.tmuxPaneId === second.tmuxPaneId;
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
			this.statusBarItem.text = `$(mention) ${this.statusBarTargetLabel(target)}`;
			this.statusBarItem.tooltip = this.targetTooltip(target);
		} else {
			this.statusBarItem.text = '$(mention) No Agent';
			this.statusBarItem.tooltip = 'At Mention Bridge: no terminal target selected. Click to select a discovered agent terminal.';
		}
		this.statusBarItem.show();
	}

	private statusBarTargetLabel(target: TargetRecord): string {
		return [
			target.agent.label,
			target.pid ? `PID ${target.pid}` : undefined,
		].filter(Boolean).join(' · ');
	}

	private targetDescription(target: TargetRecord): string {
		return [
			this.tmuxLocationLabel(target),
			`PID ${target.pid ?? 'unknown'}`,
		].filter(Boolean).join(' · ');
	}

	private targetDetail(target: TargetRecord, isCurrent: boolean): string {
		return [
			isCurrent ? 'Current target' : undefined,
			this.terminalApi.activeTerminal === target.terminal ? 'Active terminal' : undefined,
			`Terminal: ${target.terminal.name}`,
			target.tmuxWindowName ? `Window: ${target.tmuxWindowName}` : undefined,
			target.tmuxPaneId ? `Pane: ${target.tmuxPaneId}` : undefined,
		].filter(Boolean).join(' · ');
	}

	private targetTooltip(target: TargetRecord): string {
		return [
			`At Mention Bridge target: ${target.agent.label}`,
			`Terminal: ${target.terminal.name}`,
			this.tmuxLocationLabel(target) ? `tmux: ${this.tmuxLocationLabel(target)}` : undefined,
			target.tmuxPaneId ? `Pane: ${target.tmuxPaneId}` : undefined,
			target.pid ? `PID: ${target.pid}` : undefined,
			'Click to select another target.',
		].filter(Boolean).join('\n');
	}

	private async revealTarget(target: TargetRecord): Promise<void> {
		target.terminal.show(false);
		if (!target.tmuxPaneId) {
			return;
		}
		try {
			await revealTmuxPane(this.tmuxPaneTarget(target));
		} catch (error) {
			this.logger.warn('Unable to reveal tmux pane', error);
		}
	}

	private tmuxPaneTarget(target: TargetRecord): TmuxPaneTarget {
		return {
			tmuxPaneId: target.tmuxPaneId!,
			tmuxPanePid: target.tmuxPanePid,
			tmuxClient: target.tmuxClient,
			tmuxSessionName: target.tmuxSessionName,
			tmuxWindowId: target.tmuxWindowId,
			tmuxWindowIndex: target.tmuxWindowIndex,
			tmuxWindowName: target.tmuxWindowName,
			tmuxPaneIndex: target.tmuxPaneIndex,
			tmuxIsActivePane: target.tmuxIsActivePane,
		};
	}

	private tmuxLocationLabel(target: TargetRecord): string | undefined {
		if (!target.tmuxPaneId) {
			return undefined;
		}
		const session = target.tmuxSessionName ? `${target.tmuxSessionName}:` : '';
		const window = target.tmuxWindowIndex ?? target.tmuxWindowId;
		const pane = target.tmuxPaneIndex ?? target.tmuxPaneId;
		return `${session}${window ?? '?'}${pane ? `.${pane}` : ''}`;
	}
}

function compareTmuxIndex(first: string | undefined, second: string | undefined): number {
	const firstNumber = first === undefined ? Number.POSITIVE_INFINITY : Number(first);
	const secondNumber = second === undefined ? Number.POSITIVE_INFINITY : Number(second);
	if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber) && firstNumber !== secondNumber) {
		return firstNumber - secondNumber;
	}
	return (first ?? '').localeCompare(second ?? '');
}
