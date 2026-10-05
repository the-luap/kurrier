"use client";

import {
	type ComboboxItem,
	type OptionsFilter,
	TagsInput,
	type TagsInputProps,
} from "@mantine/core";
import type { ComposeContact } from "@schema";
import { useEffect, useRef, useState } from "react";
import ContactSuggestionItem from "@/components/mailbox/default/editor/contact-suggestion-item";
import { searchContactsForCompose } from "@/lib/actions/calendar";

export default function EmailHeaderContacts({
	name,
	toEmail,
	defaultValues,
	maxTags,
	onChange,
}: {
	toEmail?: string;
	/** Initial addresses (e.g. a restored draft); wins over toEmail. */
	defaultValues?: string[];
	maxTags?: number;
	onChange?: (value: string[]) => void;
	name: string;
}) {
	const [searchValue, setSearchValue] = useState("");
	const [options, setOptions] = useState<ComboboxItem[]>([]);

	const uniqueByEmail = (arr: ComposeContact[]) => {
		const seen = new Set<string>();

		return arr.filter((item) => {
			if (seen.has(item.email)) return false;

			seen.add(item.email);
			return true;
		});
	};

	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const requestIdRef = useRef(0);

	useEffect(
		() => () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		},
		[],
	);

	// Debounce the server lookup and drop out-of-order responses so fast
	// typing neither floods the server nor shows stale suggestions.
	const searchContacts = (value: string) => {
		setSearchValue(value);
		if (debounceRef.current) clearTimeout(debounceRef.current);

		if (!value.trim()) {
			requestIdRef.current++;
			setOptions([]);
			return;
		}

		debounceRef.current = setTimeout(async () => {
			const requestId = ++requestIdRef.current;
			try {
				const rowsContacts = await searchContactsForCompose(value);
				if (requestId !== requestIdRef.current) return;
				const rows = uniqueByEmail(rowsContacts);

				setOptions(
					rows.map((row) => ({
						value: row.email,
						label: `${row.name} <${row.email}>`,
						avatar: row.avatar,
					})),
				);
			} catch {
				if (requestId === requestIdRef.current) setOptions([]);
			}
		}, 200);
	};

	const renderOption: TagsInputProps["renderOption"] = ({ option }) => (
		<ContactSuggestionItem option={option} />
	);

	const filter: OptionsFilter = ({ options, search }) => {
		const value = search.toLowerCase();

		return (options as ComboboxItem[]).filter((option) =>
			option.label.toLowerCase().includes(value),
		);
	};

	return (
		<TagsInput
			defaultValue={defaultValues ?? (toEmail ? [toEmail] : [])}
			searchValue={searchValue}
			onSearchChange={searchContacts}
			data={options}
			onChange={(value) => {
				onChange?.(value as string[]);
			}}
			renderOption={renderOption}
			filter={filter}
			maxTags={maxTags}
			name={name}
			size="sm"
			variant="unstyled"
			className="min-h-7 w-full min-w-0 text-sm sm:w-96 sm:max-w-full"
			comboboxProps={{
				dropdownPadding: 0,
				withinPortal: false,
				position: "bottom-start",
				offset: 1,
				width: "target",
				shadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
				transitionProps: {
					transition: "skew-down",
					duration: 150,
				},
			}}
		/>
	);
}
