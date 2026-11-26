// A21.3-6 (#pi-21.3): the CLI route is deleted, so no start of the fake `agy` may carry `--print` (or `--version`, or anything else). The fake logs the argument list of every start as a row `{ args }`.
// The provider starts it only as `agy acp [--sandbox]` and, for the catalogue, `agy models`.
const SUBCOMMANDS = new Set(["acp", "models"]);

/** The argument lists in a fake's log that the ACP route never uses: any `--print`, or a first argument that is neither `acp` nor `models`. */
export function cliLaunches(rows: Array<{ args?: unknown; [other: string]: unknown }>): string[][] {
	return rows.flatMap(row => {
		if (!Array.isArray(row.args)) return [];
		const args = row.args.map(String);
		return args.some(a => a === "--print" || a.startsWith("--print=")) || !SUBCOMMANDS.has(args[0] ?? "") ? [args] : [];
	});
}
