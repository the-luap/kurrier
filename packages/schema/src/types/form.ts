import { ReactNode } from "react";

export type SelectOption = { label: string; value: string };
export type SelectGroupOption = { group: string; items: SelectOption[] };

export type FieldKind = "input" | "textarea" | "select" | "custom";

export type FieldConfig = {
	kind?: FieldKind;
	name?: string;
	label?: ReactNode;
	labelSuffix?: ReactNode;
	wrapperClasses?: string;
	props?: any;
	component?: React.ComponentType<any>;
	options?: SelectOption[] | SelectGroupOption[];
	el?: ReactNode;
	prefix?: ReactNode;
	bottomStartPrefix?: ReactNode;
	bottomEndSuffix?: ReactNode;
};

export type BaseFormProps = {
	fields: FieldConfig[];
	action: any;
	onChange?: React.FormEventHandler<HTMLFormElement>;
	onSuccess?: (data: FormData | any) => void;
	formWrapperClasses?: string;
	errorClasses?: string;
	formKey?: string;
};

export type FormState<TData = unknown> = {
	success?: boolean;
	data?: TData;
	error?: string;
	errors?: Record<string, string[]>;
	message?: string;
};

/**
 * Database driver errors carry the SQL text and its parameters (row data,
 * ids, sometimes secrets); they are logged on the server and never returned
 * to the browser.
 */
function isDatabaseError(e: Error) {
	const cause = (e as { cause?: unknown }).cause as
		| { code?: unknown; severity?: unknown }
		| undefined;
	return (
		e.name === "DrizzleQueryError" ||
		e.name === "PostgresError" ||
		e.message.startsWith("Failed query:") ||
		(typeof cause?.code === "string" && typeof cause?.severity === "string")
	);
}

function toMessage(e: unknown): string {
	if (e instanceof Error) {
		if (isDatabaseError(e)) {
			console.error("[handleAction] database error", e);
			return "Something went wrong. Please try again.";
		}
		return e.message || "Unknown error";
	}
	if (typeof e === "string") return e;
	try {
		return JSON.stringify(e);
	} catch {
		return "Unknown error";
	}
}

/**
 * Next.js implements redirect()/notFound() by throwing. Those errors must
 * reach the framework instead of being turned into a form error.
 */
function isNextControlFlowError(e: unknown): boolean {
	if (!e || typeof e !== "object") return false;
	const digest = (e as { digest?: unknown }).digest;
	return (
		typeof digest === "string" &&
		(digest.startsWith("NEXT_REDIRECT") ||
			digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") ||
			digest === "NEXT_NOT_FOUND")
	);
}

export async function handleAction<T extends FormState<any>>(
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (isNextControlFlowError(e)) throw e;
		return {
			success: false,
			error: toMessage(e),
		} as T;
	}
}
