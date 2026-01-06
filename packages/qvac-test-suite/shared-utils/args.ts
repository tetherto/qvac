/**
 * CLI Argument Parsing Utilities
 */

export function getArgValue(argName: string): string | undefined {
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		if (args[i].startsWith(`--${argName}=`)) {
			return args[i].split('=')[1];
		}
		if (args[i] === `--${argName}` && args[i + 1] && !args[i + 1].startsWith('--')) {
			return args[i + 1];
		}
	}
	return undefined;
}

export function hasFlag(flagName: string): boolean | undefined {
	const args = process.argv.slice(2);
	for (const arg of args) {
		if (arg === `--${flagName}` || arg === `--${flagName}=true`) {
			return true;
		}
		if (arg === `--no-${flagName}` || arg === `--${flagName}=false`) {
			return false;
		}
	}
	return undefined;
}
