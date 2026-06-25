export type AgentId =
	| 'claude'
	| 'codex'
	| 'gemini'
	| 'opencode'
	| 'aider'
	| 'copilot'
	| 'goose'
	| 'crush'
	| 'amp'
	| 'qwen'
	| 'kimi'
	| 'codebuddy'
	| 'kilo'
	| 'qodercli'
	| 'trae-cli'
	| 'agy';

export interface AgentDefinition {
	readonly id: AgentId;
	readonly label: string;
	readonly executables: readonly string[];
}

export const AGENTS: readonly AgentDefinition[] = [
	{ id: 'claude', label: 'Claude Code', executables: ['claude', 'claude.exe', 'claude.cmd'] },
	{ id: 'codex', label: 'OpenAI Codex CLI', executables: ['codex', 'codex.exe', 'codex.cmd'] },
	{ id: 'gemini', label: 'Gemini CLI', executables: ['gemini', 'gemini.exe', 'gemini.cmd'] },
	{ id: 'opencode', label: 'OpenCode', executables: ['opencode', 'opencode.exe', 'opencode.cmd'] },
	{ id: 'aider', label: 'Aider', executables: ['aider', 'aider.exe', 'aider.cmd'] },
	{ id: 'copilot', label: 'GitHub Copilot CLI', executables: ['copilot', 'copilot.exe', 'copilot.cmd'] },
	{ id: 'goose', label: 'Goose', executables: ['goose', 'goose.exe', 'goose.cmd'] },
	{ id: 'crush', label: 'Crush', executables: ['crush', 'crush.exe', 'crush.cmd'] },
	{ id: 'amp', label: 'Amp', executables: ['amp', 'amp.exe', 'amp.cmd'] },
	{ id: 'qwen', label: 'Qwen Code', executables: ['qwen', 'qwen.exe', 'qwen.cmd'] },
	{ id: 'kimi', label: 'Kimi Code CLI', executables: ['kimi', 'kimi.cmd', 'kimi.exe'] },
	{ id: 'codebuddy', label: 'CodeBuddy Code', executables: ['codebuddy', 'codebuddy.exe', 'codebuddy.cmd'] },
	{ id: 'kilo', label: 'Kilo Code CLI', executables: ['kilo', 'kilo.exe', 'kilo.cmd'] },
	{ id: 'qodercli', label: 'Qoder CLI', executables: ['qodercli', 'qodercli.exe', 'qodercli.cmd'] },
	{ id: 'trae-cli', label: 'Trae Agent', executables: ['trae-cli', 'trae-cli.exe', 'trae-cli.cmd'] },
	{ id: 'agy', label: 'Antigravity', executables: ['agy', 'agy.exe', 'agy.cmd'] },
];

export function findAgentById(id: string | undefined): AgentDefinition | undefined {
	return AGENTS.find(agent => agent.id === id);
}

export function detectAgentFromCommand(commandLine: string): AgentDefinition | undefined {
	const tokens = commandLine.split(/[\s"'`]+/).filter(Boolean);
	return AGENTS.find(agent => agent.executables.some(executable => tokens.some(token => executableMatchesToken(executable, token))));
}

export function detectAgentFromTerminalName(name: string): AgentDefinition | undefined {
	const normalizedName = name.toLowerCase();
	return AGENTS.find(agent => agent.executables.some(executable => normalizedName.includes(executable.toLowerCase())));
}

function executableMatchesToken(executable: string, token: string): boolean {
	const normalizedToken = token.toLowerCase().replace(/\\/g, '/');
	const basename = normalizedToken.split('/').pop() ?? normalizedToken;
	return basename === executable.toLowerCase();
}
