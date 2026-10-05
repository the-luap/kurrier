"use client";

import { useOptionalDictionary } from "@/components/providers/dictionary-provider";
import enAi from "@/lib/dictionaries/en/ai.json";

export type AiDict = typeof enAi;

/** The "ai" dictionary namespace, falling back to English outside a provider. */
export function useAiDict(): AiDict {
	const dict = useOptionalDictionary();
	return (dict?.ai as AiDict | undefined) ?? enAi;
}

export const fillAi = (
	template: string,
	vars: Record<string, string | number>,
) =>
	template.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in vars ? String(vars[key]) : match,
	);

/** Translate an error code returned by the AI server actions. */
export const aiErrorText = (
	dict: AiDict,
	code: string | undefined,
	provider?: string,
) => {
	const errors = dict.errors as Record<string, string>;
	const template =
		(code && Object.hasOwn(errors, code) ? errors[code] : undefined) ??
		errors.generic;
	return fillAi(template, { provider: provider || "AI" });
};

export const aiProviderName = (provider: string) =>
	provider === "lmstudio" ? "LM Studio" : "Ollama";
