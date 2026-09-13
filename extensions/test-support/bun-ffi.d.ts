declare module "bun:ffi" {
	export const FFIType: {
		readonly i32: number;
		readonly ptr: number;
		readonly u32: number;
		readonly u64: number;
	};

	export function ptr(buffer: ArrayBufferView): bigint;

	export function dlopen(
		path: string,
		symbols: Record<string, { args: readonly number[]; returns: number }>,
	): {
		symbols: Record<string, (...args: unknown[]) => number>;
		close(): void;
	};
}
