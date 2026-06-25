import { execFile } from 'child_process';
import { promisify } from 'util';
import { AgentDefinition, detectAgentFromCommand } from '../core/agents';

const execFileAsync = promisify(execFile);

export interface ProcessAgentMatch {
	readonly agent: AgentDefinition;
	readonly pid?: number;
	readonly commandLine: string;
	readonly tmuxPaneId?: string;
}

interface ProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly command: string;
	readonly commandLine: string;
}

export class ProcessScanner {
	async findAgentProcesses(rootPid: number): Promise<ProcessAgentMatch[]> {
		const rows = await listProcesses();
		const descendants = collectDescendants(rootPid, rows);
		const matches = new Map<string, ProcessAgentMatch>();

		for (const row of descendants) {
			const agent = detectAgentFromCommand(`${row.command} ${row.commandLine}`);
			if (agent) {
				matches.set(`${agent.id}:${row.pid}`, {
					agent,
					pid: row.pid,
					commandLine: row.commandLine || row.command,
				});
			}
		}

		if (descendants.some(row => /\btmux(?:\.exe)?\b/i.test(`${row.command} ${row.commandLine}`))) {
			for (const match of await listTmuxAgentPanes()) {
				matches.set(`${match.agent.id}:tmux:${match.tmuxPaneId}`, match);
			}
		}

		return [...matches.values()];
	}

	async processExists(pid: number): Promise<boolean> {
		const rows = await listProcesses();
		return rows.some(row => row.pid === pid);
	}

	async findExistingPids(pids: readonly number[]): Promise<Set<number>> {
		const wanted = new Set(pids);
		const rows = await listProcesses();
		return new Set(rows.filter(row => wanted.has(row.pid)).map(row => row.pid));
	}
}

export async function sendTextToTmuxPane(paneId: string, text: string): Promise<void> {
	await execFileAsync('tmux', ['select-pane', '-t', paneId]);
	await execFileAsync('tmux', ['send-keys', '-t', paneId, '-l', text]);
}

async function listProcesses(): Promise<ProcessRow[]> {
	if (process.platform === 'win32') {
		return listWindowsProcesses();
	}

	const args = process.platform === 'darwin'
		? ['-axo', 'pid=,ppid=,comm=,args=']
		: ['-eo', 'pid=,ppid=,comm=,args='];
	const { stdout } = await execFileAsync('ps', args, { maxBuffer: 1024 * 1024 * 5 });
	return stdout.split(/\r?\n/).flatMap(parseUnixProcessLine);
}

async function listWindowsProcesses(): Promise<ProcessRow[]> {
	const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
	const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { maxBuffer: 1024 * 1024 * 5 });
	const parsed = JSON.parse(stdout || '[]') as unknown;
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	return rows.flatMap(row => {
		if (!isWindowsProcessRow(row)) {
			return [];
		}
		return [{
			pid: row.ProcessId,
			ppid: row.ParentProcessId,
			command: row.Name ?? '',
			commandLine: row.CommandLine ?? row.Name ?? '',
		}];
	});
}

async function listTmuxAgentPanes(): Promise<ProcessAgentMatch[]> {
	try {
		const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}']);
		return stdout.split(/\r?\n/).flatMap(line => {
			const [paneId, panePid, paneCommand, paneTitle] = line.split('\t');
			if (!paneId || !paneCommand) {
				return [];
			}
			const commandLine = `${paneCommand} ${paneTitle ?? ''}`.trim();
			const agent = detectAgentFromCommand(commandLine);
			if (!agent) {
				return [];
			}
			return [{
				agent,
				pid: Number(panePid) || undefined,
				commandLine,
				tmuxPaneId: paneId,
			}];
		});
	} catch {
		return [];
	}
}

function collectDescendants(rootPid: number, rows: readonly ProcessRow[]): ProcessRow[] {
	const childrenByParent = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const existing = childrenByParent.get(row.ppid) ?? [];
		existing.push(row);
		childrenByParent.set(row.ppid, existing);
	}

	const descendants: ProcessRow[] = [];
	const queue = [...(childrenByParent.get(rootPid) ?? [])];
	while (queue.length > 0) {
		const row = queue.shift();
		if (!row) {
			continue;
		}
		descendants.push(row);
		queue.push(...(childrenByParent.get(row.pid) ?? []));
	}
	return descendants;
}

function parseUnixProcessLine(line: string): ProcessRow[] {
	const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
	if (!match) {
		return [];
	}
	return [{
		pid: Number(match[1]),
		ppid: Number(match[2]),
		command: match[3],
		commandLine: match[4] ?? '',
	}];
}

function isWindowsProcessRow(row: unknown): row is {
	ProcessId: number;
	ParentProcessId: number;
	Name?: string;
	CommandLine?: string;
} {
	return typeof row === 'object'
		&& row !== null
		&& typeof (row as { ProcessId?: unknown }).ProcessId === 'number'
		&& typeof (row as { ParentProcessId?: unknown }).ParentProcessId === 'number';
}
